import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

/**
 * The restart hold on a Tracearr archive walk, end to end against real
 * Postgres: `restartTracearrBackfill` records it, the importer holds the
 * backfill pass while it is set, and only a FULL, unscoped `syncMediaServer`
 * run that began its library pass after the restart and completed releases it.
 *
 * The hold exists because every restart follows the deletion of items whose
 * plays the restarted walk is for. Released by the wrong sync — a library-
 * scoped one, or one already past the purged library — the walk runs with
 * those items still missing, skips their plays as unresolved, and can complete
 * without them for good: the items come back reading as never watched.
 *
 * The media server and Tracearr are mocked; the sync engine, the importer, the
 * watch-history sync and every SQL statement are real.
 */

const TRACEARR_SERVER_ID = "11111111-2222-3333-4444-555555555555";

const m = vi.hoisted(() => ({
  getHistoryPage: vi.fn(),
  listServers: vi.fn(),
  getServerAccountNames: vi.fn(),
  findOldestPlayAt: vi.fn(),
  enqueueJob: vi.fn(),
  // A hook into the server listing of the library pass, for "a purge lands
  // while this sync is running" and "Stop is pressed mid-run".
  duringLibraryPass: null as null | (() => Promise<void>),
  libraries: [] as Array<{ key: string; title: string; type: string }>,
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
  createMediaServerClient: vi.fn(() => ({
    testConnection: vi.fn(async () => ({ ok: true, serverName: "Test Server" })),
    getLibraries: vi.fn(async () => m.libraries),
    getWatchCounts: vi.fn(async () => new Map()),
    getLibraryShows: vi.fn(async () => []),
    getLibraryItemsPage: vi.fn(async () => {
      if (m.duringLibraryPass) await m.duringLibraryPass();
      // Nothing listed: the sync's "server returned nothing" guard keeps the
      // stored items, which is all these tests need from the library pass.
      return { items: [], total: 0 };
    }),
  })),
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
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { restartTracearrBackfill } from "@/lib/media/watch-evidence";
import { TASK_TRACEARR_BACKFILL } from "@/lib/jobs/constants";

const prisma = getTestPrisma();

function record(id: string, startedAt: string, ratingKey = "100") {
  return {
    id,
    reference_id: id,
    server_id: TRACEARR_SERVER_ID,
    media_type: "movie",
    rating_key: ratingKey,
    started_at: startedAt,
    stopped_at: startedAt,
    state: "stopped",
    watched: true,
    user: { id: "u", server_user_id: "acct-1", username: "Walter W" },
  };
}

let serverId: string;

async function serverRow() {
  return prisma.mediaServer.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      tracearrBackfillRestartedAt: true,
      tracearrBackfillCursorAt: true,
      tracearrBackfillComplete: true,
      tracearrBackfillLastWalkAt: true,
    },
  });
}

/** Whether the backfill pass is held: a slice asks Tracearr nothing. */
async function sliceIsHeld(): Promise<boolean> {
  m.getHistoryPage.mockClear();
  const result = await syncTracearrHistory(serverId, { passes: "backfill" });
  const held = m.getHistoryPage.mock.calls.length === 0;
  if (held) expect(result).toMatchObject({ heldReason: "awaiting-resync", backfillPending: true });
  return held;
}

function backfillEnqueues() {
  return m.enqueueJob.mock.calls.filter((args) => args[0] === TASK_TRACEARR_BACKFILL);
}

