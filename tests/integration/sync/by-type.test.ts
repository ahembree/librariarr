import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
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

// `enqueueJob` answers whether the job was queued.
// `queuedSyncJobIds` answers which row each still-queued library job carries.
const { mockEnqueueJob, mockQueuedSyncJobIds, mockEmit } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(true),
  mockQueuedSyncJobIds: vi.fn().mockResolvedValue(new Map()),
  mockEmit: vi.fn(),
}));

vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob, queuedSyncJobIds: mockQueuedSyncJobIds }));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: mockEmit } }));

import { POST } from "@/app/api/sync/by-type/route";
import {
  TASK_SYNC_SERVER,
  TASK_SYNC_WATCH_HISTORY,
  MAIN_QUEUE,
  REQUESTED_SYNC_PRIORITY,
} from "@/lib/jobs/constants";

describe("POST /api/sync/by-type", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockEnqueueJob.mockResolvedValue(true);
    mockQueuedSyncJobIds.mockResolvedValue(new Map());
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("enqueues a job per enabled library of the requested type", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    // A SERIES library and a disabled MOVIE library, both of which are ignored
    await createTestLibrary(server.id, { key: "s1", type: "SERIES" });
    await createTestLibrary(server.id, { key: "m2", type: "MOVIE", enabled: false });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });
    const body = await expectJson<{ message: string; syncedCount: number; skippedCount: number }>(response, 200);

    expect(body).toEqual({ message: "Sync started", syncedCount: 1, skippedCount: 0 });
    const libraryJobs = mockEnqueueJob.mock.calls.filter((call) => call[0] === TASK_SYNC_SERVER);
    expect(libraryJobs).toHaveLength(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      {
        serverId: server.id,
        libraryKey: movies.key,
        skipWatchHistory: true,
        trigger: "manual sync of every MOVIE library",
        syncJobId: expect.any(String),
      },
      {
        jobKey: `sync:${server.id}:${movies.key}`,
        queueName: MAIN_QUEUE,
        maxAttempts: 3,
        priority: REQUESTED_SYNC_PRIORITY,
      },
    );
  });

  // The library page's Sync button polls /api/sync/status two seconds after
  // the click and ends its spinner when no job is RUNNING or PENDING. With the
  // row written only when the worker reached the job, a busy MAIN_QUEUE made
  // every click read as an instant, finished sync.
  it("creates a PENDING SyncJob for each library job, carried in its own payload", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    await createTestLibrary(server.id, { key: "m2", type: "MOVIE" });

    setMockSession({ userId: user.id, isLoggedIn: true });

    await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });

    // One row per job: a row shared by every library job was claimed by the
    // first and completed with it, so the button stopped spinning — and a Stop
    // stopped nothing — while the other libraries were still queued.
    const rows = await testPrisma.syncJob.findMany({ where: { mediaServerId: server.id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "PENDING")).toBe(true);

    const libraryJobs = mockEnqueueJob.mock.calls.filter((call) => call[0] === TASK_SYNC_SERVER);
    expect(libraryJobs).toHaveLength(2);
    expect(new Set(libraryJobs.map(([, payload]) => (payload as { syncJobId: string }).syncJobId))).toEqual(
      new Set(rows.map((row) => row.id)),
    );
    expect(mockEmit).toHaveBeenCalledWith({ type: "sync:started", userId: user.id, meta: { serverId: server.id } });
  });

  it("closes the row as FAILED when no library job could be queued", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    mockEnqueueJob.mockResolvedValue(false);

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });
    const body = await expectJson<{ syncedCount: number; skippedCount: number }>(response, 200);

    expect(body.syncedCount).toBe(0);
    expect(body.skippedCount).toBe(1);
    // A PENDING row nothing will claim would block every later sync request.
    const rows = await testPrisma.syncJob.findMany({ where: { mediaServerId: server.id } });
    expect(rows.map((r) => r.status)).toEqual(["FAILED"]);
    // No follow-up refresh and no "started" for a sync that was never queued.
    expect(mockEnqueueJob.mock.calls.some((call) => call[0] === TASK_SYNC_WATCH_HISTORY)).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // A running sync may be a scheduled one that already passed these libraries,
  // or this route's own for another type; skipping on it dropped the request
  // and the button stopped spinning with nothing queued. The jobs queue behind
  // it under a row of their own, which the running sync's row does not hide.
  it("queues behind a running sync instead of skipping the server", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    const running = await testPrisma.syncJob.create({
      data: { mediaServerId: server.id, status: "RUNNING", startedAt: new Date(Date.now() - 60_000) },
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });
    const body = await expectJson<{ syncedCount: number; skippedCount: number }>(response, 200);

    expect(body).toMatchObject({ syncedCount: 1, skippedCount: 0 });
    const queued = await testPrisma.syncJob.findMany({ where: { mediaServerId: server.id, status: "PENDING" } });
    expect(queued).toHaveLength(1);
    expect(queued[0].id).not.toBe(running.id);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      expect.objectContaining({ serverId: server.id, libraryKey: "m1", syncJobId: queued[0].id }),
      expect.objectContaining({ jobKey: `sync:${server.id}:m1` }),
    );
    expect((await testPrisma.syncJob.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("RUNNING");
  });

  // A Series request made while a Movies sync is queued must get rows of its
  // own: joined to the Movies row, its button stopped spinning once the first
  // Movies library finished, before any Series library had synced.
  it("gives another library type's request rows of its own", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    await createTestLibrary(server.id, { key: "s1", type: "SERIES" });
    setMockSession({ userId: user.id, isLoggedIn: true });

    await expectJson(await callRoute(POST, { url: "/api/sync/by-type", method: "POST", body: { libraryType: "MOVIE" } }), 200);
    const body = await expectJson<{ syncedCount: number; skippedCount: number }>(
      await callRoute(POST, { url: "/api/sync/by-type", method: "POST", body: { libraryType: "SERIES" } }),
      200,
    );

    expect(body).toMatchObject({ syncedCount: 1, skippedCount: 0 });
    const rows = await testPrisma.syncJob.findMany({ where: { mediaServerId: server.id } });
    expect(rows).toHaveLength(2);
    const libraryJobs = mockEnqueueJob.mock.calls.filter((call) => call[0] === TASK_SYNC_SERVER);
    expect(libraryJobs.map((call) => (call[1] as { libraryKey: string }).libraryKey)).toEqual(["m1", "s1"]);
    expect((libraryJobs[0][1] as { syncJobId: string }).syncJobId).not.toBe((libraryJobs[1][1] as { syncJobId: string }).syncJobId);
  });

  // A keyed enqueue replaces a still-queued job's payload, so a repeated
  // request for the same library carries that job's row on rather than leaving
  // it PENDING with nothing to claim it.
  it("reuses the row a still-queued job for the same library carries", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    await createTestLibrary(server.id, { key: "m2", type: "MOVIE" });
    const queued = await testPrisma.syncJob.create({ data: { mediaServerId: server.id, status: "PENDING" } });
    mockQueuedSyncJobIds.mockResolvedValue(new Map([[`sync:${server.id}:m1`, queued.id]]));
    setMockSession({ userId: user.id, isLoggedIn: true });

    await expectJson(await callRoute(POST, { url: "/api/sync/by-type", method: "POST", body: { libraryType: "MOVIE" } }), 200);

    expect(mockQueuedSyncJobIds).toHaveBeenCalledWith([`sync:${server.id}:m1`, `sync:${server.id}:m2`]);
    const rows = await testPrisma.syncJob.findMany({ where: { mediaServerId: server.id } });
    expect(rows).toHaveLength(2);
    const byLibrary = new Map(
      mockEnqueueJob.mock.calls
        .filter((call) => call[0] === TASK_SYNC_SERVER)
        .map((call) => [(call[1] as { libraryKey: string }).libraryKey, (call[1] as { syncJobId: string }).syncJobId]),
    );
    expect(byLibrary.get("m1")).toBe(queued.id);
    expect(byLibrary.get("m2")).not.toBe(queued.id);
  });

  it("does not reuse a row its queued job has already finished with", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    const done = await testPrisma.syncJob.create({ data: { mediaServerId: server.id, status: "COMPLETED" } });
    mockQueuedSyncJobIds.mockResolvedValue(new Map([[`sync:${server.id}:m1`, done.id]]));
    setMockSession({ userId: user.id, isLoggedIn: true });

    await expectJson(await callRoute(POST, { url: "/api/sync/by-type", method: "POST", body: { libraryType: "MOVIE" } }), 200);

    const pending = await testPrisma.syncJob.findMany({ where: { mediaServerId: server.id, status: "PENDING" } });
    expect(pending).toHaveLength(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      expect.objectContaining({ syncJobId: pending[0].id }),
      expect.anything(),
    );
  });

  it("leaves a reused row alone when its job could not be queued again", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    const queued = await testPrisma.syncJob.create({ data: { mediaServerId: server.id, status: "PENDING" } });
    mockQueuedSyncJobIds.mockResolvedValue(new Map([[`sync:${server.id}:m1`, queued.id]]));
    mockEnqueueJob.mockResolvedValue(false);
    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson<{ syncedCount: number; skippedCount: number }>(
      await callRoute(POST, { url: "/api/sync/by-type", method: "POST", body: { libraryType: "MOVIE" } }),
      200,
    );

    expect(body).toMatchObject({ syncedCount: 0, skippedCount: 1 });
    expect((await testPrisma.syncJob.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("PENDING");
  });

  // The duplicate check and the insert run under the per-server
  // `sync-request:` lock the per-server route takes too. Without it, requests
  // that arrived together each passed the check and each created a row; the
  // later enqueue replaced the earlier jobs' payloads (same jobKeys), so the
  // earlier row sat PENDING with nothing to claim it — and a PENDING row makes
  // every later sync request answer as though a sync were already queued.
  it("checks for a queued sync under the per-server route's lock", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    setMockSession({ userId: user.id, isLoggedIn: true });

    // Stand in for `/api/servers/[id]/sync` mid-request: it holds the lock,
    // and creates its PENDING row before committing.
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const perServerRequest = testPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('sync-request:' || $1))`, server.id);
      locked();
      await committed;
      return tx.syncJob.create({ data: { mediaServerId: server.id, status: "PENDING", startedAt: new Date() } });
    }, { timeout: 10_000 });
    await lockHeld;

    const byType = callRoute(POST, { url: "/api/sync/by-type", method: "POST", body: { libraryType: "MOVIE" } });
    // Long enough for an unserialized request to run its check and insert.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Serialized: it reads the queued jobs only once the lock is free, after
    // the other request committed, and then adds a row of its own.
    expect(mockQueuedSyncJobIds).not.toHaveBeenCalled();
    commit();
    const perServerRow = await perServerRequest;
    await expectJson(await byType, 200);
    expect(mockQueuedSyncJobIds).toHaveBeenCalledTimes(1);
    const rows = await testPrisma.syncJob.findMany({ where: { mediaServerId: server.id } });
    expect(rows).toHaveLength(2);
    // Identified by id, not by timestamp order: both rows can carry the same millisecond.
    const byTypeRow = rows.find((row) => row.id !== perServerRow.id)!;
    expect(byTypeRow.status).toBe("PENDING");
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      expect.objectContaining({ syncJobId: byTypeRow.id }),
      expect.anything(),
    );
  });

  it("queues a watch-history refresh after the library jobs of each server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const a = await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    const b = await createTestLibrary(server.id, { key: "m2", type: "MOVIE" });

    setMockSession({ userId: user.id, isLoggedIn: true });

    await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });

    // The library jobs skip the server-wide watch-history scan, so without this
    // follow-up they leave playCount/lastPlayedAt at the *owner's* values —
    // the admin token's own views on Plex, nothing at all on Jellyfin/Emby.
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_WATCH_HISTORY,
      { serverId: server.id },
      expect.objectContaining({ jobKey: `watch-history:${server.id}`, queueName: MAIN_QUEUE }),
    );

    // Exactly one refresh per server, not one per library.
    const tasks = mockEnqueueJob.mock.calls.map((call) => call[0]);
    expect(tasks.filter((t) => t === TASK_SYNC_WATCH_HISTORY)).toHaveLength(1);
    expect(tasks.filter((t) => t === TASK_SYNC_SERVER)).toHaveLength(2);

    // The refresh must run *after* both library jobs — otherwise
    // syncWatchHistoryTask's "a full sync is already running" guard swallows
    // it and nothing reconciles. MAIN_QUEUE orders by priority, then enqueue
    // time: the library jobs are the more urgent and are queued first.
    const libraryKeys = [a.key, b.key];
    const lastLibraryJob = Math.max(
      ...mockEnqueueJob.mock.calls
        .map((call, i) => ({ call, i }))
        .filter(({ call }) => libraryKeys.includes((call[1] as { libraryKey?: string }).libraryKey ?? ""))
        .map(({ i }) => i),
    );
    expect(tasks.indexOf(TASK_SYNC_WATCH_HISTORY)).toBeGreaterThan(lastLibraryJob);
    const refreshSpec = mockEnqueueJob.mock.calls.find((call) => call[0] === TASK_SYNC_WATCH_HISTORY)![2] as {
      priority?: number;
    };
    expect(refreshSpec.priority ?? 0).toBeGreaterThan(REQUESTED_SYNC_PRIORITY);
  });

  it("queues the watch-history refresh after the library jobs behind a running sync", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    await testPrisma.syncJob.create({ data: { mediaServerId: server.id, status: "RUNNING" } });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });
    const body = await expectJson<{ syncedCount: number; skippedCount: number }>(response, 200);

    expect(body).toMatchObject({ syncedCount: 1, skippedCount: 0 });
    expect(mockEnqueueJob.mock.calls.map((call) => call[0])).toEqual([TASK_SYNC_SERVER, TASK_SYNC_WATCH_HISTORY]);
  });

  it("returns a no-op message when no servers have the requested type", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "s1", type: "SERIES" });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });
    const body = await expectJson<{ message: string; syncedCount: number }>(response, 200);

    expect(body.syncedCount).toBe(0);
    expect(body.message).toBe("No servers available to sync");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });
});
