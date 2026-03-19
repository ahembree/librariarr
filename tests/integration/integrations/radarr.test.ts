import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestRadarrInstance,
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
const mockGetMovies = vi.fn();
const mockGetQualityProfiles = vi.fn();
const mockGetTags = vi.fn();
const mockGetLanguages = vi.fn();

vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function () {
    return {
      testConnection: mockTestConnection,
      getMovies: mockGetMovies,
      getQualityProfiles: mockGetQualityProfiles,
      getTags: mockGetTags,
      getLanguages: mockGetLanguages,
    };
  }),
}));

// Import route handlers AFTER mocks
import { GET, POST } from "@/app/api/integrations/radarr/route";
import { PUT, DELETE } from "@/app/api/integrations/radarr/[id]/route";
import { POST as TEST_POST } from "@/app/api/integrations/radarr/test/route";
import { GET as METADATA_GET } from "@/app/api/integrations/radarr/[id]/metadata/route";

describe("Radarr integration endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, appName: "Radarr", version: "5.0" });
    mockGetMovies.mockResolvedValue([]);
    mockGetQualityProfiles.mockResolvedValue([{ id: 1, name: "HD-1080p" }]);
    mockGetTags.mockResolvedValue([{ id: 1, label: "test-tag" }]);
    mockGetLanguages.mockResolvedValue([{ id: 1, name: "English" }]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/integrations/radarr -----

  describe("GET /api/integrations/radarr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/integrations/radarr" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty instances when user has none", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/radarr" });
      const body = await expectJson<{ instances: unknown[] }>(response, 200);
      expect(body.instances).toEqual([]);
    });

    it("returns instances belonging to the authenticated user", async () => {
      const user = await createTestUser();
      await createTestRadarrInstance(user.id, { name: "My Radarr" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/radarr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("My Radarr");
    });

    it("does not return instances belonging to another user", async () => {
      const user1 = await createTestUser({ plexId: "user1" });
      const user2 = await createTestUser({ plexId: "user2" });
      await createTestRadarrInstance(user1.id, { name: "User1 Radarr" });
      await createTestRadarrInstance(user2.id, { name: "User2 Radarr" });
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/radarr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("User2 Radarr");
    });
  });

  // ----- POST /api/integrations/radarr -----

  describe("POST /api/integrations/radarr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/integrations/radarr",
        method: "POST",
        body: { name: "Radarr", url: "http://radarr:7878", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when required fields are missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Missing name
      const res1 = await callRoute(POST, {
        url: "/api/integrations/radarr",
        method: "POST",
        body: { url: "http://radarr:7878", apiKey: "key" },
      });
      expect(res1.status).toBe(400);

      // Missing url
      const res2 = await callRoute(POST, {
        url: "/api/integrations/radarr",
        method: "POST",
        body: { name: "Radarr", apiKey: "key" },
      });
      expect(res2.status).toBe(400);

      // Missing apiKey
      const res3 = await callRoute(POST, {
        url: "/api/integrations/radarr",
        method: "POST",
        body: { name: "Radarr", url: "http://radarr:7878" },
      });
      expect(res3.status).toBe(400);
    });

    it("returns 400 when connection test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/radarr",
        method: "POST",
        body: { name: "Bad Radarr", url: "http://bad:7878", apiKey: "key" },
      });
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body.error).toContain("Failed to connect to Radarr");
      expect(body.detail).toBe("Connection refused");
    });

    it("creates a new instance on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/radarr",
        method: "POST",
        body: { name: "My Radarr", url: "http://radarr:7878", apiKey: "test-key" },
      });
      const body = await expectJson<{ instance: { id: string; name: string; url: string } }>(
        response,
        201
      );
      expect(body.instance.name).toBe("My Radarr");
      expect(body.instance.url).toBe("http://radarr:7878");
      expect(body.instance.id).toBeDefined();
    });

    it("strips trailing slashes from url", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/radarr",
        method: "POST",
        body: { name: "Radarr", url: "http://radarr:7878///", apiKey: "test-key" },
      });
      const body = await expectJson<{ instance: { url: string } }>(response, 201);
      expect(body.instance.url).toBe("http://radarr:7878");
    });
  });

  // ----- PUT /api/integrations/radarr/[id] -----

  describe("PUT /api/integrations/radarr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        PUT,
        { id: "nonexistent" },
        { url: "/api/integrations/radarr/nonexistent", method: "PUT", body: { name: "New" } }
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
          url: "/api/integrations/radarr/00000000-0000-0000-0000-000000000000",
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
      const instance = await createTestRadarrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        { url: `/api/integrations/radarr/${instance.id}`, method: "PUT", body: { name: "Hacked" } }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns 400 when connection test fails on update", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });

      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/radarr/${instance.id}`,
          method: "PUT",
          body: { url: "http://bad:7878" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("Failed to connect to Radarr");
    });

    it("updates instance fields successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id, { name: "Old Name" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/radarr/${instance.id}`,
          method: "PUT",
          body: { name: "Updated Radarr", url: "http://new-radarr:7878" },
        }
      );
      const body = await expectJson<{ instance: { name: string; url: string } }>(response, 200);
      expect(body.instance.name).toBe("Updated Radarr");
      expect(body.instance.url).toBe("http://new-radarr:7878");
    });
  });

  // ----- DELETE /api/integrations/radarr/[id] -----

  describe("DELETE /api/integrations/radarr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        DELETE,
        { id: "nonexistent" },
        { url: "/api/integrations/radarr/nonexistent", method: "DELETE" }
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
          url: "/api/integrations/radarr/00000000-0000-0000-0000-000000000000",
          method: "DELETE",
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns 404 when deleting another user's instance", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestRadarrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/radarr/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("deletes instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/radarr/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      // Verify it's gone
      const listResponse = await callRoute(GET, { url: "/api/integrations/radarr" });
      const listBody = await expectJson<{ instances: unknown[] }>(listResponse, 200);
      expect(listBody.instances).toHaveLength(0);
    });
  });

  // ----- POST /api/integrations/radarr/test -----

  describe("POST /api/integrations/radarr/test", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/radarr/test",
        method: "POST",
        body: { url: "http://radarr:7878", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when required fields are missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const res1 = await callRoute(TEST_POST, {
        url: "/api/integrations/radarr/test",
        method: "POST",
        body: { apiKey: "key" },
      });
      expect(res1.status).toBe(400);

      const res2 = await callRoute(TEST_POST, {
        url: "/api/integrations/radarr/test",
        method: "POST",
        body: { url: "http://radarr:7878" },
      });
      expect(res2.status).toBe(400);
    });

    it("returns connection test result on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/radarr/test",
        method: "POST",
        body: { url: "http://radarr:7878", apiKey: "test-key" },
      });
      const body = await expectJson<{ ok: boolean; appName: string }>(response, 200);
      expect(body.ok).toBe(true);
      expect(body.appName).toBe("Radarr");
    });

    it("returns connection test failure result", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/radarr/test",
        method: "POST",
        body: { url: "http://bad:7878", apiKey: "key" },
      });
      const body = await expectJson<{ ok: boolean; error: string }>(response, 200);
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Connection refused");
    });

    it("does not save instance to database", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      await callRoute(TEST_POST, {
        url: "/api/integrations/radarr/test",
        method: "POST",
        body: { url: "http://radarr:7878", apiKey: "key" },
      });

      // Verify nothing was saved
      const listResponse = await callRoute(GET, { url: "/api/integrations/radarr" });
      const listBody = await expectJson<{ instances: unknown[] }>(listResponse, 200);
      expect(listBody.instances).toHaveLength(0);
    });
  });

  // ----- GET /api/integrations/radarr/[id]/metadata -----

  describe("GET /api/integrations/radarr/[id]/metadata", () => {
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

    it("returns movie lookup, tags, and quality profiles", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockGetMovies.mockResolvedValue([
        {
          tmdbId: 55555,
          tags: [1],
          qualityProfileId: 1,
          monitored: true,
          ratings: { imdb: { value: 7.2 } },
        },
      ]);

      const response = await callRouteWithParams(METADATA_GET, { id: instance.id });
      const body = await expectJson<{
        movies: Record<string, { tags: string[]; qualityProfile: string; monitored: boolean; rating: number | null }>;
        tags: { id: number; label: string }[];
        qualityProfiles: { id: number; name: string }[];
      }>(response, 200);

      expect(body.movies["55555"]).toBeDefined();
      expect(body.movies["55555"].tags).toEqual(["test-tag"]);
      expect(body.movies["55555"].qualityProfile).toBe("HD-1080p");
      expect(body.movies["55555"].monitored).toBe(true);
      expect(body.movies["55555"].rating).toBe(7.2);
      expect(body.tags).toHaveLength(1);
      expect(body.qualityProfiles).toHaveLength(1);
    });
  });
});
