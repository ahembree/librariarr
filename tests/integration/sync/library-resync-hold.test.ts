import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

/**
 * The library-resync hold across real sync runs (real Postgres; the media
 * server and Tracearr mocked at their client boundary). The sync engine, the
 * native watch-history sync, the purge route, the evidence helpers and the
 * evaluability guard are all real.
 *
 * The hold (`MediaServer.libraryResyncRequiredAt`) means "some of this
 * server's media rows are known to be missing and only a complete library sync
 * brings them back". While it is set no history pass may establish the marker
 * — one that ran before the items existed could not attach their plays — and
 * only a FULL sync that completely synced every library the hold waits for (an
 * enabled library holding no item older than the hold) releases it, before its
 * own history phase; a library-scoped sync releases only a population hold it
 * wrote itself, once its library is synced.
 */

const TRACEARR_SERVER_ID = "11111111-2222-3333-4444-555555555555";

const m = vi.hoisted(() => ({
  libraries: [] as Array<{ key: string; title: string; type: string }>,
  listings: {} as Record<string, { items: Array<Record<string, unknown>>; total?: number | null }>,
  /** Runs before every library page fetch: a purge, a Stop, a failure mid-run. */
  beforePage: null as null | ((key: string, offset: number) => Promise<void>),
  /** Runs before each per-item enrichment, i.e. right before a batch is written. */
  beforeEnrich: null as null | ((ratingKey: string) => Promise<void>),
  bulkListingIncomplete: false,
  history: vi.fn(),
  enqueueJob: vi.fn(),
  getHistoryPage: vi.fn(),
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

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getHistoryPage = m.getHistoryPage;
    this.listServers = m.listServers;
    this.getServerAccountNames = m.getServerAccountNames;
    this.findOldestPlayAt = m.findOldestPlayAt;
  },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => {
    const findItem = (ratingKey: string) =>
      Object.values(m.listings)
        .flatMap((l) => l.items)
        .find((i) => i.ratingKey === ratingKey);
    return {
      bulkListingIncomplete: m.bulkListingIncomplete,
      supportsHistorySince: false,
      testConnection: vi.fn(async () => ({ ok: true, serverName: "Test Server" })),
      getLibraries: vi.fn(async () => m.libraries),
      getWatchCounts: vi.fn(async () => new Map()),
      getLibraryShows: vi.fn(async () => []),
      getLibraryItemsPage: vi.fn(async (key: string, _type: string, offset: number, limit: number) => {
        if (m.beforePage) await m.beforePage(key, offset);
        const listing = m.listings[key] ?? { items: [] };
        return {
          items: listing.items.slice(offset, offset + limit).map((i) => ({ ...i })),
          total: listing.total === undefined ? listing.items.length : listing.total,
        };
      }),
      getItemMetadata: vi.fn(async (ratingKey: string) => {
        if (m.beforeEnrich) await m.beforeEnrich(ratingKey);
        return { ...findItem(ratingKey) };
      }),
      getDetailedWatchHistory: vi.fn((...args: unknown[]) => m.history(...args)),
    };
  }),
}));

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: m.enqueueJob,
  isJobRetrying: vi.fn(async () => false),
}));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));

import { syncMediaServer } from "@/lib/sync/sync-server";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { _resetLibraryResyncHoldRequestsForTesting, requireLibraryResync } from "@/lib/media/watch-evidence";
import { checkWatchHistoryCompleteness } from "@/lib/lifecycle/evaluability";
import { playHistoryFault } from "@/lib/lifecycle/play-history-fault";
import { TASK_TRACEARR_BACKFILL } from "@/lib/jobs/constants";
import { DELETE as purge } from "@/app/api/media/purge/route";
import { logger } from "@/lib/logger";

const prisma = getTestPrisma();

const movie = (ratingKey: string, title = `Movie ${ratingKey}`) => ({ ratingKey, title, type: "movie" });
const episode = (ratingKey: string, index: number) => ({
  ratingKey,
  title: `Episode ${index}`,
  type: "episode",
  grandparentTitle: "The Show",
  grandparentRatingKey: "show-1",
  parentIndex: 1,
  index,
});
const play = (ratingKey: string, username = "alice") => ({
  ratingKey,
  username,
  watchedAt: "2026-01-05T20:00:00.000Z",
  deviceName: null,
  platform: null,
});

let userId: string;
let serverId: string;
let moviesLibraryId: string;
let showsLibraryId: string;

async function serverRow() {
  return prisma.mediaServer.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      libraryResyncRequiredAt: true,
      watchHistorySyncedAt: true,
      tracearrBackfillComplete: true,
      tracearrBackfillCursorAt: true,
      tracearrForwardWatermarkAt: true,
      tracearrBackfillLastWalkAt: true,
    },
  });
}

const setHold = (at: Date | null) =>
  prisma.mediaServer.update({ where: { id: serverId }, data: { libraryResyncRequiredAt: at } });

const jobStatuses = async () =>
  (await prisma.syncJob.findMany({ where: { mediaServerId: serverId }, orderBy: { startedAt: "asc" } })).map(
    (j) => j.status,
  );

const backfillEnqueues = () =>
  m.enqueueJob.mock.calls.filter((args: unknown[]) => args[0] === TASK_TRACEARR_BACKFILL);

/**
 * Back-date every item of a library, so it holds items older than any hold
 * the test sets afterwards — a library the hold's cause left alone.
 */
const ageItems = (libraryId: string) =>
  prisma.mediaItem.updateMany({
    where: { libraryId },
    data: { createdAt: new Date("2025-01-01T00:00:00.000Z") },
  });

async function refusalReason(): Promise<string> {
  const result = await checkWatchHistoryCompleteness(userId, [serverId]);
  if (result.complete) throw new Error("expected the guard to refuse");
  return result.reason;
}

/**
 * A native Jellyfin server whose history was ESTABLISHED, with a Movies library
 * holding one movie and a Shows library that holds nothing (the one a purge
 * emptied, or one enabled after the history was established). The server
 * lists both, the Shows library with two episodes.
 */
