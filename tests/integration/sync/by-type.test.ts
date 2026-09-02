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

const { mockEnqueueJob } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob }));

import { POST } from "@/app/api/sync/by-type/route";
import { TASK_SYNC_SERVER, TASK_SYNC_WATCH_HISTORY, MAIN_QUEUE } from "@/lib/jobs/constants";

describe("POST /api/sync/by-type", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockEnqueueJob.mockResolvedValue(undefined);
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
    await expectJson(response, 401);
  });

  it("enqueues a job per enabled library of the requested type", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    // A SERIES library that should be ignored
    await createTestLibrary(server.id, { key: "s1", type: "SERIES" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });
    const body = await expectJson<{ message: string; syncedCount: number; skippedCount: number }>(response, 200);

    expect(body.syncedCount).toBe(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: server.id, libraryKey: movies.key, skipWatchHistory: true },
      expect.objectContaining({ jobKey: `sync:${server.id}:${movies.key}`, queueName: MAIN_QUEUE }),
    );
  });

  it("queues a watch-history refresh after the library jobs of each server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const a = await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    const b = await createTestLibrary(server.id, { key: "m2", type: "MOVIE" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    // MAIN_QUEUE runs in enqueue order, so the refresh must be queued *after*
    // both library jobs — otherwise syncWatchHistoryTask's "a full sync is
    // already running" guard swallows it and nothing reconciles.
    const libraryKeys = [a.key, b.key];
    const lastLibraryJob = Math.max(
      ...mockEnqueueJob.mock.calls
        .map((call, i) => ({ call, i }))
        .filter(({ call }) => libraryKeys.includes((call[1] as { libraryKey?: string }).libraryKey ?? ""))
        .map(({ i }) => i),
    );
    expect(tasks.indexOf(TASK_SYNC_WATCH_HISTORY)).toBeGreaterThan(lastLibraryJob);
  });

  it("skips servers that already have a running sync", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    await testPrisma.syncJob.create({ data: { mediaServerId: server.id, status: "RUNNING" } });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });
    const body = await expectJson<{ syncedCount: number; skippedCount: number }>(response, 200);

    expect(body.syncedCount).toBe(0);
    expect(body.skippedCount).toBe(1);
    // Neither the library jobs nor the watch-history refresh.
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("returns a no-op message when no servers have the requested type", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "s1", type: "SERIES" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
