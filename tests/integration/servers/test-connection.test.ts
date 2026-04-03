import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
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

const mockTestConnection = vi.hoisted(() => vi.fn());

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn().mockReturnValue({
    testConnection: mockTestConnection,
  }),
}));

// Import route handlers AFTER mocks
import { POST as serverTest } from "@/app/api/servers/test/route";
import { POST as serverIdTestConnection } from "@/app/api/servers/[id]/test-connection/route";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// POST /api/servers/test
// ---------------------------------------------------------------------------
describe("POST /api/servers/test", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(serverTest, {
      method: "POST",
      body: { url: "http://plex.test:32400", accessToken: "tok", type: "PLEX" },
    });
    await expectJson(res, 401);
  });

  it("returns 400 on invalid body", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(serverTest, {
      method: "POST",
      body: { url: "", accessToken: "", type: "" },
    });
    await expectJson(res, 400);
  });

  it("returns success on valid connection", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockTestConnection.mockResolvedValue({ ok: true, serverName: "My Plex" });

    const res = await callRoute(serverTest, {
      method: "POST",
      // file deepcode ignore HardcodedNonCryptoSecret/test: test file
      body: { url: "http://plex.test:32400", accessToken: "test-token", type: "PLEX" },
    });
    const body = await expectJson<{ ok: boolean; serverName: string | null }>(res);
    expect(body.ok).toBe(true);
    expect(body.serverName).toBe("My Plex");
  });

  it("returns error on failed connection", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

    const res = await callRoute(serverTest, {
      method: "POST",
      body: { url: "http://plex.test:32400", accessToken: "test-token", type: "PLEX" },
    });
    const body = await expectJson<{ ok: boolean; error: string | null }>(res);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Connection refused");
  });
});

// ---------------------------------------------------------------------------
// POST /api/servers/[id]/test-connection
// ---------------------------------------------------------------------------
describe("POST /api/servers/[id]/test-connection", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      serverIdTestConnection,
      { id: "nonexistent" },
      { method: "POST" }
    );
    await expectJson(res, 401);
  });

  it("returns 404 for non-existent server", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRouteWithParams(
      serverIdTestConnection,
      { id: "nonexistent-id" },
      { method: "POST" }
    );
    await expectJson(res, 404);
  });

  it("returns success on valid connection", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockTestConnection.mockResolvedValue({ ok: true, serverName: "My Plex" });

    const res = await callRouteWithParams(
      serverIdTestConnection,
      { id: server.id },
      { method: "POST" }
    );
    const body = await expectJson<{ ok: boolean; serverName: string | null }>(res);
    expect(body.ok).toBe(true);
    expect(body.serverName).toBe("My Plex");
  });

  it("returns error on failed connection", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

    const res = await callRouteWithParams(
      serverIdTestConnection,
      { id: server.id },
      { method: "POST" }
    );
    const body = await expectJson<{ ok: boolean; error: string | null }>(res);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Connection refused");
  });
});
