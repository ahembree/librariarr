import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
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
    mockTestConnection.mockResolvedValue({ ok: true, appName: "Lidarr", version: "2.0" });
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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/lidarr" });
      const body = await expectJson<{ instances: unknown[] }>(response, 200);
      expect(body.instances).toEqual([]);
    });

    it("returns instances belonging to the authenticated user", async () => {
      const user = await createTestUser();
      await createTestLidarrInstance(user.id, { name: "My Lidarr" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/lidarr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("My Lidarr");
    });

    it("does not return instances belonging to another user", async () => {
      const user1 = await createTestUser({ plexId: "user1" });
      const user2 = await createTestUser({ plexId: "user2" });
      await createTestLidarrInstance(user1.id, { name: "User1 Lidarr" });
      await createTestLidarrInstance(user2.id, { name: "User2 Lidarr" });
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/lidarr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("User2 Lidarr");
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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Missing name
      const res1 = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { url: "http://lidarr:8686", apiKey: "key" },
      });
      expect(res1.status).toBe(400);

      // Missing url
      const res2 = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { name: "Lidarr", apiKey: "key" },
      });
      expect(res2.status).toBe(400);

      // Missing apiKey
      const res3 = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { name: "Lidarr", url: "http://lidarr:8686" },
      });
      expect(res3.status).toBe(400);
    });

    it("returns 400 when connection test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { name: "Bad Lidarr", url: "http://bad:8686", apiKey: "key" },
      });
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body.error).toContain("Failed to connect to Lidarr");
      expect(body.detail).toBe("Connection refused");
    });

    it("creates a new instance on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/lidarr",
        method: "POST",
        body: { name: "My Lidarr", url: "http://lidarr:8686", apiKey: "test-key" },
      });
      const body = await expectJson<{ instance: { id: string; name: string; url: string } }>(
        response,
        201
      );
      expect(body.instance.name).toBe("My Lidarr");
      expect(body.instance.url).toBe("http://lidarr:8686");
      expect(body.instance.id).toBeDefined();
    });

    it("strips trailing slashes from url", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    it("returns 404 when instance belongs to another user", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestLidarrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        { url: `/api/integrations/lidarr/${instance.id}`, method: "PUT", body: { name: "Hacked" } }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns 400 when connection test fails on update", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });

      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/lidarr/${instance.id}`,
          method: "PUT",
          body: { url: "http://bad:8686" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("Failed to connect to Lidarr");
    });

    it("updates instance fields successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id, { name: "Old Name" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    it("returns 404 when deleting another user's instance", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestLidarrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/lidarr/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("deletes instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const res1 = await callRoute(TEST_POST, {
        url: "/api/integrations/lidarr/test",
        method: "POST",
        body: { apiKey: "key" },
      });
      expect(res1.status).toBe(400);

      const res2 = await callRoute(TEST_POST, {
        url: "/api/integrations/lidarr/test",
        method: "POST",
        body: { url: "http://lidarr:8686" },
      });
      expect(res2.status).toBe(400);
    });

    it("returns connection test result on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(METADATA_GET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Instance not found");
    });

    it("returns artist lookup, tags, and quality profiles", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockGetArtists.mockResolvedValue([
        {
          foreignArtistId: "artist-abc-123",
          tags: [1],
          qualityProfileId: 1,
          monitored: true,
          ratings: { value: 9.1 },
        },
      ]);

      const response = await callRouteWithParams(METADATA_GET, { id: instance.id });
      const body = await expectJson<{
        artists: Record<string, { tags: string[]; qualityProfile: string; monitored: boolean; rating: number | null }>;
        tags: { id: number; label: string }[];
        qualityProfiles: { id: number; name: string }[];
      }>(response, 200);

      expect(body.artists["artist-abc-123"]).toBeDefined();
      expect(body.artists["artist-abc-123"].tags).toEqual(["test-tag"]);
      expect(body.artists["artist-abc-123"].qualityProfile).toBe("Lossless");
      expect(body.artists["artist-abc-123"].monitored).toBe(true);
      expect(body.artists["artist-abc-123"].rating).toBe(9.1);
      expect(body.tags).toHaveLength(1);
      expect(body.qualityProfiles).toHaveLength(1);
    });
  });
});
