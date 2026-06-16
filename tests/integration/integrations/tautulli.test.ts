import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestTautulliInstance,
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

const mockTestConnection = vi.fn();

vi.mock("@/lib/tautulli/client", () => ({
  TautulliClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockTestConnection };
  }),
}));

import { GET, POST } from "@/app/api/integrations/tautulli/route";
import { PUT, DELETE } from "@/app/api/integrations/tautulli/[id]/route";
import { POST as TEST_POST } from "@/app/api/integrations/tautulli/[id]/test-connection/route";

describe("Tautulli integration endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, appName: "Living Room", version: "1.40" });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("GET /api/integrations/tautulli", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/integrations/tautulli" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns the user's instances with the apiKey masked", async () => {
      const user = await createTestUser();
      await createTestTautulliInstance(user.id, { name: "My Tautulli", apiKey: "super-secret" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/tautulli" });
      const body = await expectJson<{ instances: { name: string; apiKey: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("My Tautulli");
      expect(body.instances[0].apiKey).not.toBe("super-secret");
      expect(body.instances[0].apiKey).toMatch(/•+/);
    });

    it("does not return another user's instances", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });
      await createTestTautulliInstance(user1.id, { name: "U1" });
      await createTestTautulliInstance(user2.id, { name: "U2" });
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/tautulli" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("U2");
    });
  });

  describe("POST /api/integrations/tautulli", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/integrations/tautulli",
        method: "POST",
        body: { name: "T", url: "http://tautulli:8181", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when required fields are missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const res = await callRoute(POST, {
        url: "/api/integrations/tautulli",
        method: "POST",
        body: { url: "http://tautulli:8181" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when the connection test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Invalid apikey" });
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/tautulli",
        method: "POST",
        body: { name: "Bad", url: "http://bad:8181", apiKey: "key" },
      });
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body.error).toContain("Failed to connect to Tautulli");
      expect(body.detail).toBe("Invalid apikey");
    });

    it("returns 404 when linking to a non-existent media server", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/tautulli",
        method: "POST",
        body: { name: "T", url: "http://tautulli:8181", apiKey: "key", mediaServerId: "does-not-exist" },
      });
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Media server not found");
    });

    it("creates an instance linked to a Plex server and strips trailing slashes", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/tautulli",
        method: "POST",
        body: { name: "My Tautulli", url: "http://tautulli:8181///", apiKey: "test-key", mediaServerId: server.id },
      });
      const body = await expectJson<{ instance: { id: string; name: string; url: string; mediaServerId: string } }>(
        response,
        201
      );
      expect(body.instance.name).toBe("My Tautulli");
      expect(body.instance.url).toBe("http://tautulli:8181");
      expect(body.instance.mediaServerId).toBe(server.id);
    });
  });

  describe("PUT /api/integrations/tautulli/[id]", () => {
    it("returns 404 when the instance belongs to another user", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestTautulliInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        { url: `/api/integrations/tautulli/${instance.id}`, method: "PUT", body: { name: "Hacked" } }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("toggling enabled does not require a connection test", async () => {
      const user = await createTestUser();
      const instance = await createTestTautulliInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        { url: `/api/integrations/tautulli/${instance.id}`, method: "PUT", body: { enabled: false } }
      );
      const body = await expectJson<{ instance: { enabled: boolean } }>(response, 200);
      expect(body.instance.enabled).toBe(false);
      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    it("updates fields successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestTautulliInstance(user.id, { name: "Old" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/tautulli/${instance.id}`,
          method: "PUT",
          body: { name: "New", url: "http://new:8181" },
        }
      );
      const body = await expectJson<{ instance: { name: string; url: string } }>(response, 200);
      expect(body.instance.name).toBe("New");
      expect(body.instance.url).toBe("http://new:8181");
    });
  });

  describe("DELETE /api/integrations/tautulli/[id]", () => {
    it("returns 404 when deleting another user's instance", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestTautulliInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/tautulli/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("deletes the instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestTautulliInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/tautulli/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      const listResponse = await callRoute(GET, { url: "/api/integrations/tautulli" });
      const listBody = await expectJson<{ instances: unknown[] }>(listResponse, 200);
      expect(listBody.instances).toHaveLength(0);
    });
  });

  describe("POST /api/integrations/tautulli/[id]/test-connection", () => {
    it("returns 404 for another user's instance", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestTautulliInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        TEST_POST,
        { id: instance.id },
        { url: `/api/integrations/tautulli/${instance.id}/test-connection`, method: "POST", body: {} }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns the connection result using stored credentials", async () => {
      const user = await createTestUser();
      const instance = await createTestTautulliInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        TEST_POST,
        { id: instance.id },
        { url: `/api/integrations/tautulli/${instance.id}/test-connection`, method: "POST", body: {} }
      );
      const body = await expectJson<{ ok: boolean; appName: string }>(response, 200);
      expect(body.ok).toBe(true);
      expect(body.appName).toBe("Living Room");
    });
  });
});
