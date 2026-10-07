import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
} from "../../setup/test-helpers";
import { FakeTracearrArchive, TRACEARR_SERVER_ID, play } from "./fake-tracearr-archive";

/**
 * A Tracearr-mapped Jellyfin/Emby server whose item two libraries list (two
 * libraries over one folder: one item, one id, two rows), end to end against
 * real Postgres and a fake Tracearr keyset.
 *
 * Skipped as "ambiguous", a play of such an item reached neither copy: both
 * read as never watched, and once the archive walk completed the evidence
 * marker vouched for that — negative `watchedByUser` and `playCount = 0` DELETE
 * rules then match items that were watched. The native path files such a play
 * against every copy; the Tracearr import now does too, on that exact shape
 * only: one row per copy, every row but the primary's naming it through
 * `fanOutOfItemId`, so lists of plays show the play once.
 */

const m = vi.hoisted(() => ({
  getHistoryPage: vi.fn(),
  getHistoryForItem: vi.fn(),
  listServers: vi.fn(),
  getServerAccountNames: vi.fn(),
  findOldestPlayAt: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/cache/memory-cache", () => {
  const noopCache = {
    get: () => undefined,
    set: () => {},
    getOrSet: async (_key: string, compute: () => Promise<unknown>) => compute(),
    invalidate: () => {},
    invalidatePrefix: () => {},
    clear: () => {},
  };
  return { MemoryCache: vi.fn(() => noopCache), appCache: noopCache };
});

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getHistoryPage = m.getHistoryPage;
    this.getHistoryForItem = m.getHistoryForItem;
    this.listServers = m.listServers;
    this.getServerAccountNames = m.getServerAccountNames;
    this.findOldestPlayAt = m.findOldestPlayAt;
  },
}));

import { logger } from "@/lib/logger";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { recoverHistoryForNewItems, resetRecoveryAnswers } from "@/lib/sync/tracearr-backfill-additions";
import { GET as listHistory } from "@/app/api/media/history/route";
import { GET as listSeriesHistory } from "@/app/api/media/series/watch-history/route";
import { GET as importStatus } from "@/app/api/integrations/tracearr/status/route";

const prisma = getTestPrisma();
const DAY = 24 * 60 * 60 * 1000;
// One base for the whole file: a play's time and the expectation built from
// it must be the same instant, not two reads of the clock apart.
const NOW = Date.now();
const at = (offset: number) => new Date(NOW + offset);

let archive: FakeTracearrArchive;
let userId: string;

async function mappedServer(type: "JELLYFIN" | "EMBY" | "PLEX") {
  const server = await createTestServer(userId, { type, tracearrServerId: TRACEARR_SERVER_ID });
  return server.id;
}

/** A movie row with a chosen id, so which copy is "lowest" is known. */
async function movie(libraryId: string, id: string, ratingKey: string) {
  const item = await createTestMediaItem(libraryId, { ratingKey, type: "MOVIE", title: "Shared Film" });
  return prisma.mediaItem.update({ where: { id: item.id }, data: { id } });
}

async function rowsOf(serverId: string) {
  return prisma.watchHistory.findMany({
    where: { mediaServerId: serverId },
    select: {
      mediaItemId: true,
      sourceEventId: true,
      fanOutOfItemId: true,
      watched: true,
      percentComplete: true,
    },
    orderBy: { mediaItemId: "asc" },
  });
}

