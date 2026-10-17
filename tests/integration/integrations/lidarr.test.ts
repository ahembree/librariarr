import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { MASKED_VALUE } from "@/lib/api/sanitize";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestLidarrInstance,
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
const mockGetArtists = vi.fn();
const mockGetQualityProfiles = vi.fn();
const mockGetTags = vi.fn();

vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function () {
    return {
      testConnection: mockTestConnection,
      getArtists: mockGetArtists,
      getQualityProfiles: mockGetQualityProfiles,
      getTags: mockGetTags,
    };
  }),
}));

// Import route handlers AFTER mocks
import { GET, POST } from "@/app/api/integrations/lidarr/route";
import { PUT, DELETE } from "@/app/api/integrations/lidarr/[id]/route";
import { POST as TEST_POST } from "@/app/api/integrations/lidarr/test/route";
import { GET as METADATA_GET } from "@/app/api/integrations/lidarr/[id]/metadata/route";

describe("Lidarr integration endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, appName: "Lidarr", version: "2.9.6.4552" });
    mockGetArtists.mockResolvedValue([]);
    mockGetQualityProfiles.mockResolvedValue([{ id: 1, name: "Lossless" }]);
    mockGetTags.mockResolvedValue([{ id: 1, label: "test-tag" }]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/integrations/lidarr -----

  describe("GET /api/integrations/lidarr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/integrations/lidarr" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty instances when user has none", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/lidarr" });
      const body = await expectJson<{ instances: unknown[] }>(response, 200);
      expect(body.instances).toEqual([]);
    });

    it("returns instances belonging to the authenticated user", async () => {
      const user = await createTestUser();
      await createTestLidarrInstance(user.id, { name: "My Lidarr" });
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/lidarr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("My Lidarr");
    });
  });

  // ----- POST /api/integrations/lidarr -----

  describe("POST /api/integrations/lidarr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { name: "Lidarr", url: "http://lidarr:8686", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when required fields are missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      // Missing name
      const res1 = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { url: "http://lidarr:8686", apiKey: "key" },
      });
      expect(await expectJson(res1, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^name: /)],
      });

      // Missing url
      const res2 = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { name: "Lidarr", apiKey: "key" },
      });
      expect(await expectJson(res2, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^url: /)],
      });

      // Missing apiKey
      const res3 = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { name: "Lidarr", url: "http://lidarr:8686" },
      });
      expect(await expectJson(res3, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^apiKey: /)],
      });

      expect(mockTestConnection).not.toHaveBeenCalled();
      expect(await getTestPrisma().lidarrInstance.count()).toBe(0);
    });

    it("returns 400 when connection test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { name: "Bad Lidarr", url: "http://bad:8686", apiKey: "key" },
      });
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body).toEqual({ error: "Failed to connect to Lidarr", detail: "Connection refused" });
      expect(await getTestPrisma().lidarrInstance.count()).toBe(0);
    });

    it("creates a new instance on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        // file deepcode ignore HardcodedNonCryptoSecret/test: test file
        body: { name: "My Lidarr", url: "http://lidarr:8686", apiKey: "test-key" },
      });
      const body = await expectJson<{ instance: { id: string; name: string; url: string } }>(
        response,
        201
      );
      expect(body.instance.name).toBe("My Lidarr");
      expect(body.instance.url).toBe("http://lidarr:8686");
      // The stored key never goes back to the browser.
      expect(body.instance).toMatchObject({ apiKey: MASKED_VALUE });
      expect(mockTestConnection).toHaveBeenCalledTimes(1);

      const stored = await getTestPrisma().lidarrInstance.findUnique({ where: { id: body.instance.id } });
      expect(stored).toMatchObject({
        userId: user.id,
        name: "My Lidarr",
        url: "http://lidarr:8686",
        apiKey: "test-key",
        externalUrl: null,
        enabled: true,
      });
    });

    it("strips trailing slashes from url", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { name: "Lidarr", url: "http://lidarr:8686///", apiKey: "test-key" },
      });
      const body = await expectJson<{ instance: { url: string } }>(response, 201);
      expect(body.instance.url).toBe("http://lidarr:8686");
    });
  });

  // ----- PUT /api/integrations/lidarr/[id] -----

  describe("PUT /api/integrations/lidarr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        PUT,
        { id: "nonexistent" },
        { url: "/api/integrations/lidarr/nonexistent", method: "PUT", body: { name: "New" } }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 when instance does not exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: "00000000-0000-0000-0000-000000000000" },
        {
          url: "/api/integrations/lidarr/00000000-0000-0000-0000-000000000000",
          method: "PUT",
          body: { name: "New" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns 400 when connection test fails on update", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });

      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/lidarr/${instance.id}`,
          method: "PUT",
          body: { url: "http://bad:8686" },
        }
      );
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body).toEqual({ error: "Failed to connect to Lidarr", detail: "Timeout" });

      const stored = await getTestPrisma().lidarrInstance.findUnique({ where: { id: instance.id } });
      expect(stored!.url).toBe(instance.url);
    });

    it("updates instance fields successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id, { name: "Old Name" });
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/lidarr/${instance.id}`,
          method: "PUT",
          body: { name: "Updated Lidarr", url: "http://new-lidarr:8686" },
        }
      );
      const body = await expectJson<{ instance: { name: string; url: string } }>(response, 200);
      expect(body.instance.name).toBe("Updated Lidarr");
      expect(body.instance.url).toBe("http://new-lidarr:8686");
      // A new URL is tested before it is saved.
      expect(mockTestConnection).toHaveBeenCalledTimes(1);

      const stored = await getTestPrisma().lidarrInstance.findUnique({ where: { id: instance.id } });
      expect(stored).toMatchObject({ name: "Updated Lidarr", url: "http://new-lidarr:8686" });
    });
  });

  // ----- DELETE /api/integrations/lidarr/[id] -----

  describe("DELETE /api/integrations/lidarr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        DELETE,
        { id: "nonexistent" },
        { url: "/api/integrations/lidarr/nonexistent", method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 when instance does not exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: "00000000-0000-0000-0000-000000000000" },
        {
          url: "/api/integrations/lidarr/00000000-0000-0000-0000-000000000000",
          method: "DELETE",
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("deletes instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/lidarr/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      // Verify it's gone
      const listResponse = await callRoute(GET, { url: "/api/integrations/lidarr" });
      const listBody = await expectJson<{ instances: unknown[] }>(listResponse, 200);
      expect(listBody.instances).toHaveLength(0);
    });
  });

  // ----- POST /api/integrations/lidarr/test -----

  describe("POST /api/integrations/lidarr/test", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/lidarr/test",
        method: "POST",
        body: { url: "http://lidarr:8686", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when required fields are missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const res1 = await callRoute(TEST_POST, {
        url: "/api/integrations/lidarr/test",
        method: "POST",
        body: { apiKey: "key" },
      });
      expect(await expectJson(res1, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^url: /)],
      });

      const res2 = await callRoute(TEST_POST, {
        url: "/api/integrations/lidarr/test",
        method: "POST",
        body: { url: "http://lidarr:8686" },
      });
      expect(await expectJson(res2, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^apiKey: /)],
      });
      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    it("returns connection test result on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/lidarr/test",
        method: "POST",
        body: { url: "http://lidarr:8686", apiKey: "test-key" },
      });
      const body = await expectJson<{ ok: boolean; appName: string }>(response, 200);
      expect(body.ok).toBe(true);
      expect(body.appName).toBe("Lidarr");
    });

    it("returns connection test failure result", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/lidarr/test",
        method: "POST",
        body: { url: "http://bad:8686", apiKey: "key" },
      });
      const body = await expectJson<{ ok: boolean; error: string }>(response, 200);
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Connection refused");
    });

    it("does not save instance to database", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await callRoute(TEST_POST, {
        url: "/api/integrations/lidarr/test",
        method: "POST",
        body: { url: "http://lidarr:8686", apiKey: "key" },
      });

      // Verify nothing was saved
      const listResponse = await callRoute(GET, { url: "/api/integrations/lidarr" });
      const listBody = await expectJson<{ instances: unknown[] }>(listResponse, 200);
      expect(listBody.instances).toHaveLength(0);
    });
  });

  // ----- GET /api/integrations/lidarr/[id]/metadata -----

  describe("GET /api/integrations/lidarr/[id]/metadata", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(METADATA_GET, { id: "any" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 when instance does not exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(METADATA_GET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Instance not found");
    });

    it("returns artist lookup, tags, and quality profiles", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockGetArtists.mockResolvedValue([
        {
          id: 7,
          artistName: "Radiohead",
          foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
          qualityProfileId: 1,
          metadataProfileId: 1,
          monitored: true,
          path: "/music/Radiohead",
          tags: [1],
          ratings: { votes: 412, value: 9.1 },
          status: "continuing",
        },
      ]);

      const response = await callRouteWithParams(METADATA_GET, { id: instance.id });
      const body = await expectJson(response, 200);

      expect(body).toEqual({
        artists: {
          "a74b1b7f-71a5-4011-9441-d0b5e4122711": {
            tags: ["test-tag"],
            qualityProfile: "Lossless",
            monitored: true,
            rating: 9.1,
          },
        },
        tags: [{ id: 1, label: "test-tag" }],
        qualityProfiles: [{ id: 1, name: "Lossless" }],
        statuses: ["continuing"],
      });
    });
  });
});
