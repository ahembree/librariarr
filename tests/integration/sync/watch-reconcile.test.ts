import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  loadWatchCountsFromHistory,
  reconcileWatchStateFromHistory,
} from "@/lib/sync/watch-reconcile";

const prisma = getTestPrisma();

const DAY = 24 * 60 * 60 * 1000;
// Anchored to a fixed instant so repeated `daysAgo(n)` calls in one test are
// byte-identical (a `Date.now()`-based helper drifts by milliseconds between
// the write and the assertion). Postgres `timestamp` keeps microseconds, so
// the millisecond-truncated JS value round-trips exactly.
const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * DAY);

async function addPlay(
  mediaItemId: string,
  mediaServerId: string,
  username: string,
  watchedAt: Date | null,
) {
  await prisma.watchHistory.create({
    data: { mediaItemId, mediaServerId, serverUsername: username, watchedAt },
  });
}

let tracearrEventSeq = 0;

/**
 * A Tracearr-sourced play. `watched` is the field under test: false means the
 * chain never crossed Tracearr's completion threshold (an abandoned or
 * still-running play), which must be stored but must not count. `sourceEventId`
 * is unique per row because `WatchHistory` carries `@@unique([mediaServerId,
 * sourceEventId])`.
 */
async function addTracearrPlay(
  mediaItemId: string,
  mediaServerId: string,
  username: string,
  watchedAt: Date | null,
  watched: boolean,
  percentComplete?: number,
) {
  await prisma.watchHistory.create({
    data: {
      mediaItemId,
      mediaServerId,
      serverUsername: username,
      watchedAt,
      source: "TRACEARR",
      sourceEventId: `tracearr-event-${++tracearrEventSeq}`,
      watched,
      percentComplete: percentComplete ?? (watched ? 97.5 : 4.2),
      state: watched ? "stopped" : "playing",
      segmentCount: 1,
    },
  });
}

async function setup() {
  const user = await createTestUser();
  const server = await createTestServer(user.id, { name: "Plex" });
  const library = await createTestLibrary(server.id, { type: "SERIES" });
  return { user, server, library };
}

