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

describe("Server Libraries endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, name: "Test Server" });
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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      expect(body.libraries).toHaveLength(2);

      const movies = body.libraries.find((l) => l.key === "1");
      expect(movies?.type).toBe("MOVIE");
      expect(movies?.enabled).toBe(true);
      expect(movies?.exists).toBe(true);

      const tvShows = body.libraries.find((l) => l.key === "2");
      expect(tvShows?.type).toBe("SERIES");
      expect(tvShows?.enabled).toBe(false);
      expect(tvShows?.exists).toBe(false);
    });

    it("maps artist type to MUSIC", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);

      mockGetLibraries.mockResolvedValue([
        { key: "3", title: "Music", type: "artist" },
      ]);

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        GET,
        { id: server.id },
        { url: `/api/servers/${server.id}/libraries` }
      );
      const body = await expectJson<{
        libraries: { key: string; type: string }[];
      }>(response, 200);

      expect(body.libraries[0].type).toBe("MUSIC");
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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}/libraries`,
          method: "PUT",
          body: { libraries: "not-an-array" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      const lib = body.libraries.find((l) => l.key === "1");
      expect(lib?.enabled).toBe(false);
    });

    it("creates new library record when key does not exist yet", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);

      mockGetLibraries.mockResolvedValue([
        { key: "new-1", title: "New Library", type: "movie" },
      ]);

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}/libraries`,
          method: "PUT",
          body: { libraries: [{ key: "new-1", enabled: true }] },
        }
      );
      const body = await expectJson<{
        libraries: { key: string; title: string; type: string; enabled: boolean }[];
      }>(response, 200);

      expect(body.libraries).toHaveLength(1);
      expect(body.libraries[0].key).toBe("new-1");
      expect(body.libraries[0].title).toBe("New Library");
      expect(body.libraries[0].type).toBe("MOVIE");
      expect(body.libraries[0].enabled).toBe(true);
    });
  });
});
