import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { MASKED_VALUE } from "@/lib/api/sanitize";
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
    mockTestConnection.mockResolvedValue({ ok: true, appName: "Sonarr", version: "4.0.11.2680" });
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/sonarr" });
      const body = await expectJson<{ instances: unknown[] }>(response, 200);
      expect(body.instances).toEqual([]);
    });

    it("returns instances belonging to the authenticated user", async () => {
      const user = await createTestUser();
      await createTestSonarrInstance(user.id, { name: "My Sonarr" });
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/integrations/sonarr" });
      const body = await expectJson<{ instances: { name: string }[] }>(response, 200);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].name).toBe("My Sonarr");
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      // Missing name
      const res1 = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { url: "http://sonarr:8989", apiKey: "key" },
      });
      expect(await expectJson(res1, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^name: /)],
      });

      // Missing url
      const res2 = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { name: "Sonarr", apiKey: "key" },
      });
      expect(await expectJson(res2, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^url: /)],
      });

      // Missing apiKey
      const res3 = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { name: "Sonarr", url: "http://sonarr:8989" },
      });
      expect(await expectJson(res3, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^apiKey: /)],
      });

      expect(mockTestConnection).not.toHaveBeenCalled();
      expect(await getTestPrisma().sonarrInstance.count()).toBe(0);
    });

    it("returns 400 when connection test fails", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/integrations/sonarr",
        method: "POST",
        body: { name: "Bad Sonarr", url: "http://bad:8989", apiKey: "key" },
      });
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body).toEqual({ error: "Failed to connect to Sonarr", detail: "Connection refused" });
      expect(await getTestPrisma().sonarrInstance.count()).toBe(0);
    });

    it("creates a new instance on success", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      // The stored key never goes back to the browser.
      expect(body.instance).toMatchObject({ apiKey: MASKED_VALUE });
      expect(mockTestConnection).toHaveBeenCalledTimes(1);

      const stored = await getTestPrisma().sonarrInstance.findUnique({ where: { id: body.instance.id } });
      expect(stored).toMatchObject({
        userId: user.id,
        name: "My Sonarr",
        url: "http://sonarr:8989",
        apiKey: "test-key",
        externalUrl: null,
        enabled: true,
      });
    });

    it("strips trailing slashes from url", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

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

    it("saves a rename while the instance is unreachable when the URL is unchanged", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/sonarr/${instance.id}`,
          method: "PUT",
          body: { name: "Renamed", url: instance.url },
        }
      );
      const body = await expectJson<{ instance: { name: string } }>(response, 200);
      expect(body.instance.name).toBe("Renamed");
      expect(mockTestConnection).not.toHaveBeenCalled();

      const stored = await getTestPrisma().sonarrInstance.findUnique({ where: { id: instance.id } });
      expect(stored).toMatchObject({ name: "Renamed", url: instance.url });
    });

    it("returns 400 when connection test fails on update", async () => {
      mockTestConnection.mockResolvedValue({ ok: false, error: "Timeout" });

      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRouteWithParams(
        PUT,
        { id: instance.id },
        {
          url: `/api/integrations/sonarr/${instance.id}`,
          method: "PUT",
          body: { url: "http://bad:8989" },
        }
      );
      const body = await expectJson<{ error: string; detail: string }>(response, 400);
      expect(body).toEqual({ error: "Failed to connect to Sonarr", detail: "Timeout" });

      const stored = await getTestPrisma().sonarrInstance.findUnique({ where: { id: instance.id } });
      expect(stored!.url).toBe(instance.url);
    });

    it("updates instance fields successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id, { name: "Old Name" });
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

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
      // A new URL is tested before it is saved.
      expect(mockTestConnection).toHaveBeenCalledTimes(1);

      const stored = await getTestPrisma().sonarrInstance.findUnique({ where: { id: instance.id } });
      expect(stored).toMatchObject({ name: "Updated Sonarr", url: "http://new-sonarr:8989" });
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
      setMockSession({ userId: user.id, isLoggedIn: true });

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

    it("deletes instance successfully", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const res1 = await callRoute(TEST_POST, {
        url: "/api/integrations/sonarr/test",
        method: "POST",
        body: { apiKey: "key" },
      });
      expect(await expectJson(res1, 400)).toEqual({
        error: "Validation failed",
        details: [expect.stringMatching(/^url: /)],
      });

      const res2 = await callRoute(TEST_POST, {
        url: "/api/integrations/sonarr/test",
        method: "POST",
        body: { url: "http://sonarr:8989" },
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
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(METADATA_GET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Instance not found");
    });

    it("returns tags, quality profiles, statuses and series types, without a per-series map", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockGetSeries.mockResolvedValue([
        {
          id: 3,
          title: "Severance",
          year: 2022,
          tvdbId: 371980,
          imdbId: "tt11280740",
          qualityProfileId: 1,
          monitored: true,
          path: "/tv/Severance",
          tags: [1],
          ratings: { votes: 2_150, value: 8.5 },
          status: "continuing",
          seriesType: "standard",
        },
      ]);

      const response = await callRouteWithParams(METADATA_GET, { id: instance.id });
      const body = await expectJson(response, 200);

      expect(body).toEqual({
        tags: [{ id: 1, label: "test-tag" }],
        qualityProfiles: [{ id: 1, name: "HD-1080p" }],
        languages: ["English"],
        statuses: ["continuing"],
        seriesTypes: ["standard"],
      });
      // No caller read the per-series map, so it is no longer sent.
      expect(body).not.toHaveProperty("series");
    });
  });
});
