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

// The library-resync hold across real sync runs and real Postgres; only the media server and Tracearr are mocked.

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
const currentHold = async () => (await serverRow()).libraryResyncRequiredAt;
const currentMarker = async () => (await serverRow()).watchHistorySyncedAt;
/** Released, and a history pass established the marker again. */
async function expectReleasedAndEstablished() {
  const row = await serverRow();
  expect(row.libraryResyncRequiredAt).toBeNull();
  expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
}

const setHold = (at: Date | null) =>
  prisma.mediaServer.update({ where: { id: serverId }, data: { libraryResyncRequiredAt: at } });

const jobStatuses = async () =>
  (await prisma.syncJob.findMany({ where: { mediaServerId: serverId }, orderBy: { startedAt: "asc" } })).map(
    (j) => j.status,
  );

const backfillEnqueues = () =>
  m.enqueueJob.mock.calls.filter((args: unknown[]) => args[0] === TASK_TRACEARR_BACKFILL);

/** Back-date a library's items: one holding items older than a later hold is one the hold's cause left alone. */
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

async function purgeLibrary(libraryId: string) {
  setMockSession({ isLoggedIn: true, userId });
  await expectJson(
    await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId } }),
    200,
  );
}

/** Requests Stop on the running sync before every library page. */
function stopBeforePages() {
  m.beforePage = async () => {
    await prisma.syncJob.updateMany({
      where: { mediaServerId: serverId, status: "RUNNING" },
      data: { cancelRequested: true },
    });
  };
}

const expectWarned = (pattern: RegExp | string) =>
  expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
    "Sync",
    typeof pattern === "string" ? expect.stringContaining(pattern) : expect.stringMatching(pattern),
  );

async function inBackupDir(fn: (backups: typeof import("@/lib/backup/backup-service")) => Promise<void>) {
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-hold-restore-"));
  process.env.BACKUP_DIR = backupDir;
  try {
    await fn(await import("@/lib/backup/backup-service"));
  } finally {
    await fs.rm(backupDir, { recursive: true, force: true });
  }
}

