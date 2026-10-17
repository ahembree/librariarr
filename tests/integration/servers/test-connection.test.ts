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
import { createMediaServerClient } from "@/lib/media-server/factory";
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
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
    expect(createMediaServerClient).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid body", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(serverTest, {
      method: "POST",
      body: { url: "", accessToken: "", type: "" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        "url: URL is required",
        "accessToken: Access token is required",
        "type: Server type is required",
      ]),
    );
    expect(createMediaServerClient).not.toHaveBeenCalled();
  });

  // `createMediaServerClient` throws for a type it cannot build, which was a 500.
  it("refuses a server type the app cannot talk to with 400", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(serverTest, {
      method: "POST",
      body: { url: "http://kodi.test:8080", accessToken: "tok", type: "KODI" },
    });
    expect(await expectJson(res, 400)).toEqual({
      error: "Validation failed",
      details: ["type: Server type must be PLEX, JELLYFIN or EMBY"],
    });
    expect(createMediaServerClient).not.toHaveBeenCalled();
  });

  it("returns success on valid connection", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    mockTestConnection.mockResolvedValue({ ok: true, serverName: "My Plex" });

    const res = await callRoute(serverTest, {
      method: "POST",
      // file deepcode ignore HardcodedNonCryptoSecret/test: test file
      body: { url: "http://plex.test:32400", accessToken: "test-token", type: "PLEX" },
    });
    const body = await expectJson<{ ok: boolean; serverName: string | null }>(res);
    expect(body).toEqual({ ok: true, error: null, serverName: "My Plex" });
    // Tests exactly what the form holds, nothing stored.
    expect(createMediaServerClient).toHaveBeenCalledExactlyOnceWith("PLEX", "http://plex.test:32400", "test-token", {
      skipTlsVerify: false,
    });
  });

  it("returns error on failed connection", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

    const res = await callRoute(serverTest, {
      method: "POST",
      body: { url: "http://plex.test:32400", accessToken: "test-token", type: "PLEX" },
    });
    const body = await expectJson<{ ok: boolean; error: string | null }>(res);
    expect(body).toEqual({ ok: false, error: "Connection refused", serverName: null });
  });

  it("scrubs private addresses from the error", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    mockTestConnection.mockResolvedValue({ ok: false, error: "connect ECONNREFUSED 192.168.1.20:32400" });

    const res = await callRoute(serverTest, {
      method: "POST",
      body: { url: "http://plex.test:32400", accessToken: "test-token", type: "PLEX" },
    });
    const body = await expectJson<{ error: string | null }>(res);
    expect(body.error).toBe("connect ECONNREFUSED [internal]:32400");
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
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
  });

  it("returns 404 for non-existent server", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRouteWithParams(
      serverIdTestConnection,
      { id: "nonexistent-id" },
      { method: "POST" }
    );
    expect(await expectJson(res, 404)).toEqual({ error: "Server not found" });
    expect(createMediaServerClient).not.toHaveBeenCalled();
  });

  it("returns success on valid connection", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, {
      type: "JELLYFIN",
      url: "https://jellyfin.test:8920",
      accessToken: "stored-key",
      tlsSkipVerify: true,
    });
    setMockSession({ isLoggedIn: true, userId: user.id});
    mockTestConnection.mockResolvedValue({ ok: true, serverName: "My Jellyfin" });

    const res = await callRouteWithParams(
      serverIdTestConnection,
      { id: server.id },
      { method: "POST" }
    );
    const body = await expectJson<{ ok: boolean; serverName: string | null }>(res);
    expect(body).toEqual({ ok: true, error: null, serverName: "My Jellyfin" });
    // Tested with the stored settings — the key never travels from the browser.
    expect(createMediaServerClient).toHaveBeenCalledExactlyOnceWith("JELLYFIN", "https://jellyfin.test:8920", "stored-key", {
      skipTlsVerify: true,
    });
  });

  it("returns error on failed connection", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id});
    mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

    const res = await callRouteWithParams(
      serverIdTestConnection,
      { id: server.id },
      { method: "POST" }
    );
    const body = await expectJson<{ ok: boolean; error: string | null }>(res);
    expect(body).toEqual({ ok: false, error: "Connection refused", serverName: null });
  });

  it("scrubs private addresses from the error", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id});
    mockTestConnection.mockResolvedValue({ ok: false, error: "connect ECONNREFUSED 10.0.0.7:8096" });

    const res = await callRouteWithParams(serverIdTestConnection, { id: server.id }, { method: "POST" });
    const body = await expectJson<{ error: string | null }>(res);
    expect(body.error).toBe("connect ECONNREFUSED [internal]:8096");
  });
});