describe("watch-reconcile", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("reconcileWatchStateFromHistory", () => {
    it("moves lastPlayedAt forward when another user's play is newer than the admin's", async () => {
      const { server, library } = await setup();
      // The admin's own metadata says "watched 2 years ago" — that is what the
      // item sync writes, because Plex viewCount/lastViewedAt is per-account.
      const episode = await createTestMediaItem(library.id, {
        type: "SERIES",
        parentTitle: "The Show",
        seasonNumber: 1,
        episodeNumber: 1,
        playCount: 1,
        lastPlayedAt: daysAgo(730),
      });
      // …but the server-wide history has a play from a household member 60 days ago.
      await addPlay(episode.id, server.id, "roommate", daysAgo(60));

      const updated = await reconcileWatchStateFromHistory(server.id);
      expect(updated).toBe(1);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: episode.id } });
      expect(after.lastPlayedAt?.getTime()).toBe(daysAgo(60).getTime());
      // Two known plays: the admin's (counted in playCount) is not in the
      // server's retained history, so the greater of the two wins.
      expect(after.playCount).toBe(1);
    });

    it("raises playCount to the number of history rows when history knows more plays", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { playCount: 1, lastPlayedAt: daysAgo(400) });
      await addPlay(item.id, server.id, "admin", daysAgo(400));
      await addPlay(item.id, server.id, "roommate", daysAgo(30));
      await addPlay(item.id, server.id, "kid", daysAgo(10));

      await reconcileWatchStateFromHistory(server.id);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.playCount).toBe(3);
      expect(after.lastPlayedAt?.getTime()).toBe(daysAgo(10).getTime());
    });

    it("populates lastPlayedAt when the item has never been played by the admin", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { playCount: 0 });
      expect(item.lastPlayedAt).toBeNull();
      await addPlay(item.id, server.id, "roommate", daysAgo(5));

      await reconcileWatchStateFromHistory(server.id);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.lastPlayedAt?.getTime()).toBe(daysAgo(5).getTime());
      expect(after.playCount).toBe(1);
    });

    it("never moves lastPlayedAt or playCount backwards", async () => {
      const { server, library } = await setup();
      const recent = daysAgo(2);
      const item = await createTestMediaItem(library.id, { playCount: 9, lastPlayedAt: recent });
      // Pruned history: one old play only.
      await addPlay(item.id, server.id, "roommate", daysAgo(500));

      const updated = await reconcileWatchStateFromHistory(server.id);
      expect(updated).toBe(0);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.lastPlayedAt?.getTime()).toBe(recent.getTime());
      expect(after.playCount).toBe(9);
    });

    it("tolerates history rows with a null watchedAt", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { playCount: 0 });
      await addPlay(item.id, server.id, "roommate", null);

      await reconcileWatchStateFromHistory(server.id);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
      // The play is counted, but there is no date to move lastPlayedAt to.
      expect(after.playCount).toBe(1);
      expect(after.lastPlayedAt).toBeNull();
    });

    it("only touches the given server's items", async () => {
      const { user, server, library } = await setup();
      const otherServer = await createTestServer(user.id, { name: "Other" });
      const otherLibrary = await createTestLibrary(otherServer.id, { type: "SERIES" });

      const mine = await createTestMediaItem(library.id, { playCount: 0 });
      const theirs = await createTestMediaItem(otherLibrary.id, { playCount: 0 });
      await addPlay(mine.id, server.id, "roommate", daysAgo(3));
      await addPlay(theirs.id, otherServer.id, "roommate", daysAgo(3));

      const updated = await reconcileWatchStateFromHistory(server.id);
      expect(updated).toBe(1);

      const untouched = await prisma.mediaItem.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(untouched.lastPlayedAt).toBeNull();
    });
  });

  describe("loadWatchCountsFromHistory", () => {
    it("returns per-ratingKey counts and the max watchedAt in epoch seconds", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { ratingKey: "rk-1" });
      const newest = daysAgo(7);
      await addPlay(item.id, server.id, "admin", daysAgo(300));
      await addPlay(item.id, server.id, "roommate", newest);

      const counts = await loadWatchCountsFromHistory(server.id, ["rk-1"]);

      expect(counts.get("rk-1")).toEqual({
        count: 2,
        lastWatchedAt: Math.floor(newest.getTime() / 1000),
      });
    });

    it("omits ratingKeys with no stored history and returns empty for no keys", async () => {
      const { server, library } = await setup();
      await createTestMediaItem(library.id, { ratingKey: "rk-unplayed" });

      expect(await loadWatchCountsFromHistory(server.id, ["rk-unplayed"])).toEqual(new Map());
      expect(await loadWatchCountsFromHistory(server.id, [])).toEqual(new Map());
    });

    it("reports lastWatchedAt 0 when every stored play has a null watchedAt", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { ratingKey: "rk-null" });
      await addPlay(item.id, server.id, "roommate", null);

      expect(await loadWatchCountsFromHistory(server.id, ["rk-null"])).toEqual(
        new Map([["rk-null", { count: 1, lastWatchedAt: 0 }]]),
      );
    });

    it("excludes partial Tracearr plays from the count and the max watchedAt", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { ratingKey: "rk-mixed" });
      const completed = daysAgo(20);
      await addPlay(item.id, server.id, "admin", daysAgo(400));
      await addTracearrPlay(item.id, server.id, "roommate", completed, true);
      // Newer than the completed play, so a regression would show up in both
      // the count AND lastWatchedAt.
      await addTracearrPlay(item.id, server.id, "kid", daysAgo(1), false);

      const counts = await loadWatchCountsFromHistory(server.id, ["rk-mixed"]);

      expect(counts.get("rk-mixed")).toEqual({
        count: 2,
        lastWatchedAt: Math.floor(completed.getTime() / 1000),
      });
    });

    it("omits a ratingKey whose only plays are partial Tracearr rows", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { ratingKey: "rk-partial" });
      await addTracearrPlay(item.id, server.id, "kid", daysAgo(1), false);

      // No qualifying row means no GROUP BY group at all — the incremental sync
      // then leaves buildItemData's metadata-derived value alone.
      expect(await loadWatchCountsFromHistory(server.id, ["rk-partial"])).toEqual(new Map());
    });

    it("does not leak another server's plays for the same ratingKey", async () => {
      const { user, server, library } = await setup();
      const otherServer = await createTestServer(user.id, { name: "Other" });
      const otherLibrary = await createTestLibrary(otherServer.id, { type: "SERIES" });
      const mine = await createTestMediaItem(library.id, { ratingKey: "shared-rk" });
      const theirs = await createTestMediaItem(otherLibrary.id, { ratingKey: "shared-rk" });

      await addPlay(mine.id, server.id, "admin", daysAgo(100));
      await addPlay(theirs.id, otherServer.id, "roommate", daysAgo(1));
      await addPlay(theirs.id, otherServer.id, "kid", daysAgo(2));

      const counts = await loadWatchCountsFromHistory(server.id, ["shared-rk"]);
      expect(counts.get("shared-rk")?.count).toBe(1);
      expect(counts.get("shared-rk")?.lastWatchedAt).toBe(
        Math.floor(daysAgo(100).getTime() / 1000),
      );
    });
  });

  // The correctness lynchpin of the Tracearr integration. A Tracearr history
  // record is an aggregate over a resume chain, so it exists from the moment
  // playback starts: `watched = false` means "not (yet) a play". Both aggregates
  // must count only `watched IS DISTINCT FROM false`, or a 4%-watched abandoned
  // play inflates playCount and — because the writes are monotonic GREATEST —
  // pins lastPlayedAt to "just now" permanently.
  describe("watched semantics (native vs Tracearr partial plays)", () => {
    it("counts a native row (watched null) and sets lastPlayedAt, exactly as before", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { playCount: 0 });
      await addPlay(item.id, server.id, "roommate", daysAgo(9));

      expect(await reconcileWatchStateFromHistory(server.id)).toBe(1);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.playCount).toBe(1);
      expect(after.lastPlayedAt?.getTime()).toBe(daysAgo(9).getTime());
    });

    it("counts a Tracearr row with watched=true", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { playCount: 0 });
      await addTracearrPlay(item.id, server.id, "roommate", daysAgo(9), true);

      expect(await reconcileWatchStateFromHistory(server.id)).toBe(1);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.playCount).toBe(1);
      expect(after.lastPlayedAt?.getTime()).toBe(daysAgo(9).getTime());
    });

    it("stores a Tracearr row with watched=false but never counts it or advances lastPlayedAt", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { playCount: 0 });
      const completed = daysAgo(30);
      await addTracearrPlay(item.id, server.id, "roommate", completed, true);
      // Deliberately NEWER than the completed play: if the predicate regressed,
      // lastPlayedAt would visibly jump to yesterday.
      await addTracearrPlay(item.id, server.id, "kid", daysAgo(1), false, 4);

      await reconcileWatchStateFromHistory(server.id);

      // The partial play is still persisted — the History page shows it.
      expect(await prisma.watchHistory.count({ where: { mediaItemId: item.id } })).toBe(2);
      const stored = await prisma.watchHistory.findFirstOrThrow({
        where: { mediaItemId: item.id, watched: false },
      });
      expect(stored.source).toBe("TRACEARR");
      expect(stored.percentComplete).toBe(4);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.playCount).toBe(1);
      expect(after.lastPlayedAt?.getTime()).toBe(completed.getTime());
    });

    it("leaves an item untouched when every Tracearr row is a partial play", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, { playCount: 0 });
      await addTracearrPlay(item.id, server.id, "kid", daysAgo(1), false);
      await addTracearrPlay(item.id, server.id, "kid", daysAgo(2), false);

      // Nothing qualifies, so the subquery yields no group and no row is updated.
      expect(await reconcileWatchStateFromHistory(server.id)).toBe(0);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.playCount).toBe(0);
      expect(after.lastPlayedAt).toBeNull();
    });

    it("counts a mix of 2 native + 1 completed + 3 partial Tracearr plays as 3, through both helpers", async () => {
      const { server, library } = await setup();
      const item = await createTestMediaItem(library.id, {
        ratingKey: "rk-provenance-mix",
        playCount: 0,
      });
      const newestCompleted = daysAgo(15);
      await addPlay(item.id, server.id, "admin", daysAgo(90));
      await addPlay(item.id, server.id, "roommate", daysAgo(45));
      await addTracearrPlay(item.id, server.id, "kid", newestCompleted, true);
      await addTracearrPlay(item.id, server.id, "kid", daysAgo(3), false);
      await addTracearrPlay(item.id, server.id, "guest", daysAgo(2), false);
      await addTracearrPlay(item.id, server.id, "guest", daysAgo(1), false);

      await reconcileWatchStateFromHistory(server.id);

      const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.playCount).toBe(3);
      expect(after.lastPlayedAt?.getTime()).toBe(newestCompleted.getTime());

      // The incremental sync's path over the same rows must agree — it feeds
      // buildItemData, which maxes into these very columns.
      expect(await loadWatchCountsFromHistory(server.id, ["rk-provenance-mix"])).toEqual(
        new Map([
          [
            "rk-provenance-mix",
            { count: 3, lastWatchedAt: Math.floor(newestCompleted.getTime() / 1000) },
          ],
        ]),
      );
    });
  });
});
