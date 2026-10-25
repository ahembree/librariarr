import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

const mockTestConnection = vi.fn();
const mockGetLibraries = vi.fn();

vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return {
      testConnection: mockTestConnection,
      getLibraries: mockGetLibraries,
    };
  }),
}));

// Import route handlers AFTER mocks
import { GET, PUT } from "@/app/api/servers/[id]/libraries/route";
import { appCache } from "@/lib/cache/memory-cache";
import { eventBus } from "@/lib/events/event-bus";
import { LIST_RESPONSE_CACHE_PREFIX } from "@/lib/cache/list-response-prefix";

describe("Server Libraries endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, serverName: "Test Server" });
    mockGetLibraries.mockResolvedValue([]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/servers/[id]/libraries -----

  describe("GET /api/servers/[id]/libraries", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        GET,
        { id: "nonexistent" },
        { url: "/api/servers/nonexistent/libraries" }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 when server does not exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        GET,
        { id: "00000000-0000-0000-0000-000000000000" },
        { url: "/api/servers/00000000-0000-0000-0000-000000000000/libraries" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Server not found");
    });

    it("returns libraries from Plex with existing library state", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, {
        key: "1",
        title: "Movies",
        type: "MOVIE",
        enabled: true,
      });

      mockGetLibraries.mockResolvedValue([
        { key: "1", title: "Movies", type: "movie" },
        { key: "2", title: "TV Shows", type: "show" },
      ]);

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        GET,
        { id: server.id },
        { url: `/api/servers/${server.id}/libraries` }
      );
      const body = await expectJson<{
        libraries: {
          key: string;
          title: string;
          type: string;
          enabled: boolean;
          exists: boolean;
        }[];
      }>(response, 200);

      // In the server's own order; a section with no row yet is listed off.
      expect(body.libraries).toEqual([
        { key: "1", title: "Movies", type: "MOVIE", enabled: true, exists: true },
        { key: "2", title: "TV Shows", type: "SERIES", enabled: false, exists: false },
      ]);
    });

    it("maps artist type to MUSIC", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);

      mockGetLibraries.mockResolvedValue([
        { key: "3", title: "Music", type: "artist" },
      ]);

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        GET,
        { id: server.id },
        { url: `/api/servers/${server.id}/libraries` }
      );
      const body = await expectJson<{
        libraries: { key: string; type: string }[];
      }>(response, 200);

      expect(body.libraries).toEqual([{ key: "3", title: "Music", type: "MUSIC", enabled: false, exists: false }]);
    });
  });

  // ----- PUT /api/servers/[id]/libraries -----

  describe("PUT /api/servers/[id]/libraries", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        PUT,
        { id: "nonexistent" },
        {
          url: "/api/servers/nonexistent/libraries",
          method: "PUT",
          body: { libraries: [] },
        }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 when server does not exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: "00000000-0000-0000-0000-000000000000" },
        {
          url: "/api/servers/00000000-0000-0000-0000-000000000000/libraries",
          method: "PUT",
          body: { libraries: [] },
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Server not found");
    });

    it("returns 400 when libraries is not an array", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}/libraries`,
          method: "PUT",
          body: { libraries: "not-an-array" },
        }
      );
      const body = await expectJson<{ error: string; details: string[] }>(response, 400);
      expect(body.error).toBe("Validation failed");
      expect(body.details).toEqual([expect.stringMatching(/^libraries: /)]);
    });

    it("updates enabled state of existing libraries", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, {
        key: "1",
        title: "Movies",
        type: "MOVIE",
        enabled: true,
      });

      setMockSession({ userId: user.id, isLoggedIn: true });
      // A listing cached before the change: turning the library off empties it.
      appCache.set(`${LIST_RESPONSE_CACHE_PREFIX}media-movies?limit=0`, { cached: true });
      const events: string[] = [];
      const unsubscribe = eventBus.subscribe((event) => events.push(event.type));

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}/libraries`,
          method: "PUT",
          body: { libraries: [{ key: "1", enabled: false }] },
        }
      );
      const body = await expectJson<{
        libraries: { key: string; enabled: boolean }[];
      }>(response, 200);

      expect(body.libraries).toEqual([{ key: "1", title: "Movies", type: "MOVIE", enabled: false }]);
      expect(appCache.get(`${LIST_RESPONSE_CACHE_PREFIX}media-movies?limit=0`)).toBeUndefined();
      // And the browser's lists, which drop on this event.
      unsubscribe();
      expect(events).toContain("server:changed");
      const stored = await getTestPrisma().library.findMany({ where: { mediaServerId: server.id } });
      expect(stored.map((l) => [l.key, l.enabled])).toEqual([["1", false]]);
      // A known library needs no round trip to the server.
      expect(mockGetLibraries).not.toHaveBeenCalled();
    });

    it("creates new library record when key does not exist yet", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);

      mockGetLibraries.mockResolvedValue([
        { key: "4", title: "New Library", type: "movie" },
      ]);

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}/libraries`,
          method: "PUT",
          body: { libraries: [{ key: "4", enabled: true }] },
        }
      );
      const body = await expectJson<{
        libraries: { key: string; title: string; type: string; enabled: boolean }[];
      }>(response, 200);

      expect(body.libraries).toEqual([{ key: "4", title: "New Library", type: "MOVIE", enabled: true }]);
      const stored = await getTestPrisma().library.findMany({ where: { mediaServerId: server.id } });
      expect(stored).toHaveLength(1);
    });

    it("creates nothing for a key the server does not list", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      mockGetLibraries.mockResolvedValue([{ key: "4", title: "New Library", type: "movie" }]);
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}/libraries`,
          method: "PUT",
          body: { libraries: [{ key: "99", enabled: true }] },
        }
      );
      const body = await expectJson<{ libraries: unknown[] }>(response, 200);
      expect(body.libraries).toEqual([]);
      expect(await getTestPrisma().library.count()).toBe(0);
    });
  });
});
