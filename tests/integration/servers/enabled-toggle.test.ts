import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
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

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn().mockReturnValue({
    testConnection: vi.fn().mockResolvedValue({ ok: true, serverName: "Test" }),
  }),
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  appCache: {
    get: vi.fn(),
    set: vi.fn(),
    invalidate: vi.fn(),
    invalidatePrefix: vi.fn(),
  },
}));

const { mockSyncMediaServer } = vi.hoisted(() => ({
  mockSyncMediaServer: vi.fn(),
}));

vi.mock("@/lib/sync/sync-server", () => ({
  syncMediaServer: mockSyncMediaServer,
  detectDynamicRangeFromFilename: vi.fn(),
  detectAudioProfileFromFilename: vi.fn(),
}));

// Import route handlers AFTER mocks
import { GET } from "@/app/api/servers/route";
import { PUT } from "@/app/api/servers/[id]/route";
import { POST as SyncPOST } from "@/app/api/servers/[id]/sync/route";
import { GET as LibraryTypesGET } from "@/app/api/media/library-types/route";

describe("Server enable/disable toggle", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockSyncMediaServer.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- PUT /api/servers/[id] with enabled -----

  describe("PUT /api/servers/[id] — toggle enabled", () => {
    it("disables a server", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        { url: `/api/servers/${server.id}`, method: "PUT", body: { enabled: false } }
      );
      const body = await expectJson<{ server: { id: string; enabled: boolean } }>(response, 200);
      expect(body.server.enabled).toBe(false);

      // Verify in DB
      const updated = await prisma.mediaServer.findUnique({ where: { id: server.id } });
      expect(updated!.enabled).toBe(false);
    });

    it("re-enables a disabled server", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { enabled: false });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        { url: `/api/servers/${server.id}`, method: "PUT", body: { enabled: true } }
      );
      const body = await expectJson<{ server: { id: string; enabled: boolean } }>(response, 200);
      expect(body.server.enabled).toBe(true);
    });

    it("skips connection test when disabling", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Send enabled=false with a bad URL — should succeed because connection test is skipped
      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        { url: `/api/servers/${server.id}`, method: "PUT", body: { enabled: false, url: "http://bad-url.invalid" } }
      );
      const body = await expectJson<{ server: { id: string; enabled: boolean } }>(response, 200);
      expect(body.server.enabled).toBe(false);
    });
  });

  // ----- GET /api/servers -----

  describe("GET /api/servers — includes disabled servers", () => {
    it("returns both enabled and disabled servers", async () => {
      const user = await createTestUser();
      await createTestServer(user.id, { name: "Enabled", enabled: true });
      await createTestServer(user.id, { name: "Disabled", enabled: false });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/servers" });
      const body = await expectJson<{ servers: { name: string; enabled: boolean }[] }>(response, 200);
      expect(body.servers).toHaveLength(2);

      const enabledServer = body.servers.find((s) => s.name === "Enabled");
      const disabledServer = body.servers.find((s) => s.name === "Disabled");
      expect(enabledServer!.enabled).toBe(true);
      expect(disabledServer!.enabled).toBe(false);
    });
  });

  // ----- POST /api/servers/[id]/sync -----

  describe("POST /api/servers/[id]/sync — disabled server", () => {
    it("returns 400 when trying to sync a disabled server", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { enabled: false });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        SyncPOST,
        { id: server.id },
        { url: `/api/servers/${server.id}/sync`, method: "POST" }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Cannot sync a disabled server");
      expect(mockSyncMediaServer).not.toHaveBeenCalled();
    });
  });

  // ----- GET /api/media/library-types -----

  describe("GET /api/media/library-types — excludes disabled servers", () => {
    it("excludes library types from disabled servers", async () => {
      const user = await createTestUser();
      const enabledServer = await createTestServer(user.id, { name: "Enabled", enabled: true });
      const disabledServer = await createTestServer(user.id, { name: "Disabled", enabled: false });

      await createTestLibrary(enabledServer.id, { type: "MOVIE", title: "Movies" });
      await createTestLibrary(disabledServer.id, { type: "MUSIC", title: "Music" });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(LibraryTypesGET, { url: "/api/media/library-types" });
      const body = await expectJson<{ types: string[] }>(response, 200);

      expect(body.types).toContain("MOVIE");
      expect(body.types).not.toContain("MUSIC");
    });
  });
});