/** A native Jellyfin server with established history; Movies holds one movie, Shows (listed with two episodes) none. */
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

  describe("with a hold set before the run", () => {
    // Older than every item `seed` creates, so the hold waits for both libraries.
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
        holdWhenHistoryFetched = await currentHold();
        return [play("m1"), play("e1", "bob")];
      });

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(holdWhenHistoryFetched).toBeNull();
      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      // Refused, had the release come after the history phase.
      expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
      expect(
        await prisma.watchHistory.count({ where: { mediaItem: { libraryId: showsLibraryId } } }),
      ).toBe(1);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });

    it("is not released when the server lists no libraries (an empty answer, not an error)", async () => {
      m.libraries = [];

      await syncMediaServer(serverId, undefined, { trigger: "test: empty listing" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toEqual(heldAt);
      // Its history phase ran, and still could not vouch for the server.
      expect(m.history).toHaveBeenCalled();
      expect(row.watchHistorySyncedAt).toBeNull();
      expect(await refusalReason()).toMatch(/run Sync on it under Settings → Servers/);
      expectWarned(
        /Keeping .*play-history hold — it waits for "Movies" \(this sync did not visit it.*"Shows" \(this sync did not visit it/,
      );
    });

    it("is not released while an enabled library went unsynced — enabled after the run read the disabled list", async () => {
      await prisma.library.update({ where: { id: showsLibraryId }, data: { enabled: false } });
      m.beforePage = async (key) => {
        if (key === "1") await prisma.library.update({ where: { id: showsLibraryId }, data: { enabled: true } });
      };

      await syncMediaServer(serverId, undefined, { trigger: "test: library enabled mid-run" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(await currentHold()).toEqual(heldAt);
      expectWarned(/it waits for "Shows" \(this sync did not visit it/);
    });

    it("is not released when a library came up short past the tolerance — and the stale purge is skipped", async () => {
      // 199 short of 200 is past max(50, 2%).
      await createTestMediaItem(moviesLibraryId, { ratingKey: "m-gone", type: "MOVIE", title: "Gone" });
      m.listings["1"] = { items: [movie("m1")], total: 200 };

      await syncMediaServer(serverId, undefined, { trigger: "test: truncated" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(await currentHold()).toEqual(heldAt);
      expect(await currentMarker()).toBeNull();
      expectWarned(/Keeping .*play-history hold.*"Movies"/);
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId, ratingKey: "m-gone" } })).toBe(1);
    });

    it("is released when a library came up short within the tolerance on two syncs in a row — with a warning, and still no stale purge", async () => {
      // 29 short of 30, the listing ended: within max(50, 2%).
      await createTestMediaItem(moviesLibraryId, { ratingKey: "m-gone", type: "MOVIE", title: "Gone" });
      m.listings["1"] = { items: [movie("m1")], total: 30 };

      // The first such pass may be a listing cut short just this once.
      await syncMediaServer(serverId, undefined, { trigger: "test: over-reported total" });
      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(await currentHold()).toEqual(heldAt);
      expectWarned(
        /Keeping .*"Movies" \(the server listed 1 of the 30 items it reported — within the tolerance .* counts as synced on the next full sync if that one comes up short within it too\)/,
      );

      // The second in a row is a server that over-reports.
      await syncMediaServer(serverId, undefined, { trigger: "test: over-reported total, again" });
      await expectReleasedAndEstablished();
      expectWarned('"Movies" (1 of 30) — within the tolerance for an over-reported total');
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId, ratingKey: "m-gone" } })).toBe(1);
    });

    it.each([
      [
        "a pass that stored no media",
        async () => {
          m.listings["2"] = { items: [{ ratingKey: "c1", title: "Box Set", type: "collection" }], total: 4 };
        },
      ],
      [
        "a listing that ended on an empty first page",
        async () => {
          await createTestMediaItem(showsLibraryId, { ratingKey: "e0", type: "SERIES", title: "Episode 0" });
          m.listings["2"] = { items: [], total: 3 };
        },
      ],
    ])("does not stretch the tolerance to %s", async (_, arrange) => {
      await arrange();

      await syncMediaServer(serverId, undefined, { trigger: "test: no tolerance" });

      expect(await currentHold()).toEqual(heldAt);
    });

    it("is not released when the server answered nothing for a library that holds rows ('refusing to wipe')", async () => {
      m.listings["1"] = { items: [], total: 0 };

      await syncMediaServer(serverId, undefined, { trigger: "test: refusing to wipe" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);
      expect(await currentHold()).toEqual(heldAt);
    });

    it("is not released by a library-scoped sync, though that completes — not even of the server's only library", async () => {
      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: scoped" });
      await syncMediaServer(serverId, "1", { skipWatchHistory: true, trigger: "test: scoped" });

      expect(await jobStatuses()).toEqual(["COMPLETED", "COMPLETED"]);
      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(2);
      expect(await currentHold()).toEqual(heldAt);

      // Scoped runs skip the vanished-library purge, so they cannot vouch for the library list.
      await prisma.library.delete({ where: { id: showsLibraryId } });
      m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
      await syncMediaServer(serverId, "1", { trigger: "test: scoped, single library" });
      expect(await jobStatuses()).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
      expect(await currentHold()).toEqual(heldAt);
    });

    it("is not released by a full sync that was stopped, or that failed", async () => {
      stopBeforePages();
      await syncMediaServer(serverId, undefined, { trigger: "test: stopped" });
      expect(await jobStatuses()).toEqual(["CANCELLED"]);
      expect(await currentHold()).toEqual(heldAt);

      m.beforePage = async (key) => {
        if (key === "2") throw new Error("server went away");
      };
      await expect(syncMediaServer(serverId, undefined, { trigger: "test: failed" })).rejects.toThrow(
        "server went away",
      );
      expect(await jobStatuses()).toEqual(["CANCELLED", "FAILED"]);
      expect(await currentHold()).toEqual(heldAt);
    });

    it("is not released by a run whose library pass began before a newer hold request — the next full sync releases it", async () => {
      // The run may have passed the purged library before its items were deleted; the column keeps the earlier hold.
      m.beforePage = async () => {
        m.beforePage = null;
        await requireLibraryResync([serverId]);
      };

      await syncMediaServer(serverId, undefined, { trigger: "test: overlapping purge" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(await currentHold()).toEqual(heldAt);
      expect(await currentMarker()).toBeNull();
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        "Sync",
        expect.stringContaining("it was requested again after this sync began its library pass"),
      );

      await syncMediaServer(serverId, undefined, { trigger: "test: next full sync" });
      await expectReleasedAndEstablished();
    });

    it("a listing that omits a library purges it as vanished — and when it comes back, it is held again", async () => {
      // Safe to release: the library can only come back as a NEW library, whose population takes a fresh hold.
      m.libraries = [{ key: "1", title: "Movies", type: "movie" }];

      await syncMediaServer(serverId, undefined, { trigger: "test: library omitted" });

      expect(await prisma.library.count({ where: { id: showsLibraryId } })).toBe(0);
      expect(await currentHold()).toBeNull();

      m.libraries = [
        { key: "1", title: "Movies", type: "movie" },
        { key: "2", title: "Shows", type: "show" },
      ];
      m.bulkListingIncomplete = true;
      let holdWhileRepopulating: Date | null | undefined;
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey === "e1") holdWhileRepopulating = await currentHold();
      };

      await syncMediaServer(serverId, undefined, { trigger: "test: library back" });

      expect(holdWhileRepopulating).toBeInstanceOf(Date);
      expect(await currentHold()).toBeNull();
    });
  });

  describe("a native server", () => {
    beforeEach(async () => {
      await seed();
    });

    it("after a purge, a history sync before the re-sync cannot vouch; a scoped sync keeps the hold; a full sync clears it", async () => {
      await prisma.watchHistory.create({
        data: {
          mediaItemId: (await prisma.mediaItem.findFirstOrThrow({ where: { libraryId: moviesLibraryId } })).id,
          mediaServerId: serverId,
          serverUsername: "alice",
          watchedAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      });
      await purgeLibrary(moviesLibraryId);
      expect(await currentHold()).toBeInstanceOf(Date);
      expect(await currentMarker()).toBeNull();

      // A native full replace before the items are back finds the plays but not their movie.
      const refresh = await syncWatchHistory(serverId);
      expect(refresh.failed).toBeUndefined();
      expect(await currentMarker()).toBeNull();
      expect(await refusalReason()).toMatch(/run Sync on it under Settings → Servers/);

      // The by-type fan-out (or a retried library job) re-adds the library, scoped: still held.
      await syncMediaServer(serverId, "1", { skipWatchHistory: true, trigger: "test: by-type" });
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);
      expect(await currentHold()).toBeInstanceOf(Date);
      await syncWatchHistory(serverId);
      expect(await currentMarker()).toBeNull();

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      await expectReleasedAndEstablished();
      expect(
        await prisma.watchHistory.count({ where: { mediaItem: { libraryId: moviesLibraryId } } }),
      ).toBe(1);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });
  });

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
      expect(seen!.items).toBe(0);
      expect(seen!.hold).toBeInstanceOf(Date);
      // At the run's own pass start, so the run can release it.
      expect(seen!.hold!.getTime()).toBeGreaterThanOrEqual(seen!.startedAt.getTime());
      expect(seen!.marker).toBeNull();
      await expectReleasedAndEstablished();
      expect(await prisma.watchHistory.count({ where: { mediaItem: { libraryId: showsLibraryId } } })).toBe(1);
    });

    it.each<[string, () => unknown, (() => Promise<void>)?]>([
      [
        "a library the server lists as empty",
        () => {
          m.listings["2"] = { items: [] };
        },
      ],
      [
        "a library that already held items",
        () => createTestMediaItem(showsLibraryId, { ratingKey: "e1", type: "SERIES", title: "Episode 1" }),
        async () => expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(2),
      ],
      [
        "a page of nothing but containers",
        () => {
          m.listings["2"] = { items: [{ ratingKey: "c1", title: "Box Set", type: "collection" }] };
        },
      ],
      [
        "the vanished purge of a library that held no items",
        () => {
          m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
        },
        async () => expect(await prisma.library.count({ where: { id: showsLibraryId } })).toBe(0),
      ],
    ])("is not taken for %s — an established marker is left alone", async (_, arrange, check) => {
      await arrange();
      // A failing history phase leaves the marker as the sync found it, unless a hold withdrew it.
      m.history.mockRejectedValue(new Error("down"));
      const before = await currentMarker();

      await syncMediaServer(serverId, undefined, { trigger: "test: no population hold" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(await currentMarker()).toEqual(before);
      expect(await currentHold()).toBeNull();
      await check?.();
    });

    it("restarts a mapped server's Tracearr walk, so it reads the new library's plays — and the editor and guard name that import, not a Refresh", async () => {
      await cleanDatabase();
      await seed({ mapped: true });
      const before = Date.now();

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      let row = await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });
      expect(row.tracearrBackfillComplete).toBe(false);
      expect(row.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(row.tracearrForwardWatermarkAt).toEqual(row.tracearrBackfillCursorAt);
      expect(row.tracearrBackfillLastWalkAt).toBeNull();
      // The run wrote that hold and synced the library, so it released it and queued the walk.
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(backfillEnqueues()).toEqual([
        [
          TASK_TRACEARR_BACKFILL,
          { serverId },
          expect.objectContaining({ jobKey: `tracearr-backfill:${serverId}` }),
        ],
      ]);
      // Only the restarted walk's completion establishes the marker again.
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

  describe("a library-scoped run's own population hold", () => {
    beforeEach(async () => {
      await seed();
    });

    it("enable a library, Sync Now: released by that run, whose history phase establishes the marker — and again for the next library", async () => {
      m.bulkListingIncomplete = true;
      let holdDuringRun: Date | null | undefined;
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey === "e1") holdDuringRun = await currentHold();
      };

      await syncMediaServer(serverId, "2", { trigger: "test: Sync Now, Shows" });

      expect(await jobStatuses()).toEqual(["COMPLETED"]);
      expect(holdDuringRun).toBeInstanceOf(Date);
      await expectReleasedAndEstablished();
      expect(await prisma.watchHistory.count({ where: { mediaItem: { libraryId: showsLibraryId } } })).toBe(1);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });

      // The release forgot its request, so the next library's population gets a receipt too.
      m.bulkListingIncomplete = false;
      m.beforeEnrich = null;
      const kids = await createTestLibrary(serverId, { key: "3", title: "Kids", type: "MOVIE" });
      m.libraries.push({ key: "3", title: "Kids", type: "movie" });
      m.listings["3"] = { items: [movie("k1")] };
      await syncMediaServer(serverId, "3", { trigger: "test: Sync Now, Kids" });
      expect(await prisma.mediaItem.count({ where: { libraryId: kids.id } })).toBe(1);
      await expectReleasedAndEstablished();
    });

    it("by-type style (no history step): released, the marker stays null until a later history sync", async () => {
      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.watchHistorySyncedAt).toBeNull();
      expect(await refusalReason()).toMatch(/no sync has established/);

      // The fan-out's follow-up history job.
      await syncWatchHistory(serverId);
      expect(await currentMarker()).toBeInstanceOf(Date);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });

    it("does not release an earlier purge's hold — only a full sync does", async () => {
      const purgedAt = new Date(Date.now() - 60_000);
      await setHold(purgedAt);

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(2);
      expect(await currentHold()).toEqual(purgedAt);
      await syncWatchHistory(serverId);
      expect(await currentMarker()).toBeNull();

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      await expectReleasedAndEstablished();
    });

    it("does not release when a purge landed mid-run before the population", async () => {
      // The population then finds a hold in place and writes none of its own.
      let purgeHold: Date | null = null;
      m.beforePage = async (key) => {
        if (key !== "2" || purgeHold) return;
        await requireLibraryResync([serverId]);
        purgeHold = await currentHold();
      };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(purgeHold).toBeInstanceOf(Date);
      expect(await currentHold()).toEqual(purgeHold);
    });

    it("does not release when a purge landed mid-run after the population — even at the hold's own instant", async () => {
      // Same instant, so the column is unchanged: only the withdrawal the purge counted tells them apart.
      m.bulkListingIncomplete = true;
      let ownHold: Date | null = null;
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey !== "e1" || ownHold) return;
        ownHold = await currentHold();
        await requireLibraryResync([serverId], { at: ownHold! });
      };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(ownHold).toBeInstanceOf(Date);
      expect(await currentHold()).toEqual(ownHold);
    });

    it("does not release when a real purge of another library landed mid-run after the population", async () => {
      m.bulkListingIncomplete = true;
      let purged = false;
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey !== "e1" || purged) return;
        purged = true;
        await purgeLibrary(moviesLibraryId);
      };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(purged).toBe(true);
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(0);
      expect(await currentHold()).toBeInstanceOf(Date);
    });

    it("keeps it when its library came up short past the tolerance, and says why", async () => {
      m.listings["2"] = { items: [episode("e1", 1), episode("e2", 2)], total: 300 };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(await currentHold()).toBeInstanceOf(Date);
      expectWarned(/Keeping .*play-history hold.*"Shows"/);
    });

    it("keeps it on a first pass within the tolerance; the next full sync that comes up short within it too releases it", async () => {
      m.listings["2"] = { items: [episode("e1", 1), episode("e2", 2)], total: 12 };

      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type" });

      expect(await currentHold()).toBeInstanceOf(Date);
      expectWarned(/Keeping .*"Shows" \(the server listed 2 of the 12 items it reported/);

      // Movies holds an item older than the hold: the hold does not wait for it.
      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      expect(await currentHold()).toBeNull();
      expectWarned('"Shows" (2 of 12) — within the tolerance');
    });

    it("a full run releases its own population hold although a library the hold does not wait for came up short", async () => {
      // Movies' item predates the hold (past the minute's margin): its shortfall says nothing about it.
      await ageItems(moviesLibraryId);
      m.listings["1"] = { items: [movie("m1")], total: 400 };

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });

      await expectReleasedAndEstablished();
    });
  });

  // A hold waits for the libraries holding no item created before it; one holding an older item was left alone.
  describe("which libraries a hold waits for", () => {
    beforeEach(async () => {
      await seed();
    });

    it("a library listed as empty while it holds older items no longer keeps a population hold — released by the first full sync, and every one after", async () => {
      // Movies holds a row the server lists as empty ("refusing to wipe" every sync); Shows is new.
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
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);
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
      expect(await currentHold()).toBeNull();

      // Far short: 1 of 400 listed.
      m.beforePage = null;
      await setHold(new Date(Date.now() - 1_000));
      m.listings["1"] = { items: [movie("m1")], total: 400 };
      await syncMediaServer(serverId, undefined, { trigger: "test: untouched library far short" });
      expect(await currentHold()).toBeNull();
    });

    it("a by-type job that failed half way keeps its hold through its retry and a later purge request, until a full sync completes the library", async () => {
      // Moved to the purge's instant, the hold would make Shows' episodes read as untouched, and a short Shows release.
      const episodes = Array.from({ length: 600 }, (_, i) => episode(`e${i}`, i + 1));
      m.listings["2"] = { items: episodes };
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
      const populationHold = await currentHold();
      expect(populationHold).toBeInstanceOf(Date);
      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(500);
      await syncWatchHistory(serverId); // the fan-out's follow-up, run before the retry
      expect(await currentMarker()).toBeNull();

      // No longer empty: the retry takes no hold, so it has no receipt to release the first attempt's with.
      await syncMediaServer(serverId, "2", { skipWatchHistory: true, trigger: "test: by-type, retry" });
      expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(600);
      await syncWatchHistory(serverId);
      expect(await currentHold()).toEqual(populationHold);
      expect(await currentMarker()).toBeNull();

      await purgeLibrary(moviesLibraryId);
      expect(await currentHold()).toEqual(populationHold);

      // Movies comes back complete; Shows lists only its first 500 of 600.
      m.listings["2"] = { items: episodes.slice(0, 500), total: 600 };
      await syncMediaServer(serverId, undefined, { trigger: "test: full, Shows short" });
      expect(await currentHold()).toEqual(populationHold);
      expectWarned(/Keeping .*it waits for "Shows" \(the server listed 500 of the 600 items/);

      m.listings["2"] = { items: episodes };
      await syncMediaServer(serverId, undefined, { trigger: "test: full, complete" });
      await expectReleasedAndEstablished();
    });

    it("a library the hold waits for blocks when the server answers nothing for its rows — rows a minute before the hold included", async () => {
      // A row is dated before its INSERT runs, so a purge racing an upsert leaves rows just older than its hold.
      const hold = new Date(Date.now() - 60_000);
      await setHold(hold);
      m.listings["1"] = { items: [], total: 0 };
      const dateMovies = (msBeforeHold: number) =>
        prisma.mediaItem.updateMany({
          where: { libraryId: moviesLibraryId },
          data: { createdAt: new Date(hold.getTime() - msBeforeHold) },
        });

      await syncMediaServer(serverId, undefined, { trigger: "test: awaited library refused" });
      expect(await currentHold()).toEqual(hold);
      expectWarned(
        /Keeping .*it waits for "Movies" \(server returned 0 items for a library that previously had 1 — refusing to wipe it\)/,
      );

      await dateMovies(10_000);
      await syncMediaServer(serverId, undefined, { trigger: "test: rows inside the margin" });
      expect(await currentHold()).toEqual(hold);

      // Two minutes older is a library the hold's cause left alone.
      await dateMovies(120_000);
      await syncMediaServer(serverId, undefined, { trigger: "test: rows outside the margin" });
      expect(await currentHold()).toBeNull();
    });

    it("an empty first page with no reported total ends the listing: a library holding rows refuses to be wiped and blocks, an empty one counts as synced", async () => {
      const hold = new Date(Date.now() - 60_000);
      await setHold(hold);
      m.listings = { "1": { items: [], total: null }, "2": { items: [], total: null } };

      await syncMediaServer(serverId, undefined, { trigger: "test: empty, no total, rows held" });

      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);
      expect(await currentHold()).toEqual(hold);
      expectWarned(/Keeping .*"Movies" \(server returned 0 items .* refusing to wipe it\)/);

      m.listings["1"] = { items: [movie("m1")] };
      await syncMediaServer(serverId, undefined, { trigger: "test: empty, no total" });
      expect(await currentHold()).toBeNull();
    });
  });

  describe("a shortfall within the tolerance", () => {
    beforeEach(async () => {
      await seed();
    });

    const sighting = async () =>
      (await prisma.library.findUniqueOrThrow({ where: { id: moviesLibraryId } })).shortPassSeenAt;

    it("two short syncs release across a restart: the sighting is kept on the library row, not in memory", async () => {
      const hold = new Date(Date.now() - 60_000);
      await setHold(hold);
      m.listings["1"] = { items: [movie("m1")], total: 30 };

      await syncMediaServer(serverId, undefined, { trigger: "test: short" });
      expect(await currentHold()).toEqual(hold);
      expect(await sighting()).toBeInstanceOf(Date);

      // A restart: nothing this process remembered survives it.
      _resetLibraryResyncHoldRequestsForTesting();
      vi.resetModules();
      const { syncMediaServer: syncAfterRestart } = await import("@/lib/sync/sync-server");
      await syncAfterRestart(serverId, undefined, { trigger: "test: short, after a restart" });
      expect(await currentHold()).toBeNull();
    });

    it("a sighting recorded before a purge never counts toward the hold the purge took", async () => {
      // A purge, then a re-sync cut short to 11 of 61: within the tolerance, but 50 items missing.
      const all = Array.from({ length: 60 }, (_, i) => movie(`m${i + 1}`));
      m.listings["1"] = { items: all, total: 61 };
      await ageItems(moviesLibraryId);
      await syncMediaServer(serverId, undefined, { trigger: "test: steady state" });
      expect(await currentHold()).toBeNull();
      await prisma.library.update({ where: { id: moviesLibraryId }, data: { shortPassSeenAt: new Date() } });

      await purgeLibrary(moviesLibraryId);
      const hold = await currentHold();
      expect(hold).toBeInstanceOf(Date);

      m.listings["1"] = { items: all.slice(0, 11), total: 61 };
      await syncMediaServer(serverId, undefined, { trigger: "test: truncated re-sync" });
      expect(await currentHold()).toEqual(hold);
      expect(await refusalReason()).toMatch(/waits for a complete library sync/);
    });

    it("...the purge itself clears it, for a library something re-adds an item to before the next full sync", async () => {
      // A realtime add lands in the purged library first, so the full sync's pass does not start on an empty library.
      m.listings["1"] = { items: [movie("m1")], total: 1 };
      await prisma.library.update({ where: { id: moviesLibraryId }, data: { shortPassSeenAt: new Date() } });
      await purgeLibrary(moviesLibraryId);
      expect(await sighting()).toBeNull();
      const hold = await currentHold();
      await createTestMediaItem(moviesLibraryId, { ratingKey: "m-new", type: "MOVIE", title: "Just Added" });

      m.listings["1"] = { items: [movie("m-new")], total: 30 };
      await syncMediaServer(serverId, undefined, { trigger: "test: short, after a realtime add" });

      expect(await currentHold()).toEqual(hold);
    });

    it("...and a pass that starts on an empty library clears one a purge did not (here: items deleted directly)", async () => {
      await prisma.library.update({ where: { id: moviesLibraryId }, data: { shortPassSeenAt: new Date() } });
      await requireLibraryResync([serverId]);
      const hold = await currentHold();
      await prisma.mediaItem.deleteMany({ where: { libraryId: moviesLibraryId } });

      m.listings["1"] = { items: [movie("m1")], total: 30 };
      await syncMediaServer(serverId, undefined, { trigger: "test: short refill" });

      expect(await currentHold()).toEqual(hold);
      // ...and the refill's own sighting is what the next pass counts.
      await syncMediaServer(serverId, undefined, { trigger: "test: short again" });
      expect(await currentHold()).toBeNull();
    });

    it("a pass a purge of its library lands during records no sighting, so one short pass after the purge cannot release", async () => {
      // The straddling race: a pass whose first batch a purge deleted must not record a sighting at its end.
      const all = Array.from({ length: 60 }, (_, i) => movie(`m${i + 1}`));
      m.listings = { "1": { items: all, total: 61 }, "2": { items: [] } };
      m.bulkListingIncomplete = true;
      await ageItems(moviesLibraryId);
      await syncMediaServer(serverId, undefined, { trigger: "test: steady state" });
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(60);
      await ageItems(moviesLibraryId);

      await purgeLibrary(moviesLibraryId);
      const hold = await currentHold();
      expect(hold).toBeInstanceOf(Date);

      // The first re-sync after the purge: 60 of 61, a first sighting.
      await syncMediaServer(serverId, undefined, { trigger: "test: re-sync" });
      expect(await currentHold()).toEqual(hold);
      expect(await sighting()).toBeInstanceOf(Date);

      // The next one: Movies is purged again after its first batch (50 items) was written.
      m.beforeEnrich = async (ratingKey) => {
        if (ratingKey !== "m51") return;
        m.beforeEnrich = null;
        await purgeLibrary(moviesLibraryId);
      };
      await syncMediaServer(serverId, undefined, { trigger: "test: re-sync across a purge" });
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(10);
      expect(await currentHold()).toEqual(hold);
      expect(await sighting()).toBeNull();

      // Then a listing cut short just this once, within the tolerance (15 of 61).
      m.listings["1"] = { items: all.slice(0, 15), total: 61 };
      await syncMediaServer(serverId, undefined, { trigger: "test: truncated re-sync" });
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(25);
      expect(await currentHold()).toEqual(hold);
      expect(await refusalReason()).toMatch(/waits for a complete library sync/);
    });

    it("a newly enabled library whose listing comes up short of its total needs a full sync: Sync Now cannot release its own hold", async () => {
      // Only the populating pass holds the receipt, and a short pass counts only as the second in a row.
      await ageItems(moviesLibraryId);
      m.listings["2"] = { items: [] };
      await syncMediaServer(serverId, undefined, { trigger: "test: steady state" });
      expect(await currentHold()).toBeNull();
      const fresh = await createTestLibrary(serverId, { key: "3", title: "New", type: "MOVIE" });
      m.libraries.push({ key: "3", title: "New", type: "movie" });
      m.listings["3"] = { items: Array.from({ length: 59 }, (_, i) => movie(`n${i}`)), total: 60 };

      await syncMediaServer(serverId, "3", { trigger: "test: Sync Now #1" });
      const hold = await currentHold();
      expect(hold).toBeInstanceOf(Date);
      expect(await prisma.mediaItem.count({ where: { libraryId: fresh.id } })).toBe(59);
      await syncMediaServer(serverId, "3", { trigger: "test: Sync Now #2" });
      expect(await currentHold()).toEqual(hold);
      await syncMediaServer(serverId, "3", { trigger: "test: Sync Now #3" });
      expect(await currentHold()).toEqual(hold);

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      await expectReleasedAndEstablished();
    });

    it("a purged library re-synced 10 of 60 keeps the hold, and the 50 brought back later still wait for a full sync", async () => {
      // Released at the first sight, the 50 came back through the lifecycle re-sync and read as never watched.
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
      await purgeLibrary(moviesLibraryId);

      m.listings = { "1": { items: all.slice(0, 10), total: 60 } };
      await syncMediaServer(serverId, undefined, { trigger: "test: truncated re-sync" });
      expect(await currentHold()).toBeInstanceOf(Date);
      expect(await refusalReason()).toMatch(/waits for a complete library sync/);

      m.listings = { "1": { items: all } };
      await syncMediaServer(serverId, "1", {
        skipWatchHistory: true,
        trigger: "lifecycle execution: re-sync after destructive actions",
      });
      expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(60);
      expect(await currentHold()).toBeInstanceOf(Date);
      expect(await refusalReason()).toMatch(/waits for a complete library sync/);

      await syncMediaServer(serverId, undefined, { trigger: "test: full" });
      expect(await currentHold()).toBeNull();
      expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId } })).toBe(60);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });
  });

  describe("flows", () => {
    it("purging a disabled library holds nothing: the next history sync re-establishes the marker", async () => {
      // Nothing re-adds a disabled library's items, so a hold would only pause the rules until a full sync.
      await seed();
      const kids = await createTestLibrary(serverId, { key: "3", title: "Kids", type: "MOVIE" });
      await createTestMediaItem(kids.id, { ratingKey: "k1", type: "MOVIE", title: "Kid movie" });
      await prisma.library.update({ where: { id: kids.id }, data: { enabled: false } });

      await purgeLibrary(kids.id);
      expect(await currentHold()).toBeNull();
      expect(await currentMarker()).toBeNull();

      await syncWatchHistory(serverId);
      expect(await currentMarker()).toBeInstanceOf(Date);
      await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    });

    it("a restore that undoes a purge holds the server until a full sync, which leaves no request behind: enabling a library and Sync Now then releases its own hold", async () => {
      await inBackupDir(async ({ createBackup, restoreBackup }) => {
        await seed();
        const file = await createBackup(undefined, false);
        await purgeLibrary(moviesLibraryId);
        expect(await currentHold()).toBeInstanceOf(Date);

        const restoredAt = Date.now();
        await restoreBackup(file);
        const held = await serverRow();
        expect(held.libraryResyncRequiredAt!.getTime()).toBeGreaterThanOrEqual(restoredAt - 5);
        expect(held.watchHistorySyncedAt).toBeNull();
        expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(1);

        await syncMediaServer(serverId, undefined, { trigger: "test: full sync after the restore" });
        await expectReleasedAndEstablished();

        const kids = await createTestLibrary(serverId, { key: "3", title: "Kids", type: "MOVIE" });
        m.libraries.push({ key: "3", title: "Kids", type: "movie" });
        m.listings["3"] = { items: [movie("k1")] };
        await syncMediaServer(serverId, "3", { trigger: "test: Sync Now after enabling" });
        expect(await prisma.mediaItem.count({ where: { libraryId: kids.id } })).toBe(1);
        await expectReleasedAndEstablished();
      });
    });

    it("a FULL backup's restore holds the server too, and the next full sync releases it whatever it can list: every library holds the file's items", async () => {
      // Every restored library holds items older than the hold, so it waits for none (Shows even lists empty).
      await inBackupDir(async ({ createBackup, restoreBackup }) => {
        await seed();
        await syncMediaServer(serverId, undefined, { trigger: "test: steady state" });
        expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(2);
        await ageItems(moviesLibraryId);
        await ageItems(showsLibraryId);
        const file = await createBackup(undefined, false);

        await restoreBackup(file);
        const held = await serverRow();
        expect(held.libraryResyncRequiredAt).toBeInstanceOf(Date);
        expect(held.watchHistorySyncedAt).toBeNull();
        // No history pass vouches for it before that sync.
        await syncWatchHistory(serverId);
        expect(await currentMarker()).toBeNull();
        expect(await refusalReason()).toMatch(/waits for a complete library sync/);

        m.listings["2"] = { items: [], total: 0 };
        await syncMediaServer(serverId, undefined, { trigger: "test: full sync after the restore" });
        expect(await prisma.mediaItem.count({ where: { libraryId: showsLibraryId } })).toBe(2);
        await expectReleasedAndEstablished();
        await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
      });
    });
  });

  describe("regressions", () => {
    it("a full sync with no hold re-establishes the marker through its history phase as before", async () => {
      await seed();
      m.listings["2"] = { items: [] };
      const before = (await currentMarker())!;

      await syncMediaServer(serverId, undefined, { trigger: "test: plain" });

      const after = (await currentMarker())!;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
      expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId } })).toBe(1);
    });

    it("the lifecycle executor's scoped re-sync of a populated library still works and takes no hold", async () => {
      await seed();
      m.listings["1"] = { items: [movie("m1", "Renamed")] };
      const before = await currentMarker();

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

    it("the vanished purge of a library that held items holds the server, and the same run releases it", async () => {
      await seed();
      await createTestMediaItem(showsLibraryId, { ratingKey: "e1", type: "SERIES", title: "Episode 1" });
      m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
      m.history.mockRejectedValue(new Error("down"));

      await syncMediaServer(serverId, undefined, { trigger: "test: vanished" });

      const row = await serverRow();
      expect(row.libraryResyncRequiredAt).toBeNull();
      // The hold withdrew the marker, and the failed history phase did not re-establish it.
      expect(row.watchHistorySyncedAt).toBeNull();
    });

    it.each([
      [true, 1],
      [false, 0],
    ])("a full sync releasing the hold of a server mapped=%s queues %i backfill", async (mapped, queued) => {
      await seed({ mapped });
      await setHold(new Date(Date.now() - 60_000));

      // No history phase, so the only enqueue is the release's own.
      await syncMediaServer(serverId, undefined, { skipWatchHistory: true, trigger: "test: full" });

      expect(await currentHold()).toBeNull();
      expect(backfillEnqueues()).toEqual(
        Array.from({ length: queued }, () => [
          TASK_TRACEARR_BACKFILL,
          { serverId },
          expect.objectContaining({ jobKey: `tracearr-backfill:${serverId}` }),
        ]),
      );
    });
  });
});