describe("Tracearr restart hold (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    m.duringLibraryPass = null;
    m.libraries = [
      { key: "1", title: "Movies", type: "movie" },
      { key: "2", title: "Shows", type: "show" },
    ];
    m.enqueueJob.mockResolvedValue(true);
    const user = await createTestUser();
    const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_ID });
    serverId = server.id;
    const movies = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    await createTestMediaItem(movies.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" });
    // The library a purge emptied — a SERIES library with nothing in it.
    await createTestLibrary(server.id, { key: "2", type: "SERIES" });
    await prisma.tracearrInstance.create({
      data: { userId: user.id, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    m.findOldestPlayAt.mockResolvedValue(null);
    m.getHistoryPage.mockResolvedValue({ records: [], nextCursor: null });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("records the restart and holds the walk", async () => {
    const before = Date.now();
    await restartTracearrBackfill([serverId]);

    const row = await serverRow();
    expect(row.tracearrBackfillRestartedAt!.getTime()).toBeGreaterThanOrEqual(before);
    // The cursor is moved to the same instant: the walk restarts from the top.
    expect(row.tracearrBackfillCursorAt).toEqual(row.tracearrBackfillRestartedAt);
    expect(await sliceIsHeld()).toBe(true);
    // A held slice writes nothing: no walk stamp, no cursor move.
    expect(await serverRow()).toEqual(row);
  });

  it("is not released by a library-scoped sync, though that writes a COMPLETED SyncJob", async () => {
    // Purge SERIES → the lifecycle executor's post-delete re-sync of the MOVIE
    // library (or a by-type MOVIE job) completes. The SERIES library is still
    // empty; released here, the walk skipped every one of its plays.
    await restartTracearrBackfill([serverId]);

    await syncMediaServer(serverId, "1", { skipWatchHistory: true, trigger: "test: scoped" });

    expect(await prisma.syncJob.count({ where: { mediaServerId: serverId, status: "COMPLETED" } })).toBe(1);
    expect((await serverRow()).tracearrBackfillRestartedAt).not.toBeNull();
    expect(await sliceIsHeld()).toBe(true);
  });

  it("is not released by a full sync whose library pass began before the restart", async () => {
    // The purge lands while a full sync is already in its library pass — it
    // may have passed the purged library before its items were deleted.
    m.duringLibraryPass = async () => {
      m.duringLibraryPass = null;
      await restartTracearrBackfill([serverId]);
    };

    await syncMediaServer(serverId, undefined, { trigger: "test: full, overlapping" });

    expect(await prisma.syncJob.count({ where: { mediaServerId: serverId, status: "COMPLETED" } })).toBe(1);
    expect((await serverRow()).tracearrBackfillRestartedAt).not.toBeNull();
    expect(await sliceIsHeld()).toBe(true);

    // The NEXT full sync, begun after it, releases it.
    await syncMediaServer(serverId, undefined, { trigger: "test: full, after" });
    expect((await serverRow()).tracearrBackfillRestartedAt).toBeNull();
  });

  it("is released by a full sync begun after the restart, and the next slice walks from the restart", async () => {
    await restartTracearrBackfill([serverId]);
    const restartedCursor = (await serverRow()).tracearrBackfillCursorAt!;

    await syncMediaServer(serverId, undefined, { trigger: "test: full" });

    const row = await serverRow();
    expect(row.tracearrBackfillRestartedAt).toBeNull();
    // The cursor is untouched by the sync: the walk resumes at the restart.
    expect(row.tracearrBackfillCursorAt).toEqual(restartedCursor);
    // The slice is queued (the watch-history phase, and the release itself),
    // under the one shared key, and it walks when it runs.
    expect(backfillEnqueues().length).toBeGreaterThan(0);
    for (const call of backfillEnqueues()) {
      expect(call[2]).toMatchObject({ jobKey: `tracearr-backfill:${serverId}` });
    }
    m.getHistoryPage.mockResolvedValueOnce({
      records: [record("chain-1", "2025-01-01T00:00:00.000Z")],
      nextCursor: null,
    });
    const result = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(m.getHistoryPage).toHaveBeenCalledTimes(1);
    expect(m.getHistoryPage.mock.calls[0][1].until).toEqual(restartedCursor);
    expect(result.heldReason).toBeUndefined();
    expect(result).toMatchObject({ backfillPending: false, backfillOutcome: "exhausted" });
    expect(await prisma.watchHistory.count({ where: { source: "TRACEARR" } })).toBe(1);
  });

  it("is released by the full sync whose own vanished-library purge restarted the walk", async () => {
    // The server no longer lists library 2; the purge cascades a Tracearr play
    // and restarts the walk mid-run. Every library this run then syncs, it
    // syncs after that restart, so the run covers it.
    const shows = await prisma.library.findFirstOrThrow({ where: { mediaServerId: serverId, key: "2" } });
    const episode = await createTestMediaItem(shows.id, { ratingKey: "200", type: "SERIES", title: "Pilot" });
    await prisma.watchHistory.create({
      data: {
        mediaItemId: episode.id,
        mediaServerId: serverId,
        serverUsername: "walter",
        watchedAt: new Date("2025-01-01T00:00:00.000Z"),
        source: "TRACEARR",
        sourceEventId: "old-chain",
      },
    });
    m.libraries = [{ key: "1", title: "Movies", type: "movie" }];

    await syncMediaServer(serverId, undefined, { trigger: "test: full with vanished library" });

    const row = await serverRow();
    expect(await prisma.library.count({ where: { mediaServerId: serverId, key: "2" } })).toBe(0);
    // Restarted (cursor moved to now) and released by the same run.
    expect(row.tracearrBackfillCursorAt).not.toBeNull();
    expect(row.tracearrBackfillRestartedAt).toBeNull();
    expect(await sliceIsHeld()).toBe(false);
  });

  it("is not released by a full sync that was stopped", async () => {
    await restartTracearrBackfill([serverId]);
    m.duringLibraryPass = async () => {
      await prisma.syncJob.updateMany({
        where: { mediaServerId: serverId, status: "RUNNING" },
        data: { cancelRequested: true },
      });
    };

    await syncMediaServer(serverId, undefined, { trigger: "test: stopped" });

    expect(await prisma.syncJob.count({ where: { mediaServerId: serverId, status: "CANCELLED" } })).toBe(1);
    expect((await serverRow()).tracearrBackfillRestartedAt).not.toBeNull();
    expect(await sliceIsHeld()).toBe(true);
  });

  it("is not released by a full sync that failed", async () => {
    await restartTracearrBackfill([serverId]);
    m.duringLibraryPass = async () => {
      throw new Error("server went away");
    };

    await expect(
      syncMediaServer(serverId, undefined, { trigger: "test: failed" }),
    ).rejects.toThrow("server went away");

    expect(await prisma.syncJob.count({ where: { mediaServerId: serverId, status: "FAILED" } })).toBe(1);
    expect((await serverRow()).tracearrBackfillRestartedAt).not.toBeNull();
  });

  it("does not hold a first walk that failed after committing a page — the retry walks", async () => {
    // First-ever slice: one page commits (cursor written), then Tracearr
    // fails. That leaves a cursor and no walk stamp — the shape a restart was
    // inferred from — but nothing restarted anything.
    m.getHistoryPage
      .mockResolvedValueOnce({
        records: [record("chain-1", "2026-09-01T00:00:00.000Z")],
        nextCursor: "page-2",
      })
      .mockRejectedValueOnce(new Error("Tracearr unreachable"));

    const first = await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(first.backfillOutcome).toBe("errored");
    const afterError = await serverRow();
    expect(afterError.tracearrBackfillCursorAt).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(afterError.tracearrBackfillLastWalkAt).toBeNull();
    expect(afterError.tracearrBackfillRestartedAt).toBeNull();

    // The retry walks on from where the first one reached.
    m.getHistoryPage.mockClear();
    m.getHistoryPage.mockResolvedValueOnce({ records: [], nextCursor: null });
    const retry = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(m.getHistoryPage).toHaveBeenCalledTimes(1);
    expect(m.getHistoryPage.mock.calls[0][1].until).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(retry.heldReason).toBeUndefined();
  });
});