async function seed(opts: { mapped?: boolean } = {}) {
  const user = await createTestUser();
  userId = user.id;
  const server = await createTestServer(user.id, {
    type: "JELLYFIN",
    watchHistorySyncedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...(opts.mapped ? { tracearrServerId: TRACEARR_SERVER_ID, tracearrBackfillComplete: true } : {}),
  });
  serverId = server.id;
  const movies = await createTestLibrary(server.id, { key: "1", title: "Movies", type: "MOVIE" });
  moviesLibraryId = movies.id;
  await createTestMediaItem(movies.id, { ratingKey: "m1", type: "MOVIE", title: "Movie m1" });
  const shows = await createTestLibrary(server.id, { key: "2", title: "Shows", type: "SERIES" });
  showsLibraryId = shows.id;
  if (opts.mapped) {
    await prisma.tracearrInstance.create({
      data: { userId: user.id, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
  }
  m.libraries = [
    { key: "1", title: "Movies", type: "movie" },
    { key: "2", title: "Shows", type: "show" },
  ];
  m.listings = {
    "1": { items: [movie("m1")] },
    "2": { items: [episode("e1", 1), episode("e2", 2)] },
  };
}

describe("library-resync hold across sync runs (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    m.beforePage = null;
    m.beforeEnrich = null;
    m.bulkListingIncomplete = false;
    m.history.mockResolvedValue([play("m1"), play("e1", "bob")]);
    m.enqueueJob.mockResolvedValue(true);
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "alice"]]));
    m.findOldestPlayAt.mockResolvedValue(null);
    m.getHistoryPage.mockResolvedValue({ records: [], nextCursor: null });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ── B2: only a complete full sync releases ──────────────────────────────

  describe("with a hold set before the run", () => {
    // Older than every item `seed` creates, so the hold waits for both
    // libraries: the Movies item reads as one re-added after it, and Shows is
    // empty. (A library holding an item older than the hold is one its cause
    // left alone — see "which libraries a hold waits for".)
    const heldAt = new Date(Date.now() - 60_000);

    beforeEach(async () => {
      await seed();
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { libraryResyncRequiredAt: heldAt, watchHistorySyncedAt: null },
      });
    });

    it("a complete full sync releases it before its history phase, which then establishes the marker", async () => {
      let holdWhenHistoryFetched: Date | null | undefined;
      m.history.mockImplementation(async () => {
        holdWhenHistoryFetched = (await serverRow()).libraryResyncRequiredAt;
        return [play("m1"), play("e1", "bob")];
      });

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(holdWhenHistoryFetched).toBeNull();
      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      // The history phase's own marker write succeeded in the same run — it
      // would have been refused had the release come after it.
      expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
      // ...having attached the re-added episode's play.
      expect(
        await prisma.watchHistory.count({ where: { mediaItem: { libraryId: showsLibraryId } } }),
      ).toBe(1);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });

    it("is not released when the server lists no libraries (an empty answer, not an error)", async () => {
      // Plex turns `{MediaContainer:{}}` into an empty list without throwing.
      m.libraries = [];

      await syncMediaServer(serverId, undefined, { trigger: "test: empty listing" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toEqual(heldAt);
      // Its history phase ran, and still could not vouch for the server.
      expect(m.history).toHaveBeenCalled();
      expect(row.watchHistorySyncedAt).toBeNull();
      expect(await refusalReason()).toMatch(/run Sync on it under Settings → Servers/);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(/Keeping .*play-history hold.*"Movies".*"Shows"/),
      );
    });

    it("is not released while an enabled library went unsynced — enabled after the run read the disabled list", async () => {
      await prisma.library.update({ where: { id: showsLibraryId }, data: { enabled: false } });
      m.beforePage = async (key) => {
        if (key === "1") await prisma.library.update({ where: { id: showsLibraryId }, data: { enabled: true } });
      };

      await syncMediaServer(serverId, undefined, { trigger: "test: library enabled mid-run" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
    });

    it("is not released when a library came up short past the tolerance — and the stale purge is skipped", async () => {
      // The server reports 200 movies and lists one: 199 short is past
      // max(50, 2% of 200).
      await createTestMediaItem(moviesLibraryId, { ratingKey: "m-gone", type: "MOVIE", title: "Gone" });
      m.listings["1"] = { items: [movie("m1")], total: 200 };

      await syncMediaServer(serverId, undefined, { trigger: "test: truncated" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
      expect((await serverRow()).watchHistorySyncedAt).toBeNull();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(/Keeping .*play-history hold.*"Movies"/),
      );
      // The stale-item purge keeps its strict rule.
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId, ratingKey: "m-gone" } })).toBe(1);
    });

    it("is released when a library came up short within the tolerance on two syncs in a row — with a warning, and still no stale purge", async () => {
      // A server that over-reports a total never lets a pass reach it; held on
      // that alone, the server's play-activity rules stayed paused for good.
      // 30 reported, 1 listed, the listing ended: 29 short, within max(50, 2%).
      await createTestMediaItem(moviesLibraryId, { ratingKey: "m-gone", type: "MOVIE", title: "Gone" });
      m.listings["1"] = { items: [movie("m1")], total: 30 };

      // The first such pass may be a listing cut short just this once: the
      // items it left out would come back after the release with none of their
      // plays (through the lifecycle re-sync or a realtime add, which never
      // re-read history), while the guard read the history as complete.
      await syncMediaServer(serverId, undefined, { trigger: "test: over-reported total" });
      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(
          /Keeping .*"Movies" \(the server listed 1 of the 30 items it reported — within the tolerance .* counts as synced on the next full sync if that one comes up short within it too\)/,
        ),
      );

      // The second in a row is a server that over-reports.
      await syncMediaServer(serverId, undefined, { trigger: "test: over-reported total, again" });
      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      // Released before the history phase, which then established the marker.
      expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringContaining('"Movies" (1 of 30) — within the tolerance for an over-reported total'),
      );
      // The stale-item purge did not run on the strength of the tolerance.
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId, ratingKey: "m-gone" } })).toBe(1);
    });

    it("does not stretch the tolerance to a pass that stored no media", async () => {
      // Containers only, then the end of the listing: short of the total, but
      // the pass learned nothing about the library's media.
      m.listings["2"] = { items: [{ ratingKey: "c1", title: "Box Set", type: "collection" }], total: 4 };

      await syncMediaServer(serverId, undefined, { trigger: "test: containers only" });

      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
    });

    it("does not stretch the tolerance to a listing that ended on an empty first page", async () => {
      // An empty first page under a non-zero total is the shape of a proxy or a
      // half-started server answering `[]`, not of an over-reported count.
      await createTestMediaItem(showsLibraryId, { ratingKey: "e0", type: "SERIES", title: "Episode 0" });
      m.listings["2"] = { items: [], total: 3 };

      await syncMediaServer(serverId, undefined, { trigger: "test: empty first page" });

      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
    });

    it("is not released when the server answered nothing for a library that holds rows ('refusing to wipe')", async () => {
      m.listings["1"] = { items: [], total: 0 };

      await syncMediaServer(serverId, undefined, { trigger: "test: refusing to wipe" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
    });

    it("is not released by a library-scoped sync, though that completes", async () => {
      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: scoped" });
      await syncMediaServer(serverId, "1", { skipWatchHistory: true, trigger: "test: scoped" });

      expect(await jobStatuses()).toEqual(["COMPLETED", "COMPLETED"]);
      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(2);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
    });

    it("is not released by a library-scoped sync even when that library is the server's only one", async () => {
      // Scoped runs skip the vanished-library purge, so they cannot vouch for
      // the server's library list; a hold they did not write themselves waits
      // for a full sync.
      await prisma.library.delete({ where: { id: showsLibraryId } });
      m.libraries = [{ key: "1", title: "Movies", type: "movie" }];

      await syncMediaServer(serverId, "1", { trigger: "test: scoped, single library" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
    });

    it("is not released by a full sync that was stopped", async () => {
      m.beforePage = async () => {
        await prisma.syncJob.updateMany({
          where: { mediaServerId: serverId, status: "RUNNING" },
          data: { cancelRequested: true },
        });
      };

      await syncMediaServer(serverId, undefined, { trigger: "test: stopped" });

      expect(await jobStatuses()).toEqual(["CANCELLED"]);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
    });

    it("is not released by a full sync that failed", async () => {
      m.beforePage = async (key) => {
        if (key === "2") throw new Error("server went away");
      };

      await expect(syncMediaServer(serverId, undefined, { trigger: "test: failed" })).rejects.toThrow(
        "server went away",
      );

      expect(await jobStatuses()).toEqual(["FAILED"]);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
    });

    it("is not released by a run whose library pass began before a newer hold request — the next full sync releases it", async () => {
      // A purge lands while the sync is already in its library pass: it may
      // have passed the purged library before its items were deleted. The
      // column keeps the earlier hold, so the release has to know of the purge
      // some other way.
      m.beforePage = async () => {
        m.beforePage = null;
        await requireLibraryResync([serverId]);
      };

      await syncMediaServer(serverId, undefined, { trigger: "test: overlapping purge" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(heldAt);
      expect((await serverRow()).watchHistorySyncedAt).toBeNull();
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        "Sync",
        expect.stringContaining("it was requested again after this sync began its library pass"),
      );

      await syncMediaServer(serverId, undefined, { trigger: "test: next full sync" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
    });

    it("a listing that omits a library purges it as vanished — and when it comes back, it is held again", async () => {
      // The omitted library is not left behind as an enabled-but-unsynced row:
      // the vanished-library purge removes it (holding nothing — it was empty),
      // so the run that saw every remaining library complete releases. That is
      // safe because the library cannot come back except as a NEW library,
      // which a sync populates — and populating takes a fresh hold.
      m.libraries = [{ key: "1", title: "Movies", type: "movie" }];

      await syncMediaServer(serverId, undefined, { trigger: "test: library omitted" });

      expect(await prisma.library.count({ where: { id: showsLibraryId } })).toBe(0);
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();

      m.libraries = [
        { key: "1", title: "Movies", type: "movie" },
        { key: "2", title: "Shows", type: "show" },
      ];
      m.bulkListingIncomplete = true;
      let holdWhileRepopulating: Date | null | undefined;
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey === "e1") holdWhileRepopulating = (await serverRow()).libraryResyncRequiredAt;
      };

      await syncMediaServer(serverId, undefined, { trigger: "test: library back" });

      expect(holdWhileRepopulating).toBeInstanceOf(Date);
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
    });
  });

  // ── P2: no marker over items that are not back yet ──────────────────────

  describe("a native server", () => {
    beforeEach(async () => {
      await seed();
    });

    it("after a purge, a history sync before the re-sync cannot vouch; a scoped sync keeps the hold; a full sync clears it", async () => {
      // Movies holds a play; purge it.
      await prisma.watchHistory.create({
        data: {
          mediaItemId: (await prisma.mediaItem.findFirstOrThrow({ where: { libraryId: moviesLibraryId } })).id,
          mediaServerId: serverId,
          serverUsername: "alice",
          watchedAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      });
      setMockSession({ isLoggedIn: true, userId });
      await expectJson(
        await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId: moviesLibraryId } }),
        200,
      );
      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect((await serverRow()).watchHistorySyncedAt).toBeNull();

      // A playback's realtime job, or the History page's Refresh, runs the
      // native full replace before the items are back. It finds the plays, but
      // the movie they belong to does not exist yet.
      const refresh = await syncWatchHistory(serverId);
      expect(refresh.failed).toBeUndefined();
      expect((await serverRow()).watchHistorySyncedAt).toBeNull();
      expect(await refusalReason()).toMatch(/run Sync on it under Settings → Servers/);

      // The by-type fan-out (or a retried library job) re-adds the library,
      // scoped: still held.
      await syncMediaServer(serverId, "1", { skipWatchHistory: true, trigger: "test: by-type" });
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);
      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
      await syncWatchHistory(serverId);
      expect((await serverRow()).watchHistorySyncedAt).toBeNull();

      // A full sync releases it, and its history phase attaches the plays.
      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
      expect(
        await prisma.watchHistory.count({ where: { mediaItem: { libraryId: moviesLibraryId } } }),
      ).toBe(1);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });

    it("a full sync that populates a library and whose history phase fails leaves the marker withdrawn until a history sync succeeds", async () => {
      m.history.mockRejectedValueOnce(new Error("Jellyfin timed out"));

      await syncMediaServer(serverId, undefined, { trigger: "test: full, history fails" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(2);
      const row = await serverRow();
      // Released (every library was synced completely), but nothing attached
      // the new episodes' plays: the release withdrew the marker.
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.watchHistorySyncedAt).toBeNull();
      expect(await refusalReason()).toMatch(/no sync has established/);

      const next = await syncWatchHistory(serverId);
      expect(next.failed).toBeUndefined();
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });
  });

  // ── Population ──────────────────────────────────────────────────────────

  describe("the population hold", () => {
    beforeEach(async () => {
      await seed();
    });

    it("is taken before the first item lands in an empty library and released by the same full run", async () => {
      m.bulkListingIncomplete = true;
      let seen: { hold: Date | null; marker: Date | null; items: number; startedAt: Date } | undefined;
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey !== "e1" || seen) return;
        const row = await serverRow();
        const job = await prisma.syncJob.findFirstOrThrow({ where: { mediaServerId: serverId } });
        seen = {
          hold: row.libraryResyncRequiredAt,
          marker: row.watchHistorySyncedAt,
          items: await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } }),
          startedAt: job.startedAt,
        };
      };

      await syncMediaServer(serverId, undefined, { trigger: "test: populate" });

      expect(seen).toBeDefined();
      // Held, with nothing written into the library yet.
      expect(seen!.items).toBe(0);
      expect(seen!.hold).toBeInstanceOf(Date);
      // At the run's own pass start, so the run can release it.
      expect(seen!.hold!.getTime()).toBeGreaterThanOrEqual(seen!.startedAt.getTime());
      expect(seen!.marker).toBeNull();
      // Released at the end of the library loop; the history phase then
      // attached the episode's play and established the marker.
      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
      expect(await prisma.watchHistory.count({ where: { mediaItem: { libraryId: showsLibraryId } } })).toBe(1);
    });

    it("is not taken for a library the server lists as empty — an established marker is left alone", async () => {
      m.listings["2"] = { items: [] };
      // A failing history phase leaves the marker exactly as the sync found
      // it unless something withdrew it — which a hold would have.
      m.history.mockRejectedValue(new Error("down"));
      const before = (await serverRow()).watchHistorySyncedAt;

      await syncMediaServer(serverId, undefined, { trigger: "test: empty server library" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect((await serverRow()).watchHistorySyncedAt).toEqual(before);
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
    });

    it("is not taken for a library that already held items", async () => {
      await createTestMediaItem(showsLibraryId, { ratingKey: "e1", type: "SERIES", title: "Episode 1" });
      m.history.mockRejectedValue(new Error("down"));
      const before = (await serverRow()).watchHistorySyncedAt;

      await syncMediaServer(serverId, undefined, { trigger: "test: populated" });

      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(2);
      expect((await serverRow()).watchHistorySyncedAt).toEqual(before);
    });

    it("is not taken for a page of nothing but containers", async () => {
      m.listings["2"] = { items: [{ ratingKey: "c1", title: "Box Set", type: "collection" }] };
      m.history.mockRejectedValue(new Error("down"));
      const before = (await serverRow()).watchHistorySyncedAt;

      await syncMediaServer(serverId, undefined, { trigger: "test: containers" });

      expect((await serverRow()).watchHistorySyncedAt).toEqual(before);
    });

    it("restarts a mapped server's Tracearr walk, so it reads the new library's plays", async () => {
      await cleanDatabase();
      await seed({ mapped: true });
      const before = Date.now();

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      const row = await serverRow();
      expect(row.tracearrBackfillComplete).toBe(false);
      expect(row.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(row.tracearrForwardWatermarkAt).toEqual(row.tracearrBackfillCursorAt);
      expect(row.tracearrBackfillLastWalkAt).toBeNull();
      // The run wrote that hold itself and synced the library, so it released
      // it — and queued the walk it was holding.
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(backfillEnqueues()).toEqual([
        [
          TASK_TRACEARR_BACKFILL,
          { serverId },
          expect.objectContaining({ jobKey: `tracearr-backfill:${serverId}` }),
        ],
      ]);
    });
  });

  // ── A library-scoped run and the population hold it took itself ────────

  describe("a library-scoped run's own population hold", () => {
    beforeEach(async () => {
      await seed();
    });

    it("enable a library, Sync Now: released by that run, whose history phase then establishes the marker", async () => {
      m.bulkListingIncomplete = true;
      let holdDuringRun: Date | null | undefined;
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey === "e1") holdDuringRun = (await serverRow()).libraryResyncRequiredAt;
      };

      await syncMediaServer(serverId, "2", { trigger: "test: Sync Now after enabling" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(holdDuringRun).toBeInstanceOf(Date);
      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
      expect(await prisma.watchHistory.count({ where: { mediaItem: { libraryId: showsLibraryId } } })).toBe(1);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });

    it("by-type style (no history step): released, the marker stays null until a later history sync", async () => {
      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.watchHistorySyncedAt).toBeNull();
      expect(await refusalReason()).toMatch(/no sync has established/);

      // The fan-out's follow-up history job.
      await syncWatchHistory(serverId);
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });

    it("does not release an earlier purge's hold — only a full sync does", async () => {
      const purgedAt = new Date(Date.now() - 60_000);
      await setHold(purgedAt);

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(2);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(purgedAt);
      await syncWatchHistory(serverId);
      expect((await serverRow()).watchHistorySyncedAt).toBeNull();

      // The full-run rule is unchanged: it releases the purge's hold.
      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
    });

    it("does not release when a purge landed mid-run before the population", async () => {
      // The purge holds the server first; the population then finds a hold in
      // place and writes none of its own.
      let purgeHold: Date | null = null;
      m.beforePage = async (key) => {
        if (key !== "2" || purgeHold) return;
        await requireLibraryResync([serverId]);
        purgeHold = (await serverRow()).libraryResyncRequiredAt;
      };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(purgeHold).toBeInstanceOf(Date);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(purgeHold);
    });

    it("does not release when a purge landed mid-run after the population — even at the hold's own instant", async () => {
      // Written at the very instant of the population hold, the purge leaves
      // the column as it was: only the withdrawal it counted tells them apart.
      m.bulkListingIncomplete = true;
      let ownHold: Date | null = null;
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey !== "e1" || ownHold) return;
        ownHold = (await serverRow()).libraryResyncRequiredAt;
        await requireLibraryResync([serverId], { at: ownHold! });
      };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(ownHold).toBeInstanceOf(Date);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(ownHold);
    });

    it("does not release when a real purge of another library landed mid-run after the population", async () => {
      m.bulkListingIncomplete = true;
      let purged = false;
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey !== "e1" || purged) return;
        purged = true;
        setMockSession({ isLoggedIn: true, userId });
        await expectJson(
          await callRoute(purge, {
            url: "/api/media/purge",
            method: "DELETE",
            searchParams: { libraryId: moviesLibraryId },
          }),
          200,
        );
      };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(purged).toBe(true);
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(0);
      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
    });

    it("keeps it when its library came up short past the tolerance, and says why", async () => {
      m.listings["2"] = { items: [episode("e1", 1), episode("e2", 2)], total: 300 };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(/Keeping .*play-history hold.*"Shows"/),
      );
    });

    it("keeps it on a first pass within the tolerance; the next full sync that comes up short within it too releases it", async () => {
      m.listings["2"] = { items: [episode("e1", 1), episode("e2", 2)], total: 12 };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(/Keeping .*"Shows" \(the server listed 2 of the 12 items it reported/),
      );

      // Movies holds an item older than the hold: the hold does not wait for it.
      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringContaining('"Shows" (2 of 12) — within the tolerance'),
      );
    });

    it("keeps it when the run was stopped", async () => {
      m.beforePage = async () => {
        await prisma.syncJob.updateMany({
          where: { mediaServerId: serverId, status: "RUNNING" },
          data: { cancelRequested: true },
        });
      };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type, stopped" });

      expect(await jobStatuses()).toEqual(["CANCELLED"]);
      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
    });

    it("leaves the full-run rule alone: a full run that leaves the library it populated short keeps even its own hold", async () => {
      // The full run populates Shows itself, but falls far short of its total.
      m.listings["2"] = { items: [episode("e1", 1), episode("e2", 2)], total: 400 };

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });

      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(/Keeping .*it waits for "Shows" \(the server listed 2 of the 400 items/),
      );
    });

    it("a full run releases its own population hold although a library the hold does not wait for came up short", async () => {
      // Movies held its item well before this run's population hold: the
      // hold's cause left it alone, so its shortfall says nothing about the
      // hold. (Aged past the minute's margin the release allows for.)
      await ageItems(moviesLibraryId);
      m.listings["1"] = { items: [movie("m1")], total: 400 };

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });

      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
    });
  });

  // ── Which libraries a hold waits for ──────────────────────────────────
  // Those holding no item created before the hold: every cause leaves the
  // library it waits on that way. One holding an older item was left alone,
  // and whether a sync can sync it says nothing about the hold.

  describe("which libraries a hold waits for", () => {
    beforeEach(async () => {
      await seed();
    });

    it("a library listed as empty while it holds older items no longer keeps a population hold — released by the first full sync, and every one after", async () => {
      // The reviewers' repro: Movies holds a row while the server lists it as
      // empty (emptied on the server, every item deleted by a lifecycle rule,
      // access lost) — "refusing to wipe" on every sync. Shows is new and is
      // populated by the full sync. The population hold was never released.
      await ageItems(moviesLibraryId);
      m.listings["1"] = { items: [], total: 0 };

      for (let run = 1; run <= 3; run++) {
        await syncMediaServer(serverId, undefined, { trigger: `test: full sync ${run}` });
        const row = await serverRow();
        expect(row.libraryResyncRequiredAt, `run ${run}`).toBeNull();
        expect(row.watchHistorySyncedAt, `run ${run}`).toBeInstanceOf(Date);
        await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
      }
      expect(await jobStatuses()).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
      // The refused wipe still refused: the stale purge is unchanged.
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);
      // ...and the populated library's plays were attached by the first run.
      expect(await prisma.watchHistory.count({ where: { mediaItem: { libraryId: showsLibraryId } } })).toBe(1);
    });

    it("a library the hold does not wait for may go unvisited or come up far short — released", async () => {
      await ageItems(moviesLibraryId);
      await setHold(new Date(Date.now() - 1_000));

      // Unvisited: disabled when the run read the disabled list, enabled during it.
      await prisma.library.update({ where: { id: moviesLibraryId }, data: { enabled: false } });
      m.beforePage = async (key) => {
        if (key === "2") await prisma.library.update({ where: { id: moviesLibraryId }, data: { enabled: true } });
      };
      await syncMediaServer(serverId, undefined, { trigger: "test: untouched library unvisited" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();

      // Far short: 1 of 400 listed.
      m.beforePage = null;
      await setHold(new Date(Date.now() - 1_000));
      m.listings["1"] = { items: [movie("m1")], total: 400 };
      await syncMediaServer(serverId, undefined, { trigger: "test: untouched library far short" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
    });

    it("a library the hold waits for still blocks when the server answers nothing for its rows, and says why", async () => {
      // Movies' item is newer than the hold — re-added after it — so the hold
      // waits for Movies too.
      const hold = new Date(Date.now() - 60_000);
      await setHold(hold);
      m.listings["1"] = { items: [], total: 0 };

      await syncMediaServer(serverId, undefined, { trigger: "test: awaited library refused" });

      expect((await serverRow()).libraryResyncRequiredAt).toEqual(hold);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(
          /Keeping .*it waits for "Movies" \(server returned 0 items for a library that previously had 1 — refusing to wipe it\)/,
        ),
      );
    });

    it("a library a failed sync half populated stays awaited, even after a later purge request — the hold keeps its earliest instant", async () => {
      // A by-type job populates Shows and fails after its first page; the
      // population hold stays with 500 of 600 episodes in. A purge of Movies
      // then requests the hold again. Moved to the purge's instant, the hold
      // would make Shows' episodes read as older than it — a library nothing
      // touched — and a full sync that left Shows short would release it.
      const episodes = Array.from({ length: 600 }, (_, i) => episode(`e${i}`, i + 1));
      m.listings["2"] = { items: episodes };
      m.beforePage = async (key, offset) => {
        if (key === "2" && offset === 500) throw new Error("server went away");
      };
      await expect(
        syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type, fails" }),
      ).rejects.toThrow("server went away");
      m.beforePage = null;
      const populationHold = (await serverRow()).libraryResyncRequiredAt;
      expect(populationHold).toBeInstanceOf(Date);
      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(500);

      setMockSession({ isLoggedIn: true, userId });
      await expectJson(
        await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId: moviesLibraryId } }),
        200,
      );
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(populationHold);

      // Movies comes back complete; Shows lists only its first 500 of 600.
      m.listings["2"] = { items: episodes.slice(0, 500), total: 600 };
      await syncMediaServer(serverId, undefined, { trigger: "test: full, Shows short" });
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(populationHold);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(/Keeping .*it waits for "Shows" \(the server listed 500 of the 600 items/),
      );

      m.listings["2"] = { items: episodes };
      await syncMediaServer(serverId, undefined, { trigger: "test: full, complete" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
    });

    it("rows created just before the hold — a purge racing an upsert — leave their library awaited (a minute's margin)", async () => {
      // `processBatch` dates a row before its INSERT runs; a purge whose hold
      // lands in between and whose DELETE commits first leaves the library it
      // emptied holding rows dated just BEFORE the hold.
      const hold = new Date(Date.now() - 60_000);
      await prisma.mediaItem.updateMany({
        where: { libraryId: moviesLibraryId },
        data: { createdAt: new Date(hold.getTime() - 10_000) },
      });
      await setHold(hold);
      m.listings["1"] = { items: [], total: 0 };

      await syncMediaServer(serverId, undefined, { trigger: "test: rows inside the margin" });

      expect((await serverRow()).libraryResyncRequiredAt).toEqual(hold);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(/Keeping .*it waits for "Movies" \(server returned 0 items/),
      );

      // Two minutes older is a library the hold's cause left alone.
      await prisma.mediaItem.updateMany({
        where: { libraryId: moviesLibraryId },
        data: { createdAt: new Date(hold.getTime() - 120_000) },
      });
      await syncMediaServer(serverId, undefined, { trigger: "test: rows outside the margin" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
    });

    it("an empty first page with no reported total ends the listing: an empty awaited library counts as synced", async () => {
      await setHold(new Date(Date.now() - 60_000));
      m.listings["2"] = { items: [], total: null };

      await syncMediaServer(serverId, undefined, { trigger: "test: empty, no total" });

      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
    });

    it("...while a library holding rows that such a listing comes back empty for still refuses to be wiped, and blocks", async () => {
      const hold = new Date(Date.now() - 60_000);
      await setHold(hold);
      m.listings["1"] = { items: [], total: null };

      await syncMediaServer(serverId, undefined, { trigger: "test: empty, no total, rows held" });

      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(hold);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Sync",
        expect.stringMatching(/Keeping .*"Movies" \(server returned 0 items .* refusing to wipe it\)/),
      );
    });
  });

  // ── A shortfall within the tolerance, sighted twice ──────────────────────

  describe("a shortfall within the tolerance", () => {
    beforeEach(async () => {
      await seed();
    });

    it("a short sync followed by a complete one releases on the complete one", async () => {
      const hold = new Date(Date.now() - 60_000);
      await setHold(hold);
      m.listings["1"] = { items: [movie("m1")], total: 30 };
      await syncMediaServer(serverId, undefined, { trigger: "test: short" });
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(hold);

      m.listings["1"] = { items: [movie("m1")] };
      await syncMediaServer(serverId, undefined, { trigger: "test: complete" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
    });

    it("two short syncs release across a restart: the sighting is kept on the library row, not in memory", async () => {
      // A nightly auto-update between two daily syncs restarts the process
      // every time: kept in memory, an over-reporting library never reached
      // its second sighting and its hold was never released.
      const hold = new Date(Date.now() - 60_000);
      await setHold(hold);
      m.listings["1"] = { items: [movie("m1")], total: 30 };

      await syncMediaServer(serverId, undefined, { trigger: "test: short" });
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(hold);
      expect((await prisma.library.findUniqueOrThrow({ where: { id: moviesLibraryId } })).shortPassSeenAt).toBeInstanceOf(
        Date,
      );

      // A restart: nothing this process remembered survives it.
      _resetLibraryResyncHoldRequestsForTesting();
      vi.resetModules();
      const { syncMediaServer: syncAfterRestart } = await import("@/lib/sync/sync-server");
      await syncAfterRestart(serverId, undefined, { trigger: "test: short, after a restart" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
    });

    it("the reviewers' carry: a sighting recorded before a purge never counts toward the hold the purge took", async () => {
      // Steady state: Movies holds 60 items and the server reports 61. Then a
      // sighting is on the row from an earlier hold, Movies is purged, and the
      // first re-sync's listing is cut short to 11 of 61 — within max(50, 2%)
      // of the total. Counted as the second sighting, it released the hold
      // with 50 items missing.
      const all = Array.from({ length: 60 }, (_, i) => movie(`m${i + 1}`));
      m.listings["1"] = { items: all, total: 61 };
      await ageItems(moviesLibraryId);
      await syncMediaServer(serverId, undefined, { trigger: "test: steady state" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      await prisma.library.update({ where: { id: moviesLibraryId }, data: { shortPassSeenAt: new Date() } });

      setMockSession({ isLoggedIn: true, userId });
      await expectJson(
        await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId: moviesLibraryId } }),
        200,
      );
      const hold = (await serverRow()).libraryResyncRequiredAt;
      expect(hold).toBeInstanceOf(Date);

      m.listings["1"] = { items: all.slice(0, 11), total: 61 };
      await syncMediaServer(serverId, undefined, { trigger: "test: truncated re-sync" });
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(hold);
      expect(await refusalReason()).toMatch(/waits for a complete library sync/);
    });

    it("...the purge itself clears it, for a library something re-adds an item to before the next full sync", async () => {
      // A realtime add lands in the purged library first, so the full sync's
      // pass no longer starts on an empty library.
      m.listings["1"] = { items: [movie("m1")], total: 1 };
      await prisma.library.update({ where: { id: moviesLibraryId }, data: { shortPassSeenAt: new Date() } });
      setMockSession({ isLoggedIn: true, userId });
      await expectJson(
        await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId: moviesLibraryId } }),
        200,
      );
      expect((await prisma.library.findUniqueOrThrow({ where: { id: moviesLibraryId } })).shortPassSeenAt).toBeNull();
      const hold = (await serverRow()).libraryResyncRequiredAt;
      await createTestMediaItem(moviesLibraryId, { ratingKey: "m-new", type: "MOVIE", title: "Just Added" });

      m.listings["1"] = { items: [movie("m-new")], total: 30 };
      await syncMediaServer(serverId, undefined, { trigger: "test: short, after a realtime add" });

      expect((await serverRow()).libraryResyncRequiredAt).toEqual(hold);
    });

    it("...and a pass that starts on an empty library clears one a purge did not (here: items deleted directly)", async () => {
      await prisma.library.update({ where: { id: moviesLibraryId }, data: { shortPassSeenAt: new Date() } });
      await requireLibraryResync([serverId]);
      const hold = (await serverRow()).libraryResyncRequiredAt;
      await prisma.mediaItem.deleteMany({ where: { libraryId: moviesLibraryId } });

      m.listings["1"] = { items: [movie("m1")], total: 30 };
      await syncMediaServer(serverId, undefined, { trigger: "test: short refill" });

      expect((await serverRow()).libraryResyncRequiredAt).toEqual(hold);
      // ...and the refill's own sighting is what the next pass counts.
      await syncMediaServer(serverId, undefined, { trigger: "test: short again" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
    });

    it("the reviewers' gap: a purged library re-synced 10 of 60 keeps the hold, and the 50 brought back later still wait for a full sync", async () => {
      // Within max(50, 2%) on the first sight: released, the 50 missing items
      // then came back through the lifecycle executor's scoped re-sync (no full
      // replace) and read as never watched while the guard read the history as
      // complete.
      const all = Array.from({ length: 60 }, (_, i) => movie(`g${i}`));
      for (const item of all) {
        const row = await createTestMediaItem(moviesLibraryId, {
          ratingKey: item.ratingKey,
          type: "MOVIE",
          title: item.title,
        });
        await prisma.watchHistory.create({
          data: {
            mediaItemId: row.id,
            mediaServerId: serverId,
            serverUsername: "alice",
            watchedAt: new Date("2026-01-05T20:00:00.000Z"),
          },
        });
      }
      m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
      await prisma.library.delete({ where: { id: showsLibraryId } });
      m.history.mockResolvedValue(all.map((i) => play(i.ratingKey)));
      setMockSession({ isLoggedIn: true, userId });
      await expectJson(
        await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId: moviesLibraryId } }),
        200,
      );

      m.listings = { "1": { items: all.slice(0, 10), total: 60 } };
      await syncMediaServer(serverId, undefined, { trigger: "test: truncated re-sync" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect(await refusalReason()).toMatch(/waits for a complete library sync/);

      m.listings = { "1": { items: all } };
      await syncMediaServer(serverId, "1", {
        skipWatchHistory: true,
        trigger: "lifecycle execution: re-sync after destructive actions",
      });
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(60);
      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect(await refusalReason()).toMatch(/waits for a complete library sync/);

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId } })).toBe(60);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });
  });

  // ── Flows the reviewers walked through ─────────────────────────────────

  describe("flows", () => {
    it("a by-type job that failed after populating part of its library: the retry keeps the hold, a full sync releases it", async () => {
      await seed();
      m.listings["2"] = { items: Array.from({ length: 600 }, (_, i) => episode(`e${i}`, i + 1)) };
      let failOnce = true;
      m.beforePage = async (key, offset) => {
        if (key === "2" && offset === 500 && failOnce) {
          failOnce = false;
          throw new Error("server went away");
        }
      };

      await expect(
        syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type, attempt 1" }),
      ).rejects.toThrow("server went away");
      await syncWatchHistory(serverId); // the fan-out's follow-up, run before the retry
      expect((await serverRow()).watchHistorySyncedAt).toBeNull();

      // The library is no longer empty: the retry takes no hold of its own, so
      // it has no receipt to release the first attempt's with.
      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type, retry" });
      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(600);
      await syncWatchHistory(serverId);
      expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect((await serverRow()).watchHistorySyncedAt).toBeNull();

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
    });

    it("purging a disabled library holds nothing: the next history sync re-establishes the marker", async () => {
      // Settings disables the library, then purges it when asked to delete
      // its data. Nothing re-adds a disabled library's items, so a hold would
      // only pause the server's rules until some full sync.
      await seed();
      const kids = await createTestLibrary(serverId, { key: "3", title: "Kids", type: "MOVIE" });
      await createTestMediaItem(kids.id, { ratingKey: "k1", type: "MOVIE", title: "Kid movie" });
      await prisma.library.update({ where: { id: kids.id }, data: { enabled: false } });
      setMockSession({ isLoggedIn: true, userId });

      await expectJson(
        await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId: kids.id } }),
        200,
      );
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect((await serverRow()).watchHistorySyncedAt).toBeNull();

      await syncWatchHistory(serverId);
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });

    it("two libraries enabled one after the other: each Sync Now releases the hold it took", async () => {
      await seed();
      const kids = await createTestLibrary(serverId, { key: "3", title: "Kids", type: "MOVIE" });
      m.libraries.push({ key: "3", title: "Kids", type: "movie" });
      m.listings["3"] = { items: [movie("k1")] };

      await syncMediaServer(serverId, "2", { trigger: "test: Sync Now, Shows" });
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);

      await syncMediaServer(serverId, "3", { trigger: "test: Sync Now, Kids" });
      expect(await prisma.mediaItem.count({ where: { libraryId: kids.id } })).toBe(1);
      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
    });

    it("a restore that undoes a purge leaves no stale hold request behind: enabling a library and Sync Now still releases its own hold", async () => {
      // The reviewer's repro: the purge noted a hold request; the restore put
      // the hold column back to the file's (null) without forgetting it, so
      // the population hold Sync Now then took got no receipt and waited for
      // a full sync.
      const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-hold-restore-"));
      process.env.BACKUP_DIR = backupDir;
      try {
        const { createBackup, restoreBackup } = await import("@/lib/backup/backup-service");
        await seed();
        const file = await createBackup(undefined, false);
        setMockSession({ isLoggedIn: true, userId });
        await expectJson(
          await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId: moviesLibraryId } }),
          200,
        );
        expect((await serverRow()).libraryResyncRequiredAt).toBeInstanceOf(Date);

        await restoreBackup(file);
        expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
        expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);

        await syncMediaServer(serverId, "2", { trigger: "test: Sync Now after enabling" });
        const row = await serverRow();
        expect(row.libraryResyncRequiredAt).toBeNull();
        expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
      } finally {
        await fs.rm(backupDir, { recursive: true, force: true });
      }
    });

    it("a Tracearr-mapped server: after Sync Now the editor and the guard both name the restarted import, not a Refresh", async () => {
      // The release nulls the marker and only the restarted walk's completion
      // establishes it again; "run a Refresh" pointed at a sync that cannot help.
      await seed({ mapped: true });

      await syncMediaServer(serverId, "2", { trigger: "test: Sync Now" });

      let row = await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.tracearrBackfillComplete).toBe(false);
      expect(playHistoryFault(row)).toBe("importing");
      expect(await refusalReason()).toMatch(/has not finished walking back through the archive/);
      expect(await refusalReason()).not.toMatch(/no sync has established|Refresh/);

      // A Refresh runs the forward catch-up only, and the fault is unchanged.
      await syncWatchHistory(serverId);
      row = await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });
      expect(playHistoryFault(row)).toBe("importing");
      expect(await refusalReason()).toMatch(/has not finished walking back through the archive/);
    });
  });

  // ── What must not change ───────────────────────────────────────────────

  describe("regressions", () => {
    it("a full sync with no hold leaves an established marker alone when its history phase fails", async () => {
      await seed();
      m.listings["2"] = { items: [] };
      m.history.mockRejectedValue(new Error("down"));
      const before = (await serverRow()).watchHistorySyncedAt;

      await syncMediaServer(serverId, undefined, { trigger: "test: plain" });

      expect((await serverRow()).watchHistorySyncedAt).toEqual(before);
    });

    it("a full sync with no hold re-establishes the marker through its history phase as before", async () => {
      await seed();
      m.listings["2"] = { items: [] };
      const before = (await serverRow()).watchHistorySyncedAt!;

      await syncMediaServer(serverId, undefined, { trigger: "test: plain" });

      const after = (await serverRow()).watchHistorySyncedAt!;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
      expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId } })).toBe(1);
    });

    it("the lifecycle executor's scoped re-sync of a populated library still works and takes no hold", async () => {
      await seed();
      m.listings["1"] = { items: [movie("m1", "Renamed")] };
      const before = (await serverRow()).watchHistorySyncedAt;

      await syncMediaServer(serverId, "1", {
        skipWatchHistory: true,
        trigger: "lifecycle execution: re-sync after destructive actions",
      });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect((await prisma.mediaItem.findFirstOrThrow({ where: { libraryId: moviesLibraryId } })).title).toBe(
        "Renamed",
      );
      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.watchHistorySyncedAt).toEqual(before);
    });

    it("the vanished purge of a library that held no items takes no hold", async () => {
      await seed();
      m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
      m.history.mockRejectedValue(new Error("down"));
      const before = (await serverRow()).watchHistorySyncedAt;

      await syncMediaServer(serverId, undefined, { trigger: "test: vanished, empty" });

      expect(await prisma.library.count({ where: { id: showsLibraryId } })).toBe(0);
      expect((await serverRow()).watchHistorySyncedAt).toEqual(before);
    });

    it("the vanished purge of a library that held items holds the server, and the same run releases it", async () => {
      await seed();
      await createTestMediaItem(showsLibraryId, { ratingKey: "e1", type: "SERIES", title: "Episode 1" });
      m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
      m.history.mockRejectedValue(new Error("down"));

      await syncMediaServer(serverId, undefined, { trigger: "test: vanished" });

      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      // The hold withdrew the marker, and the failed history phase did not
      // re-establish it.
      expect(row.watchHistorySyncedAt).toBeNull();
    });

    it("queues a mapped server's backfill when a full sync releases its hold", async () => {
      await seed({ mapped: true });
      await setHold(new Date(Date.now() - 60_000));

      // No history phase, so the only enqueue is the release's own.
      await syncMediaServer(serverId, undefined, { skipWatchHistory: true, trigger: "test: full" });

      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect(backfillEnqueues()).toEqual([
        [
          TASK_TRACEARR_BACKFILL,
          { serverId },
          expect.objectContaining({ jobKey: `tracearr-backfill:${serverId}` }),
        ],
      ]);
    });

    it("queues no backfill for an unmapped server's release", async () => {
      await seed();
      await setHold(new Date(Date.now() - 60_000));

      await syncMediaServer(serverId, undefined, { skipWatchHistory: true, trigger: "test: full" });

      expect((await serverRow()).libraryResyncRequiredAt).toBeNull();
      expect(backfillEnqueues()).toHaveLength(0);
    });
  });
});
