import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { MASKED_VALUE } from "@/lib/api/sanitize";
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

vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
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
import { appCache } from "@/lib/cache/memory-cache";
import { INTEGRATIONS_HEALTH_CACHE_KEY } from "@/lib/cache/invalidate";

describe("Seerr integration endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // SeerrClient.testConnection answers this shape for a real Seerr instance.
    mockTestConnection.mockResolvedValue({ ok: true, appName: "Seerr" });
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/seerr" });
      const body = await expectJson<{ instances: unknown[] }>(response, 200);
      expect(body.instances).toEqual([]);
    });

    it("returns instances belonging to the authenticated user", async () => {
      const user = await createTestUser();
      await createTestSeerrInstance(user.id, { name: "My Seerr" });
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/seerr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("My Seerr");
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      // Missing name
      const res1 = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: { url: "http://seerr:5055", apiKey: "key" },
      });
      expect(await expectJson(res1, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^name: /)],
      });

      // Missing url
      const res2 = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: { name: "Seerr", apiKey: "key" },
      });
      expect(await expectJson(res2, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^url: /)],
      });

      // Missing apiKey
      const res3 = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: { name: "Seerr", url: "http://seerr:5055" },
      });
      expect(await expectJson(res3, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^apiKey: /)],
      });

      expect(mockTestConnection).not.toHaveBeenCalled();
      expect(await getTestPrisma().seerrInstance.count()).toBe(0);
    });

    it("creates instance successfully after passing connection test", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      // The stored key never goes back to the browser.
      expect(body.instance).toMatchObject({ apiKey: MASKED_VALUE });
      expect(mockTestConnection).toHaveBeenCalledTimes(1);

      const stored = await getTestPrisma().seerrInstance.findUnique({ where: { id: body.instance.id } });
      expect(stored).toMatchObject({
        userId: user.id,
        name: "My Seerr",
        url: "http://seerr:5055",
        apiKey: "test-key",
        externalUrl: null,
        enabled: true,
      });
    });

    it("stores a normalized external URL, and none when blank", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const withExternal = await expectJson<{ instance: { externalUrl: string | null } }>(
        await callRoute(POST, {
          url: "/api/integrations/seerr",
          method: "POST",
          body: { name: "A", url: "http://seerr:5055", apiKey: "k", externalUrl: "https://requests.example.com/" },
        }),
        201,
      );
      expect(withExternal.instance.externalUrl).toBe("https://requests.example.com");

      const blank = await expectJson<{ instance: { externalUrl: string | null } }>(
        await callRoute(POST, {
          url: "/api/integrations/seerr",
          method: "POST",
          body: { name: "B", url: "http://seerr2:5055", apiKey: "k", externalUrl: "" },
        }),
        201,
      );
      expect(blank.instance.externalUrl).toBeNull();

      const invalid = await callRoute(POST, {
        url: "/api/integrations/seerr",
        method: "POST",
        body: { name: "C", url: "http://seerr3:5055", apiKey: "k", externalUrl: "not a url" },
      });
      expect(await expectJson(invalid, 400)).toMatchObject({
        error: "Validation failed",
        details: [expect.stringMatching(/^externalUrl: /)],
      });
      expect(await getTestPrisma().seerrInstance.count()).toBe(2);
    });

    it("returns error when connection test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      expect(body).toEqual({ error: "Failed to connect to Seerr", detail: "Connection refused" });
      expect(await getTestPrisma().seerrInstance.count()).toBe(0);
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
      setMockSession({ userId: user.id, isLoggedIn: true });

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

    it("updates instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id, { name: "Old Name" });
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

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
      // A new URL is tested before it is saved.
      expect(mockTestConnection).toHaveBeenCalledTimes(1);

      const stored = await getTestPrisma().seerrInstance.findUnique({ where: { id: instance.id } });
      expect(stored).toMatchObject({ name: "Updated Seerr", url: "http://new-seerr:5055" });
    });

    it("sets and clears the external URL without touching other fields", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id, { name: "Keep" });
      setMockSession({ userId: user.id, isLoggedIn: true });
      const put = (body: Record<string, unknown>) =>
        callRouteWithParams(PUT, { id: instance.id }, {
          url: `/api/integrations/seerr/${instance.id}`,
          method: "PUT",
          body,
        });

      const set = await expectJson<{ instance: { name: string; externalUrl: string | null } }>(
        await put({ externalUrl: "https://requests.example.com//" }),
        200,
      );
      expect(set.instance.externalUrl).toBe("https://requests.example.com");
      expect(set.instance.name).toBe("Keep");

      const untouched = await expectJson<{ instance: { externalUrl: string | null } }>(
        await put({ name: "Renamed" }),
        200,
      );
      expect(untouched.instance.externalUrl).toBe("https://requests.example.com");

      const cleared = await expectJson<{ instance: { externalUrl: string | null } }>(
        await put({ externalUrl: "" }),
        200,
      );
      expect(cleared.instance.externalUrl).toBeNull();

      // No URL or key changed, so nothing was tested.
      expect(mockTestConnection).not.toHaveBeenCalled();
      const stored = await getTestPrisma().seerrInstance.findUnique({ where: { id: instance.id } });
      expect(stored).toMatchObject({ name: "Renamed", url: instance.url, externalUrl: null });
    });

    it("saves a rename and a new external URL while the instance is unreachable", async () => {
      // The edit form sends its (unchanged) URL on every save; testing on its
      // mere presence refused every edit while Seerr was down.
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/seerr/${instance.id}`,
          method: "PUT",
          body: { name: "Renamed", url: `${instance.url}/`, externalUrl: "https://requests.example.com" },
        }
      );
      const body = await expectJson<{ instance: { name: string; externalUrl: string } }>(response, 200);
      expect(body.instance).toMatchObject({ name: "Renamed", externalUrl: "https://requests.example.com" });
      expect(mockTestConnection).not.toHaveBeenCalled();

      const stored = await getTestPrisma().seerrInstance.findUnique({ where: { id: instance.id } });
      expect(stored).toMatchObject({
        name: "Renamed",
        url: instance.url,
        externalUrl: "https://requests.example.com",
      });
    });

    it("returns error when connection test fails on update", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });

      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/seerr/${instance.id}`,
          method: "PUT",
          body: { url: "http://bad:5055" },
        }
      );
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body).toEqual({ error: "Failed to connect", detail: "Timeout" });

      const stored = await getTestPrisma().seerrInstance.findUnique({ where: { id: instance.id } });
      expect(stored!.url).toBe(instance.url);
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
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

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

    it("drops cached Seerr-derived answers so a removed instance stops being reported", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });
      appCache.set("seerr-request-stats", { configured: true });
      appCache.set("seerr-user-requests:alice", { requests: [] });
      appCache.set(INTEGRATIONS_HEALTH_CACHE_KEY, { ok: true });

      await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/seerr/${instance.id}`, method: "DELETE" }
      );

      expect(appCache.get("seerr-request-stats")).toBeUndefined();
      expect(appCache.get("seerr-user-requests:alice")).toBeUndefined();
      expect(appCache.get(INTEGRATIONS_HEALTH_CACHE_KEY)).toBeUndefined();
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const res1 = await callRoute(TEST_POST, {
        url: "/api/integrations/seerr/test",
        method: "POST",
        body: { apiKey: "key" },
      });
      expect(await expectJson(res1, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^url: /)],
      });

      const res2 = await callRoute(TEST_POST, {
        url: "/api/integrations/seerr/test",
        method: "POST",
        body: { url: "http://seerr:5055" },
      });
      expect(await expectJson(res2, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^apiKey: /)],
      });
      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    it("returns test result", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/seerr/test",
        method: "POST",
        body: { url: "http://seerr:5055", apiKey: "test-key" },
      });
      const body = await expectJson(response, 200);
      expect(body).toEqual({ ok: true, appName: "Seerr" });
    });

    it("scrubs a private address from a failed test's error", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "connect ECONNREFUSED 192.168.1.20:5055" });
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/seerr/test",
        method: "POST",
        body: { url: "http://192.168.1.20:5055", apiKey: "test-key" },
      });
      const body = await expectJson(response, 200);
      expect(body).toEqual({ ok: false, error: "connect ECONNREFUSED [internal]:5055" });
    });
  });
});
