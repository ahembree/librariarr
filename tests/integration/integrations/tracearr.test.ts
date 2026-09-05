import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestTracearrInstance,
} from "../../setup/test-helpers";
import { MASKED_VALUE } from "@/lib/api/sanitize";

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

// `clientArgs` records the credentials each construction was handed, which is
// the only way to assert that a masked API key fell back to the stored one.
const { mockTestConnection, mockListServers, clientArgs } = vi.hoisted(() => ({
  mockTestConnection: vi.fn(),
  mockListServers: vi.fn(),
  clientArgs: [] as Array<{ url: string; apiKey: string }>,
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  TracearrClient: vi.fn().mockImplementation(function (url: string, apiKey: string) {
    clientArgs.push({ url, apiKey });
    return {
      testConnection: mockTestConnection,
      listServers: mockListServers,
    };
  }),
}));

// Import route handlers AFTER mocks
import { GET, POST } from "@/app/api/integrations/tracearr/route";
import { PUT, DELETE } from "@/app/api/integrations/tracearr/[id]/route";
import { POST as TEST_POST } from "@/app/api/integrations/tracearr/[id]/test-connection/route";
import { GET as SERVERS_GET } from "@/app/api/integrations/tracearr/[id]/servers/route";

const TRACEARR_SERVERS = [
  { id: "11111111-1111-1111-1111-111111111111", name: "Plex", type: "plex", online: true, activeStreams: 2 },
  { id: "22222222-2222-2222-2222-222222222222", name: "Jelly", type: "jellyfin", online: false, activeStreams: 0 },
];

