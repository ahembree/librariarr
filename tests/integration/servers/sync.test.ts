import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
} from "../../setup/test-helpers";

// Redirect prisma to test database
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

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: mockEnqueueJob,
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/servers/[id]/sync/route";
import { TASK_SYNC_SERVER, MAIN_QUEUE } from "@/lib/jobs/constants";

describe("POST /api/servers/[id]/sync", () => {
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
    const response = await callRouteWithParams(
      POST,
      { id: "nonexistent" },
      {
        url: "/api/servers/nonexistent/sync",
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 404 when server does not exist", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: "00000000-0000-0000-0000-000000000000" },
      {
        url: "/api/servers/00000000-0000-0000-0000-000000000000/sync",
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });

  it("returns 404 when server belongs to another user", async () => {
    const user1 = await createTestUser({ plexId: "owner" });
    const user2 = await createTestUser({ plexId: "other" });
    const server = await createTestServer(user1.id);

    setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });

  it("enqueues a sync job and returns success message", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
      }
    );
    const body = await expectJson<{ message: string }>(response, 200);

    expect(body.message).toBe("Sync started");
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: server.id, libraryKey: undefined },
      expect.objectContaining({ jobKey: `sync:${server.id}`, queueName: MAIN_QUEUE }),
    );
  });

  it("returns 409 when a sync is already running for the server", async () => {
    const { getTestPrisma } = await import("../../setup/test-db");
    const testPrisma = getTestPrisma();

    const user = await createTestUser();
    const server = await createTestServer(user.id);

    // Create an existing RUNNING sync job
    await testPrisma.syncJob.create({
      data: { mediaServerId: server.id, status: "RUNNING" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 409);
    expect(body.error).toBe("A sync is already running for this server");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("returns 409 when a sync is pending for the server", async () => {
    const { getTestPrisma } = await import("../../setup/test-db");
    const testPrisma = getTestPrisma();

    const user = await createTestUser();
    const server = await createTestServer(user.id);

    // Create an existing PENDING sync job (queued behind another sync)
    await testPrisma.syncJob.create({
      data: { mediaServerId: server.id, status: "PENDING" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 409);
    expect(body.error).toBe("A sync is already running for this server");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("scopes the enqueued job to a specific library when provided", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { key: "lib-key", title: "Movies" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
        body: { libraryKey: library.key },
      }
    );
    await expectJson<{ message: string }>(response, 200);

    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: server.id, libraryKey: "lib-key" },
      expect.objectContaining({ jobKey: `sync:${server.id}:lib-key`, queueName: MAIN_QUEUE }),
    );
  });
});
