import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
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

const { mockSyncMediaServer } = vi.hoisted(() => ({
  mockSyncMediaServer: vi.fn(),
}));

vi.mock("@/lib/sync/sync-server", () => ({
  syncMediaServer: mockSyncMediaServer,
  detectDynamicRangeFromFilename: vi.fn(),
  detectAudioProfileFromFilename: vi.fn(),
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/servers/[id]/sync/route";

describe("POST /api/servers/[id]/sync", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockSyncMediaServer.mockResolvedValue(undefined);
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

  it("starts sync and returns success message", async () => {
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
    expect(mockSyncMediaServer).toHaveBeenCalledWith(server.id, undefined);
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
    expect(mockSyncMediaServer).not.toHaveBeenCalled();
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
    expect(mockSyncMediaServer).not.toHaveBeenCalled();
  });

  it("still returns success even if sync fails in background", async () => {
    mockSyncMediaServer.mockRejectedValue(new Error("Sync failed"));

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
  });
});