describe("Tracearr integration endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    clientArgs.length = 0;
    mockTestConnection.mockResolvedValue({ ok: true, version: "2.0.0", serverCount: 2 });
    mockListServers.mockResolvedValue(TRACEARR_SERVERS);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/integrations/tracearr -----

  describe("GET /api/integrations/tracearr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/integrations/tracearr" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty instances when user has none", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/tracearr" });
      const body = await expectJson<{ instances: unknown[] }>(response, 200);
      expect(body.instances).toEqual([]);
    });

    it("returns the authenticated user's instances with the apiKey masked", async () => {
      const user = await createTestUser();
      await createTestTracearrInstance(user.id, { name: "My Tracearr" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/tracearr" });
      const body = await expectJson<{ instances: { name: string; apiKey: string }[] }>(
        response,
        200
      );
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("My Tracearr");
      expect(body.instances[0].apiKey).toBe(MASKED_VALUE);
    });

    it("does not return instances belonging to another user", async () => {
      const user1 = await createTestUser({ plexId: "user1" });
      const user2 = await createTestUser({ plexId: "user2" });
      await createTestTracearrInstance(user1.id, { name: "User1 Tracearr" });
      await createTestTracearrInstance(user2.id, { name: "User2 Tracearr" });
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/tracearr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("User2 Tracearr");
    });
  });

  // ----- POST /api/integrations/tracearr -----

  describe("POST /api/integrations/tracearr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/integrations/tracearr",
        method: "POST",
        body: { name: "Tracearr", url: "http://tracearr:3000", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when required fields are missing or malformed", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Missing name
      const res1 = await callRoute(POST, {
        url: "/api/integrations/tracearr",
        method: "POST",
        body: { url: "http://tracearr:3000", apiKey: "key" },
      });
      expect(res1.status).toBe(400);

      // URL without an http(s) scheme
      const res2 = await callRoute(POST, {
        url: "/api/integrations/tracearr",
        method: "POST",
        body: { name: "Tracearr", url: "tracearr:3000", apiKey: "key" },
      });
      expect(res2.status).toBe(400);

      // Empty apiKey
      const res3 = await callRoute(POST, {
        url: "/api/integrations/tracearr",
        method: "POST",
        body: { name: "Tracearr", url: "http://tracearr:3000", apiKey: "" },
      });
      expect(res3.status).toBe(400);

      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    it("creates the instance after passing the connection test, masking the key in the response", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/tracearr",
        method: "POST",
        body: {
          name: "My Tracearr",
          url: "http://tracearr:3000",
          // file deepcode ignore HardcodedNonCryptoSecret/test: test file
          apiKey: "trr_pub_real-key",
        },
      });
      const body = await expectJson<{
        instance: { id: string; name: string; url: string; apiKey: string; enabled: boolean };
      }>(response, 201);
      expect(body.instance.name).toBe("My Tracearr");
      expect(body.instance.url).toBe("http://tracearr:3000");
      expect(body.instance.enabled).toBe(true);
      expect(body.instance.apiKey).toBe(MASKED_VALUE);

      // The row must hold the REAL key — only the response is masked.
      const stored = await getTestPrisma().tracearrInstance.findUnique({
        where: { id: body.instance.id },
      });
      expect(stored?.apiKey).toBe("trr_pub_real-key");
    });

    it("strips trailing slashes from the url before persisting", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/tracearr",
        method: "POST",
        body: { name: "Slashy", url: "http://tracearr:3000///", apiKey: "key" },
      });
      const body = await expectJson<{ instance: { url: string } }>(response, 201);
      expect(body.instance.url).toBe("http://tracearr:3000");
    });

    it("returns 400 and persists nothing when the connection test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/tracearr",
        method: "POST",
        body: { name: "Bad Tracearr", url: "http://bad:3000", apiKey: "key" },
      });
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body.error).toBe("Failed to connect to Tracearr");
      expect(body.detail).toBe("Connection refused");

      expect(await getTestPrisma().tracearrInstance.count()).toBe(0);
    });
  });

  // ----- PUT /api/integrations/tracearr/[id] -----

  describe("PUT /api/integrations/tracearr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        PUT,
        { id: "nonexistent" },
        {
          url: "/api/integrations/tracearr/nonexistent",
          method: "PUT",
          body: { name: "New" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent instance", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: "00000000-0000-0000-0000-000000000000" },
        {
          url: "/api/integrations/tracearr/00000000-0000-0000-0000-000000000000",
          method: "PUT",
          body: { name: "New" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns 404 when trying to update another user's instance", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestTracearrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}`,
          method: "PUT",
          body: { name: "Hacked" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");

      const stored = await getTestPrisma().tracearrInstance.findUnique({
        where: { id: instance.id },
      });
      expect(stored?.name).toBe("Test Tracearr");
    });

    it("renames the instance without re-testing the connection", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id, { name: "Old Name" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}`,
          method: "PUT",
          body: { name: "Updated Tracearr" },
        }
      );
      const body = await expectJson<{ instance: { name: string } }>(response, 200);
      expect(body.instance.name).toBe("Updated Tracearr");
      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    it("keeps the stored apiKey when the masked value is echoed back", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id, { apiKey: "trr_pub_original" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}`,
          method: "PUT",
          body: { name: "Renamed", apiKey: MASKED_VALUE },
        }
      );
      const body = await expectJson<{ instance: { name: string; apiKey: string } }>(response, 200);
      expect(body.instance.name).toBe("Renamed");
      expect(body.instance.apiKey).toBe(MASKED_VALUE);

      // The mask is not a credential change, so nothing is re-tested and the
      // stored key survives.
      expect(mockTestConnection).not.toHaveBeenCalled();
      const stored = await getTestPrisma().tracearrInstance.findUnique({
        where: { id: instance.id },
      });
      expect(stored?.apiKey).toBe("trr_pub_original");
    });

    it("re-tests and persists a new apiKey", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id, { apiKey: "trr_pub_original" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}`,
          method: "PUT",
          body: { apiKey: "trr_pub_rotated" },
        }
      );
      await expectJson<{ instance: { id: string } }>(response, 200);

      expect(mockTestConnection).toHaveBeenCalledTimes(1);
      expect(clientArgs).toEqual([
        { url: "http://tracearr.test:3000", apiKey: "trr_pub_rotated" },
      ]);
      const stored = await getTestPrisma().tracearrInstance.findUnique({
        where: { id: instance.id },
      });
      expect(stored?.apiKey).toBe("trr_pub_rotated");
    });

    it("updates the url and strips its trailing slashes", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}`,
          method: "PUT",
          body: { url: "http://new-tracearr:3000/" },
        }
      );
      const body = await expectJson<{ instance: { url: string } }>(response, 200);
      expect(body.instance.url).toBe("http://new-tracearr:3000");
      expect(mockTestConnection).toHaveBeenCalledTimes(1);
    });

    it("skips the connection test when disabling the instance", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}`,
          method: "PUT",
          body: { enabled: false, url: "http://unreachable:3000" },
        }
      );
      const body = await expectJson<{ instance: { enabled: boolean; url: string } }>(
        response,
        200
      );
      expect(body.instance.enabled).toBe(false);
      expect(body.instance.url).toBe("http://unreachable:3000");
      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    it("returns 400 when the connection re-test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });

      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}`,
          method: "PUT",
          body: { url: "http://bad:3000" },
        }
      );
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body.error).toBe("Failed to connect");
      expect(body.detail).toBe("Timeout");

      const stored = await getTestPrisma().tracearrInstance.findUnique({
        where: { id: instance.id },
      });
      expect(stored?.url).toBe("http://tracearr.test:3000");
    });
  });

  // ----- DELETE /api/integrations/tracearr/[id] -----

  describe("DELETE /api/integrations/tracearr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        DELETE,
        { id: "nonexistent" },
        { url: "/api/integrations/tracearr/nonexistent", method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 when trying to delete another user's instance", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestTracearrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/tracearr/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");

      expect(await getTestPrisma().tracearrInstance.count()).toBe(1);
    });

    it("deletes the instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/tracearr/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      expect(await getTestPrisma().tracearrInstance.count()).toBe(0);
    });
  });

  // ----- POST /api/integrations/tracearr/[id]/test-connection -----

  describe("POST /api/integrations/tracearr/[id]/test-connection", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        TEST_POST,
        { id: "nonexistent" },
        {
          url: "/api/integrations/tracearr/nonexistent/test-connection",
          method: "POST",
          body: {},
        }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 when testing another user's instance", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestTracearrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        TEST_POST,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}/test-connection`,
          method: "POST",
          body: {},
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    it("returns the successful test result using the stored credentials", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id, { apiKey: "trr_pub_stored" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        TEST_POST,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}/test-connection`,
          method: "POST",
          body: {},
        }
      );
      const body = await expectJson<{ ok: boolean; version: string; serverCount: number }>(
        response,
        200
      );
      expect(body.ok).toBe(true);
      expect(body.version).toBe("2.0.0");
      expect(body.serverCount).toBe(2);
      expect(clientArgs).toEqual([
        { url: "http://tracearr.test:3000", apiKey: "trr_pub_stored" },
      ]);
    });

    it("falls back to the stored apiKey when the masked value is sent", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id, { apiKey: "trr_pub_stored" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        TEST_POST,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}/test-connection`,
          method: "POST",
          body: { url: "http://other-tracearr:3000", apiKey: MASKED_VALUE },
        }
      );
      await expectJson<{ ok: boolean }>(response, 200);
      expect(clientArgs).toEqual([
        { url: "http://other-tracearr:3000", apiKey: "trr_pub_stored" },
      ]);
    });

    it("uses a supplied apiKey when one is given", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id, { apiKey: "trr_pub_stored" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        TEST_POST,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}/test-connection`,
          method: "POST",
          body: { apiKey: "trr_pub_typed" },
        }
      );
      await expectJson<{ ok: boolean }>(response, 200);
      expect(clientArgs).toEqual([
        { url: "http://tracearr.test:3000", apiKey: "trr_pub_typed" },
      ]);
    });

    it("returns the failed test result verbatim", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Unauthorized (401)" });

      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        TEST_POST,
        { id: instance.id },
        {
          url: `/api/integrations/tracearr/${instance.id}/test-connection`,
          method: "POST",
          body: {},
        }
      );
      const body = await expectJson<{ ok: boolean; error: string }>(response, 200);
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Unauthorized (401)");
    });
  });

  // ----- GET /api/integrations/tracearr/[id]/servers -----

  describe("GET /api/integrations/tracearr/[id]/servers", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        SERVERS_GET,
        { id: "nonexistent" },
        { url: "/api/integrations/tracearr/nonexistent/servers" }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for another user's instance", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestTracearrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        SERVERS_GET,
        { id: instance.id },
        { url: `/api/integrations/tracearr/${instance.id}/servers` }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
      expect(mockListServers).not.toHaveBeenCalled();
    });

    it("returns the media servers the instance monitors", async () => {
      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id, { apiKey: "trr_pub_stored" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        SERVERS_GET,
        { id: instance.id },
        { url: `/api/integrations/tracearr/${instance.id}/servers` }
      );
      const body = await expectJson<{ servers: typeof TRACEARR_SERVERS }>(response, 200);
      expect(body.servers).toEqual(TRACEARR_SERVERS);
      expect(clientArgs).toEqual([
        { url: "http://tracearr.test:3000", apiKey: "trr_pub_stored" },
      ]);
    });

    it("returns 400 with a readable detail when the client throws", async () => {
      mockListServers.mockRejectedValue(new Error("Tracearr: connect ECONNREFUSED"));

      const user = await createTestUser();
      const instance = await createTestTracearrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        SERVERS_GET,
        { id: instance.id },
        { url: `/api/integrations/tracearr/${instance.id}/servers` }
      );
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body.error).toBe("Failed to query Tracearr");
      expect(body.detail).toBe("Tracearr: connect ECONNREFUSED");
    });
  });
});
