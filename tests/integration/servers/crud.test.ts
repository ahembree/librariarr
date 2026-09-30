import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
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

const mockTestConnection = vi.fn();
const mockGetLibraries = vi.fn();

const { mockInvalidateMediaCaches } = vi.hoisted(() => ({
  mockInvalidateMediaCaches: vi.fn(),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateMediaCaches: mockInvalidateMediaCaches,
}));

vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return {
      testConnection: mockTestConnection,
      getLibraries: mockGetLibraries,
    };
  }),
}));

const { mockGetPlexResources } = vi.hoisted(() => ({ mockGetPlexResources: vi.fn() }));
vi.mock("@/lib/plex/auth", () => ({ getPlexResources: mockGetPlexResources }));

// Import route handlers AFTER mocks
import { GET, POST } from "@/app/api/servers/route";
import { PUT } from "@/app/api/servers/[id]/route";
import { PlexClient } from "@/lib/plex/client";
import { getTestPrisma } from "../../setup/test-db";

/** Where each PlexClient was pointed, and with which token. */
const plexClientTargets = () =>
  vi.mocked(PlexClient).mock.calls.map(([url, token]) => ({ url, token }));

const STALE = Date.now() - 16 * 60 * 1000;

describe("Server CRUD endpoints", () => {
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

  // ----- GET /api/servers -----

  describe("GET /api/servers", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/servers" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty servers array when user has no servers", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/servers" });
      const body = await expectJson<{ servers: unknown[] }>(response, 200);
      expect(body.servers).toEqual([]);
    });

    it("returns servers belonging to the authenticated user", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { name: "My Plex" });
      await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/servers" });
      const body = await expectJson<{
        servers: { id: string; name: string; libraries: unknown[] }[];
      }>(response, 200);

      expect(body.servers).toHaveLength(1);
      expect(body.servers[0].name).toBe("My Plex");
      expect(body.servers[0].libraries).toHaveLength(1);
    });

    it("does not return servers belonging to another user", async () => {
      const user1 = await createTestUser({ plexId: "user1" });
      const user2 = await createTestUser({ plexId: "user2" });
      await createTestServer(user1.id, { name: "User1 Server" });
      await createTestServer(user2.id, { name: "User2 Server" });

      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/servers" });
      const body = await expectJson<{
        servers: { name: string }[];
      }>(response, 200);

      expect(body.servers).toHaveLength(1);
      expect(body.servers[0].name).toBe("User2 Server");
    });
  });

  // ----- POST /api/servers -----

  describe("POST /api/servers", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: { url: "http://plex:32400", accessToken: "tok" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when url or accessToken is missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: { name: "No URL" },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 400 when URL lacks http/https protocol", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: {
          name: "No Protocol",
          url: "plex.local:32400",
          accessToken: "tok",
        },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 400 when Plex connection test fails", async () => {
      mockTestConnection.mockResolvedValue({
        ok: false,
        error: "Connection refused",
      });

      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: {
          name: "Bad Server",
          url: "http://bad:32400",
          accessToken: "tok",
        },
      });
      const body = await expectJson<{ error: string; detail: string }>(
        response,
        400
      );
      expect(body.error).toContain("Failed to connect");
      expect(body.detail).toBe("Connection refused");
    });

    it("creates a new server on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: {
          name: "New Server",
          url: "http://plex:32400",
          // file deepcode ignore HardcodedNonCryptoSecret/test: test file
          accessToken: "my-token",
          machineId: "machine-1",
        },
      });
      const body = await expectJson<{ server: { id: string; name: string } }>(
        response,
        201
      );

      expect(body.server.name).toBe("New Server");
      expect(body.server.id).toBeDefined();
    });

    it("updates existing server when machineId matches", async () => {
      const user = await createTestUser();
      const existing = await createTestServer(user.id, {
        name: "Old Name",
        machineId: "dup-machine",
        url: "http://old:32400",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: {
          name: "Updated Name",
          url: "http://new:32400",
          accessToken: "new-token",
          machineId: "dup-machine",
        },
      });
      const body = await expectJson<{
        server: { id: string; name: string; url: string };
        updated: boolean;
      }>(response, 200);

      expect(body.updated).toBe(true);
      expect(body.server.id).toBe(existing.id);
      expect(body.server.name).toBe("Updated Name");
      expect(body.server.url).toBe("http://new:32400");
    });

    it("invalidates media caches when a server is created", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "token", isLoggedIn: true });

      await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: { name: "Second", url: "http://plex2:32400", accessToken: "tok", machineId: "m2" },
      });

      // resolveServerFilter caches `isSingleServer`, which decides whether the
      // media listings filter to dedupCanonical. Adding a server flips it, and
      // without this the pre-add answer stood until the cache TTL expired.
      expect(mockInvalidateMediaCaches).toHaveBeenCalled();
    });

    it("invalidates media caches when an existing server is re-pointed", async () => {
      const user = await createTestUser();
      await createTestServer(user.id, { machineId: "same-machine", name: "Old name" });
      setMockSession({ userId: user.id, plexToken: "token", isLoggedIn: true });

      await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: { name: "New name", url: "http://moved:32400", accessToken: "tok", machineId: "same-machine" },
      });

      // The cached server-filter result carries the server's name.
      expect(mockInvalidateMediaCaches).toHaveBeenCalled();
    });
  });

  // ----- POST /api/servers — a discovered Plex server, by machine id -----

  // Discovery (`GET /api/auth/plex/servers`) no longer hands the browser each
  // owned server's token — plex.tv can answer with the account's own token,
  // which signs in to Librariarr. Adding the server sends its machine id and
  // the route looks the token up, behind a recent sign-in because the token
  // then goes to the URL in the request.
  describe("POST /api/servers without an access token", () => {
    const ownedServer = {
      name: "Home",
      clientIdentifier: "machine-1",
      provides: "server",
      owned: true,
      accessToken: "resolved-server-token",
      connections: [],
    };

    it("looks the token up on plex.tv and stores it", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "account-token", isLoggedIn: true, authenticatedAt: Date.now() });
      mockGetPlexResources.mockResolvedValue([
        { ...ownedServer, clientIdentifier: "someone-elses", owned: false, accessToken: "shared-token" },
        ownedServer,
      ]);

      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: { name: "Home", url: "http://10.0.0.5:32400", machineId: "machine-1" },
      });
      const body = await expectJson<{ server: { id: string; accessToken: string } }>(response, 201);

      expect(mockGetPlexResources).toHaveBeenCalledWith("account-token");
      expect(plexClientTargets()).toEqual([{ url: "http://10.0.0.5:32400", token: "resolved-server-token" }]);
      // Masked in the response, stored in full.
      expect(body.server.accessToken).not.toBe("resolved-server-token");
      const stored = await getTestPrisma().mediaServer.findUniqueOrThrow({ where: { id: body.server.id } });
      expect(stored.accessToken).toBe("resolved-server-token");
    });

    it("asks a session with no recent sign-in to confirm it's them, before looking anything up", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "account-token", isLoggedIn: true, authenticatedAt: STALE });
      mockGetPlexResources.mockResolvedValue([ownedServer]);

      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: { name: "Home", url: "https://attacker.example", machineId: "machine-1" },
      });
      const body = await expectJson<{ code: string }>(response, 403);

      expect(body.code).toBe("reauth_required");
      expect(mockGetPlexResources).not.toHaveBeenCalled();
      expect(plexClientTargets()).toEqual([]);
      expect(await getTestPrisma().mediaServer.count()).toBe(0);
    });

    it("returns 404 for a machine id the Plex account does not own", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "account-token", isLoggedIn: true, authenticatedAt: Date.now() });
      mockGetPlexResources.mockResolvedValue([{ ...ownedServer, owned: false }]);

      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: { name: "Home", url: "http://10.0.0.5:32400", machineId: "machine-1" },
      });
      await expectJson(response, 404);
      expect(plexClientTargets()).toEqual([]);
    });

    it("still requires a token for a Jellyfin or Emby server", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "account-token", isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRoute(POST, {
        url: "/api/servers",
        method: "POST",
        body: { name: "Jelly", url: "http://jelly:8096", machineId: "jf-1", type: "JELLYFIN" },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
      expect(mockGetPlexResources).not.toHaveBeenCalled();
    });
  });

  // ----- PUT /api/servers/[id] -----

  describe("PUT /api/servers/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        PUT,
        { id: "nonexistent" },
        {
          url: "/api/servers/nonexistent",
          method: "PUT",
          body: { url: "http://new:32400" },
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
          url: "/api/servers/00000000-0000-0000-0000-000000000000",
          method: "PUT",
          body: { url: "http://new:32400" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Server not found");
    });

    it("returns 404 when server belongs to another user", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const server = await createTestServer(user1.id);

      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}`,
          method: "PUT",
          body: { url: "http://hacked:32400" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Server not found");
    });

    it("returns 400 when URL lacks http/https protocol", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}`,
          method: "PUT",
          body: { url: "plex.local:32400" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 400 when Plex connection test fails for new URL", async () => {
      mockTestConnection.mockResolvedValue({
        ok: false,
        error: "Timeout",
      });

      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}`,
          method: "PUT",
          body: { url: "http://bad:32400" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("Failed to connect");
    });

    it("updates the server URL successfully", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, {
        url: "http://old:32400",
      });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}`,
          method: "PUT",
          body: { url: "http://new:32400" },
        }
      );
      const body = await expectJson<{
        server: { id: string; url: string };
      }>(response, 200);

      expect(body.server.url).toBe("http://new:32400");
    });

    it("updates tlsSkipVerify without testing connection when URL is unchanged", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, {
        url: "http://keep:32400",
      });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: server.id },
        {
          url: `/api/servers/${server.id}`,
          method: "PUT",
          body: { tlsSkipVerify: true },
        }
      );
      const body = await expectJson<{
        server: { id: string; tlsSkipVerify: boolean };
      }>(response, 200);

      expect(body.server.tlsSkipVerify).toBe(true);
      // Connection test should NOT have been called when no URL change
      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    // The stored token goes wherever the URL points — the connection test,
    // then every sync — and a Plex server's token can be the account's own,
    // which signs in to Librariarr.
    it("asks a session with no recent sign-in to confirm it's them before sending the stored token to a new URL", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { url: "http://keep:32400", accessToken: "stored-token" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true, authenticatedAt: STALE });

      for (const body of [{ url: "https://attacker.example" }, { url: "https://attacker.example", enabled: false }]) {
        const response = await callRouteWithParams(
          PUT,
          { id: server.id },
          { url: `/api/servers/${server.id}`, method: "PUT", body }
        );
        const refusal = await expectJson<{ code: string }>(response, 403);
        expect(refusal.code).toBe("reauth_required");
      }

      expect(plexClientTargets()).toEqual([]);
      const stored = await getTestPrisma().mediaServer.findUniqueOrThrow({ where: { id: server.id } });
      expect(stored.url).toBe("http://keep:32400");
    });

    it("lets a stale session re-save the same URL, or change it along with the token", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { url: "http://keep:32400", accessToken: "stored-token" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true, authenticatedAt: STALE });

      // The edit form sends the URL on every save.
      await expectJson(
        await callRouteWithParams(
          PUT,
          { id: server.id },
          { url: `/api/servers/${server.id}`, method: "PUT", body: { url: "http://keep:32400/", tlsSkipVerify: true } }
        ),
        200
      );

      // A replacement token is the caller's own, not the stored one.
      await expectJson(
        await callRouteWithParams(
          PUT,
          { id: server.id },
          { url: `/api/servers/${server.id}`, method: "PUT", body: { url: "http://moved:32400", accessToken: "new-token" } }
        ),
        200
      );
      expect(plexClientTargets()).toContainEqual({ url: "http://moved:32400", token: "new-token" });
      // The stored token only ever went back to the address it already had.
      expect(plexClientTargets().filter((t) => t.token === "stored-token").map((t) => t.url)).toEqual([
        "http://keep:32400/",
      ]);
    });
  });
});