describe("Tracearr plays of an item two Jellyfin/Emby libraries list (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    resetRecoveryAnswers();
    vi.clearAllMocks();
    // Reset, not just cleared: a once-implementation a failed test never
    // consumed must not leak into the next one.
    for (const fn of Object.values(m)) fn.mockReset();
    archive = new FakeTracearrArchive();
    m.getHistoryPage.mockImplementation(async (id: string, options: object) => archive.page(id, options));
    m.findOldestPlayAt.mockImplementation(async (id: string) => archive.oldest(id));
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    m.getHistoryForItem.mockImplementation(async (id: string, filter: { ratingKey?: string }) =>
      filter.ratingKey
        ? archive.page(id, { pageSize: 1000 }).records.filter((record) => record.rating_key === filter.ratingKey)
        : [],
    );
    const user = await createTestUser();
    userId = user.id;
    await prisma.tracearrInstance.create({
      data: { userId, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
    setMockSession({ userId, plexToken: "tok", isLoggedIn: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  for (const type of ["JELLYFIN", "EMBY"] as const) {
    it(`files the play against both copies on ${type}, and lists and counts it once`, async () => {
      const serverId = await mappedServer(type);
      const moviesA = await createTestLibrary(serverId, { type: "MOVIE", title: "Movies" });
      const moviesB = await createTestLibrary(serverId, { type: "MOVIE", title: "Movies (4K shelf)" });
      await movie(moviesA.id, "item-b", "jf-1");
      await movie(moviesB.id, "item-c", "jf-1");
      archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1" }));
      // A native row left from before the mapping: replaced by the import,
      // copies and all, as on any other server.
      await prisma.watchHistory.create({
        data: { mediaItemId: "item-c", mediaServerId: serverId, serverUsername: "walter", watchedAt: at(-9 * DAY) },
      });

      const result = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(result).toMatchObject({ count: 1, backfillPending: false });
      expect(await rowsOf(serverId)).toEqual([
        { mediaItemId: "item-b", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: null },
        {
          mediaItemId: "item-c",
          sourceEventId: "chain-1:copy:item-c",
          fanOutOfItemId: "item-b",
          watched: true,
          percentComplete: null,
        },
      ]);
      // Both copies read as watched to the rules.
      for (const id of ["item-b", "item-c"]) {
        expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).toMatchObject({
          playCount: 1,
          lastPlayedAt: at(-2 * DAY),
        });
      }

      const history = await expectJson<{ items: unknown[]; pagination: { totalCount: number } }>(
        await callRoute(listHistory, { url: "/api/media/history" }),
        200,
      );
      expect(history.items).toHaveLength(1);
      expect(history.pagination.totalCount).toBe(1);

      const status = await expectJson<{
        servers: Array<{ importedCount: number; oldestImported: string; newestImported: string }>;
      }>(await callRoute(importStatus, { url: "/api/integrations/tracearr/status" }), 200);
      expect(status.servers[0]).toMatchObject({
        importedCount: 1,
        oldestImported: at(-2 * DAY).toISOString(),
        newestImported: at(-2 * DAY).toISOString(),
      });
    });
  }

  it("lists an episode's play once on the series route", async () => {
    const serverId = await mappedServer("JELLYFIN");
    const tvA = await createTestLibrary(serverId, { type: "SERIES", title: "TV" });
    const tvB = await createTestLibrary(serverId, { type: "SERIES", title: "Kids TV" });
    for (const library of [tvA, tvB]) {
      const episode = await createTestMediaItem(library.id, {
        ratingKey: "ep-1",
        type: "SERIES",
        title: "Pilot",
        parentTitle: "The Show",
        seriesKey: "tvdb:1",
        seasonNumber: 1,
        episodeNumber: 1,
      });
      await prisma.mediaItem.update({ where: { id: episode.id }, data: { grandparentRatingKey: "show-1" } });
    }
    archive.add(
      play("chain-ep", at(-DAY), {
        media_type: "episode",
        rating_key: "ep-1",
        grandparent_rating_key: "show-1",
        season_number: 1,
        episode_number: 1,
      }),
    );

    await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId } })).toBe(2);
    const plays = await expectJson<{ items: unknown[]; pagination: { totalCount: number } }>(
      await callRoute(listSeriesHistory, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: "tvdb:1" },
      }),
      200,
    );
    expect(plays.items).toHaveLength(1);
    expect(plays.pagination.totalCount).toBe(1);
  });

  it("merges a resumed chain re-delivered into both rows, without adding any", async () => {
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    await movie(moviesB.id, "item-c", "jf-1");
    archive.add(
      play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: false, percent_complete: 40, state: "stopped" }),
    );
    await syncTracearrHistory(serverId, { passes: "backfill" });

    // Resumed and finished: the same chain, delivered again by the catch-up.
    archive = new FakeTracearrArchive();
    archive.add(
      play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95, segment_count: 2 }),
    );
    const again = await syncTracearrHistory(serverId, { passes: "forward" });

    expect(again.count).toBe(1);
    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-b", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
      {
        mediaItemId: "item-c",
        sourceEventId: "chain-1:copy:item-c",
        fanOutOfItemId: "item-b",
        watched: true,
        percentComplete: 95,
      },
    ]);
  });

  it("keeps one row on the survivor when the primary's item goes, carrying what it had accumulated", async () => {
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    await movie(moviesB.id, "item-c", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    // The primary's copy leaves the library: its row goes with it, and the
    // other copy's row stops pointing at it.
    await prisma.mediaItem.delete({ where: { id: "item-b" } });
    expect(await rowsOf(serverId)).toEqual([
      {
        mediaItemId: "item-c",
        sourceEventId: "chain-1:copy:item-c",
        fanOutOfItemId: null,
        watched: true,
        percentComplete: 95,
      },
    ]);

    // Re-delivered with a window-truncated view of the chain.
    archive = new FakeTracearrArchive();
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: false, percent_complete: 12 }));
    await syncTracearrHistory(serverId, { passes: "forward" });

    // One row for the play — the copy's, promoted — still finished.
    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-c", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
    ]);
  });

  it("moves the primary row to a lower-id copy added later, leaving one row per copy", async () => {
    const serverId = await mappedServer("EMBY");
    const libraries = await Promise.all(
      ["A", "B", "C"].map((title) => createTestLibrary(serverId, { type: "MOVIE", title })),
    );
    await movie(libraries[0].id, "item-b", "jf-1");
    await movie(libraries[1].id, "item-c", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1" }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    // A third library over the same folder lists it under a lower id.
    await movie(libraries[2].id, "item-a", "jf-1");
    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-a", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: null },
      {
        mediaItemId: "item-b",
        sourceEventId: "chain-1:copy:item-b",
        fanOutOfItemId: "item-a",
        watched: true,
        percentComplete: null,
      },
      {
        mediaItemId: "item-c",
        sourceEventId: "chain-1:copy:item-c",
        fanOutOfItemId: "item-a",
        watched: true,
        percentComplete: null,
      },
    ]);
  });

  // A chain re-delivered by the catch-up can be a window-truncated view of a
  // play that was finished (only the in-window segment): a row built from that
  // would read 12% and unwatched. Whichever copy's row is new, it carries what
  // the play has accumulated.
  const truncated = () =>
    play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: false, percent_complete: 12 });
  const finished = { watched: true, percentComplete: 95 };

  it("gives a copy listed later the play's accumulated state, not a truncated re-delivery's", async () => {
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    await movie(moviesB.id, "item-c", "jf-1");
    archive = new FakeTracearrArchive();
    archive.add(truncated());
    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-b", sourceEventId: "chain-1", fanOutOfItemId: null, ...finished },
      { mediaItemId: "item-c", sourceEventId: "chain-1:copy:item-c", fanOutOfItemId: "item-b", ...finished },
    ]);
  });

  it("keeps the play's state on the old primary when a lower-id copy takes the primary row", async () => {
    const serverId = await mappedServer("EMBY");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    await movie(moviesB.id, "item-a", "jf-1");
    archive = new FakeTracearrArchive();
    archive.add(truncated());
    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-a", sourceEventId: "chain-1", fanOutOfItemId: null, ...finished },
      { mediaItemId: "item-b", sourceEventId: "chain-1:copy:item-b", fanOutOfItemId: "item-a", ...finished },
    ]);
  });

  it("promotes a surviving copy's row when the primary goes and a lower-id copy arrives", async () => {
    const serverId = await mappedServer("JELLYFIN");
    const libraries = await Promise.all(
      ["A", "B", "C", "D"].map((title) => createTestLibrary(serverId, { type: "MOVIE", title })),
    );
    await movie(libraries[0].id, "item-b", "jf-1");
    await movie(libraries[1].id, "item-c", "jf-1");
    await movie(libraries[2].id, "item-d", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    // The primary's copy goes, and a library listing it under a lower id comes.
    await prisma.mediaItem.delete({ where: { id: "item-b" } });
    await movie(libraries[3].id, "item-a", "jf-1");
    archive = new FakeTracearrArchive();
    archive.add(truncated());
    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-a", sourceEventId: "chain-1", fanOutOfItemId: null, ...finished },
      { mediaItemId: "item-c", sourceEventId: "chain-1:copy:item-c", fanOutOfItemId: "item-a", ...finished },
      { mediaItemId: "item-d", sourceEventId: "chain-1:copy:item-d", fanOutOfItemId: "item-a", ...finished },
    ]);
    const history = await expectJson<{ items: unknown[] }>(
      await callRoute(listHistory, { url: "/api/media/history" }),
      200,
    );
    expect(history.items).toHaveLength(1);
  });

  it("drops the copy row a copy holds when the play's primary row moves onto it", async () => {
    // The primary's copy stops listing the item under the play's key while it
    // stays in the library: the primary row moves to the copy, which must not
    // keep its own copy row of the same play beside it — that counts the play
    // twice, and play counts never go back down.
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    await movie(moviesB.id, "item-c", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    await prisma.mediaItem.update({ where: { id: "item-b" }, data: { ratingKey: "jf-other" } });
    archive = new FakeTracearrArchive();
    archive.add(truncated());
    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-c", sourceEventId: "chain-1", fanOutOfItemId: null, ...finished },
    ]);
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: "item-c" } })).playCount).toBe(1);
  });

  it("still skips a rating key two Plex libraries share — a stale row, not a copy", async () => {
    const serverId = await mappedServer("PLEX");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "100");
    await movie(moviesB.id, "item-c", "100");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "100" }));

    await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(await rowsOf(serverId)).toEqual([]);
  });

  it("still skips a provider id two different files share", async () => {
    // A 4K beside a 1080p: two media, not one item listed twice.
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    const uhd = await movie(moviesA.id, "item-uhd", "jf-uhd");
    const hd = await movie(moviesB.id, "item-hd", "jf-hd");
    await createTestExternalId(uhd.id, "TMDB", "603");
    await createTestExternalId(hd.id, "TMDB", "603");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "gone", tmdb_id: 603 }));

    await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(await rowsOf(serverId)).toEqual([]);
  });

  it("recovers a play onto both copies of a re-added item, counted once", async () => {
    // A walked archive (its newest play recent) on a server where an item two
    // libraries list was just added back: its old play reaches both copies.
    const serverId = await mappedServer("JELLYFIN");
    await prisma.mediaServer.update({ where: { id: serverId }, data: { tracearrBackfillComplete: true } });
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    const other = await movie(moviesA.id, "item-z", "jf-9");
    await prisma.mediaItem.update({ where: { id: other.id }, data: { createdAt: at(-400 * DAY) } });
    await prisma.watchHistory.create({
      data: {
        mediaItemId: other.id,
        mediaServerId: serverId,
        serverUsername: "walter",
        watchedAt: at(-60 * 60 * 1000),
        source: "TRACEARR",
        sourceEventId: "recent",
        watched: true,
        state: "stopped",
      },
    });
    for (const [library, id] of [
      [moviesA, "item-b"],
      [moviesB, "item-c"],
    ] as const) {
      await movie(library.id, id, "jf-1");
      await prisma.mediaItem.update({ where: { id }, data: { createdAt: at(-DAY) } });
    }
    archive.add(play("chain-old", at(-30 * DAY), { rating_key: "jf-1" }));

    const result = await recoverHistoryForNewItems(serverId);

    // One play, asked about through either copy: two new rows (what the
    // caller reconciles and notifies pages for), logged as one play.
    expect(result.imported).toBe(2);
    expect(logger.info).toHaveBeenCalledWith(
      "WatchHistory",
      expect.stringContaining("imported 1 new play(s) (1 already stored)"),
    );
    expect((await rowsOf(serverId)).filter((row) => row.mediaItemId !== "item-z")).toEqual([
      { mediaItemId: "item-b", sourceEventId: "chain-old", fanOutOfItemId: null, watched: true, percentComplete: null },
      {
        mediaItemId: "item-c",
        sourceEventId: "chain-old:copy:item-c",
        fanOutOfItemId: "item-b",
        watched: true,
        percentComplete: null,
      },
    ]);
    for (const id of ["item-b", "item-c"]) {
      expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).lastPlayedAt).toEqual(at(-30 * DAY));
    }
    // Both answered: a play resolved to each — neither is asked again.
    m.getHistoryForItem.mockClear();
    await recoverHistoryForNewItems(serverId);
    expect(m.getHistoryForItem).not.toHaveBeenCalled();
  });
});
