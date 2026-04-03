import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestSeerrInstance,
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

vi.mock("@/lib/seerr/seerr-client", () => ({
  SeerrClient: vi.fn().mockImplementation(function () {
    return {
      testConnection: mockTestConnection,
    };
  }),
}));

// Import route handlers AFTER mocks
import { GET, POST } from "@/app/api/integrations/seerr/route";
import { PUT, DELETE } from "@/app/api/integrations/seerr/[id]/route";
import { POST as TEST_POST } from "@/app/api/integrations/seerr/test/route";

describe("Seerr integration endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/integrations/seerr -----

  describe("GET /api/integrations/seerr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/integrations/seerr" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty instances when user has none", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/seerr" });
      const body = await expectJson<{ instances: unknown[] }>(response, 200);
      expect(body.instances).toEqual([]);
    });

    it("returns instances belonging to the authenticated user", async () => {
      const user = await createTestUser();
      await createTestSeerrInstance(user.id, { name: "My Seerr" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/seerr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("My Seerr");
    });

    it("does not return instances belonging to another user", async () => {
      const user1 = await createTestUser({ plexId: "user1" });
      const user2 = await createTestUser({ plexId: "user2" });
      await createTestSeerrInstance(user1.id, { name: "User1 Seerr" });
      await createTestSeerrInstance(user2.id, { name: "User2 Seerr" });
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/seerr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("User2 Seerr");
    });
  });

  // ----- POST /api/integrations/seerr -----

  describe("POST /api/integrations/seerr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: { name: "Seerr", url: "http://seerr:5055", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when required fields are missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Missing name
      const res1 = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: { url: "http://seerr:5055", apiKey: "key" },
      });
      expect(res1.status).toBe(400);

      // Missing url
      const res2 = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: { name: "Seerr", apiKey: "key" },
      });
      expect(res2.status).toBe(400);

      // Missing apiKey
      const res3 = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: { name: "Seerr", url: "http://seerr:5055" },
      });
      expect(res3.status).toBe(400);
    });

    it("creates instance successfully after passing connection test", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: {
          name: "My Seerr",
          url: "http://seerr:5055",
          // file deepcode ignore HardcodedNonCryptoSecret/test: test file
          apiKey: "test-key",
        },
      });
      const body = await expectJson<{
        instance: { id: string; name: string; url: string };
      }>(response, 201);
      expect(body.instance.name).toBe("My Seerr");
      expect(body.instance.url).toBe("http://seerr:5055");
      expect(body.instance.id).toBeDefined();
    });

    it("returns error when connection test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: {
          name: "Bad Seerr",
          url: "http://bad:5055",
          apiKey: "key",
        },
      });
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body.error).toContain("Failed to connect");
      expect(body.detail).toBe("Connection refused");
    });
  });

  // ----- PUT /api/integrations/seerr/[id] -----

  describe("PUT /api/integrations/seerr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        PUT,
        { id: "nonexistent" },
        { url: "/api/integrations/seerr/nonexistent", method: "PUT", body: { name: "New" } }
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
          url: "/api/integrations/seerr/00000000-0000-0000-0000-000000000000",
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
      const instance = await createTestSeerrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/seerr/${instance.id}`,
          method: "PUT",
          body: { name: "Hacked" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("updates instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id, { name: "Old Name" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/seerr/${instance.id}`,
          method: "PUT",
          body: { name: "Updated Seerr", url: "http://new-seerr:5055" },
        }
      );
      const body = await expectJson<{ instance: { name: string; url: string } }>(response, 200);
      expect(body.instance.name).toBe("Updated Seerr");
      expect(body.instance.url).toBe("http://new-seerr:5055");
    });

    it("returns error when connection test fails on update", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });

      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/seerr/${instance.id}`,
          method: "PUT",
          body: { url: "http://bad:5055" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("Failed to connect");
    });
  });

  // ----- DELETE /api/integrations/seerr/[id] -----

  describe("DELETE /api/integrations/seerr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        DELETE,
        { id: "nonexistent" },
        { url: "/api/integrations/seerr/nonexistent", method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent instance", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: "00000000-0000-0000-0000-000000000000" },
        {
          url: "/api/integrations/seerr/00000000-0000-0000-0000-000000000000",
          method: "DELETE",
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("deletes instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/seerr/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      // Verify it's gone
      const listResponse = await callRoute(GET, { url: "/api/integrations/seerr" });
      const listBody = await expectJson<{ instances: unknown[] }>(listResponse, 200);
      expect(listBody.instances).toHaveLength(0);
    });
  });

  // ----- POST /api/integrations/seerr/test -----

  describe("POST /api/integrations/seerr/test", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/seerr/test",
        method: "POST",
        body: { url: "http://seerr:5055", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when url or apiKey missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const res1 = await callRoute(TEST_POST, {
        url: "/api/integrations/seerr/test",
        method: "POST",
        body: { apiKey: "key" },
      });
      expect(res1.status).toBe(400);

      const res2 = await callRoute(TEST_POST, {
        url: "/api/integrations/seerr/test",
        method: "POST",
        body: { url: "http://seerr:5055" },
      });
      expect(res2.status).toBe(400);
    });

    it("returns test result", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/seerr/test",
        method: "POST",
        body: { url: "http://seerr:5055", apiKey: "test-key" },
      });
      const body = await expectJson<{ ok: boolean }>(response, 200);
      expect(body.ok).toBe(true);
    });
  });
});
