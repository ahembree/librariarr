import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestSonarrInstance,
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
const mockGetSeries = vi.fn();
const mockGetQualityProfiles = vi.fn();
const mockGetTags = vi.fn();
const mockGetLanguages = vi.fn();

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return {
      testConnection: mockTestConnection,
      getSeries: mockGetSeries,
      getQualityProfiles: mockGetQualityProfiles,
      getTags: mockGetTags,
      getLanguages: mockGetLanguages,
    };
  }),
}));

// Import route handlers AFTER mocks
import { GET, POST } from "@/app/api/integrations/sonarr/route";
import { PUT, DELETE } from "@/app/api/integrations/sonarr/[id]/route";
import { POST as TEST_POST } from "@/app/api/integrations/sonarr/test/route";
import { GET as METADATA_GET } from "@/app/api/integrations/sonarr/[id]/metadata/route";

describe("Sonarr integration endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, appName: "Sonarr", version: "4.0" });
    mockGetSeries.mockResolvedValue([]);
    mockGetQualityProfiles.mockResolvedValue([{ id: 1, name: "HD-1080p" }]);
    mockGetTags.mockResolvedValue([{ id: 1, label: "test-tag" }]);
    mockGetLanguages.mockResolvedValue([{ id: 1, name: "English" }]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/integrations/sonarr -----

  describe("GET /api/integrations/sonarr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/integrations/sonarr" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty instances when user has none", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/sonarr" });
      const body = await expectJson<{ instances: unknown[] }>(response, 200);
      expect(body.instances).toEqual([]);
    });

    it("returns instances belonging to the authenticated user", async () => {
      const user = await createTestUser();
      await createTestSonarrInstance(user.id, { name: "My Sonarr" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/sonarr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("My Sonarr");
    });

    it("does not return instances belonging to another user", async () => {
      const user1 = await createTestUser({ plexId: "user1" });
      const user2 = await createTestUser({ plexId: "user2" });
      await createTestSonarrInstance(user1.id, { name: "User1 Sonarr" });
      await createTestSonarrInstance(user2.id, { name: "User2 Sonarr" });
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/sonarr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("User2 Sonarr");
    });
  });

  // ----- POST /api/integrations/sonarr -----

  describe("POST /api/integrations/sonarr", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { name: "Sonarr", url: "http://sonarr:8989", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when required fields are missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Missing name
      const res1 = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { url: "http://sonarr:8989", apiKey: "key" },
      });
      expect(res1.status).toBe(400);

      // Missing url
      const res2 = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { name: "Sonarr", apiKey: "key" },
      });
      expect(res2.status).toBe(400);

      // Missing apiKey
      const res3 = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { name: "Sonarr", url: "http://sonarr:8989" },
      });
      expect(res3.status).toBe(400);
    });

    it("returns 400 when connection test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { name: "Bad Sonarr", url: "http://bad:8989", apiKey: "key" },
      });
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body.error).toContain("Failed to connect to Sonarr");
      expect(body.detail).toBe("Connection refused");
    });

    it("creates a new instance on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        // file deepcode ignore HardcodedNonCryptoSecret/test: test file
        body: { name: "My Sonarr", url: "http://sonarr:8989", apiKey: "test-key" },
      });
      const body = await expectJson<{ instance: { id: string; name: string; url: string } }>(
        response,
        201
      );
      expect(body.instance.name).toBe("My Sonarr");
      expect(body.instance.url).toBe("http://sonarr:8989");
      expect(body.instance.id).toBeDefined();
    });

    it("strips trailing slashes from url", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { name: "Sonarr", url: "http://sonarr:8989///", apiKey: "test-key" },
      });
      const body = await expectJson<{ instance: { url: string } }>(response, 201);
      expect(body.instance.url).toBe("http://sonarr:8989");
    });
  });

  // ----- PUT /api/integrations/sonarr/[id] -----

  describe("PUT /api/integrations/sonarr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        PUT,
        { id: "nonexistent" },
        { url: "/api/integrations/sonarr/nonexistent", method: "PUT", body: { name: "New" } }
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
          url: "/api/integrations/sonarr/00000000-0000-0000-0000-000000000000",
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
      const instance = await createTestSonarrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        { url: `/api/integrations/sonarr/${instance.id}`, method: "PUT", body: { name: "Hacked" } }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns 400 when connection test fails on update", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });

      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/sonarr/${instance.id}`,
          method: "PUT",
          body: { url: "http://bad:8989" },
        }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("Failed to connect to Sonarr");
    });

    it("updates instance fields successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id, { name: "Old Name" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/sonarr/${instance.id}`,
          method: "PUT",
          body: { name: "Updated Sonarr", url: "http://new-sonarr:8989" },
        }
      );
      const body = await expectJson<{ instance: { name: string; url: string } }>(response, 200);
      expect(body.instance.name).toBe("Updated Sonarr");
      expect(body.instance.url).toBe("http://new-sonarr:8989");
    });
  });

  // ----- DELETE /api/integrations/sonarr/[id] -----

  describe("DELETE /api/integrations/sonarr/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        DELETE,
        { id: "nonexistent" },
        { url: "/api/integrations/sonarr/nonexistent", method: "DELETE" }
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
          url: "/api/integrations/sonarr/00000000-0000-0000-0000-000000000000",
          method: "DELETE",
        }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns 404 when deleting another user's instance", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const instance = await createTestSonarrInstance(user1.id);
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/sonarr/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("deletes instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: instance.id },
        { url: `/api/integrations/sonarr/${instance.id}`, method: "DELETE" }
      );
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      // Verify it's gone
      const listResponse = await callRoute(GET, { url: "/api/integrations/sonarr" });
      const listBody = await expectJson<{ instances: unknown[] }>(listResponse, 200);
      expect(listBody.instances).toHaveLength(0);
    });
  });

  // ----- POST /api/integrations/sonarr/test -----

  describe("POST /api/integrations/sonarr/test", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/sonarr/test",
        method: "POST",
        body: { url: "http://sonarr:8989", apiKey: "key" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when required fields are missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const res1 = await callRoute(TEST_POST, {
        url: "/api/integrations/sonarr/test",
        method: "POST",
        body: { apiKey: "key" },
      });
      expect(res1.status).toBe(400);

      const res2 = await callRoute(TEST_POST, {
        url: "/api/integrations/sonarr/test",
        method: "POST",
        body: { url: "http://sonarr:8989" },
      });
      expect(res2.status).toBe(400);
    });

    it("returns connection test result on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/sonarr/test",
        method: "POST",
        body: { url: "http://sonarr:8989", apiKey: "test-key" },
      });
      const body = await expectJson<{ ok: boolean; appName: string }>(response, 200);
      expect(body.ok).toBe(true);
      expect(body.appName).toBe("Sonarr");
    });

    it("returns connection test failure result", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(TEST_POST, {
        url: "/api/integrations/sonarr/test",
        method: "POST",
        body: { url: "http://bad:8989", apiKey: "key" },
      });
      const body = await expectJson<{ ok: boolean; error: string }>(response, 200);
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Connection refused");
    });

    it("does not save instance to database", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      await callRoute(TEST_POST, {
        url: "/api/integrations/sonarr/test",
        method: "POST",
        body: { url: "http://sonarr:8989", apiKey: "key" },
      });

      // Verify nothing was saved
      const listResponse = await callRoute(GET, { url: "/api/integrations/sonarr" });
      const listBody = await expectJson<{ instances: unknown[] }>(listResponse, 200);
      expect(listBody.instances).toHaveLength(0);
    });
  });

  // ----- GET /api/integrations/sonarr/[id]/metadata -----

  describe("GET /api/integrations/sonarr/[id]/metadata", () => {
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

    it("returns series lookup, tags, and quality profiles", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockGetSeries.mockResolvedValue([
        {
          tvdbId: 12345,
          tags: [1],
          qualityProfileId: 1,
          monitored: true,
          ratings: { imdb: { value: 8.5 } },
        },
      ]);

      const response = await callRouteWithParams(METADATA_GET, { id: instance.id });
      const body = await expectJson<{
        series: Record<string, { tags: string[]; qualityProfile: string; monitored: boolean; rating: number | null }>;
        tags: { id: number; label: string }[];
        qualityProfiles: { id: number; name: string }[];
      }>(response, 200);

      expect(body.series["12345"]).toBeDefined();
      expect(body.series["12345"].tags).toEqual(["test-tag"]);
      expect(body.series["12345"].qualityProfile).toBe("HD-1080p");
      expect(body.series["12345"].monitored).toBe(true);
      expect(body.series["12345"].rating).toBe(8.5);
      expect(body.tags).toHaveLength(1);
      expect(body.qualityProfiles).toHaveLength(1);
    });
  });
});
