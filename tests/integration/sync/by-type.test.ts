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
import { TASK_SYNC_SERVER, MAIN_QUEUE } from "@/lib/jobs/constants";

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
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: server.id, libraryKey: movies.key, skipWatchHistory: true },
      expect.objectContaining({ jobKey: `sync:${server.id}:${movies.key}`, queueName: MAIN_QUEUE }),
    );
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
