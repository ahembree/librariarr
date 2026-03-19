import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestLidarrInstance,
  createTestRadarrInstance,
  createTestSonarrInstance,
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

// ---- Lidarr mocks ----
const mockLidarrGetArtists = vi.fn();
const mockLidarrGetQualityProfiles = vi.fn();
const mockLidarrGetTags = vi.fn();

vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function () {
    return {
      getArtists: mockLidarrGetArtists,
      getQualityProfiles: mockLidarrGetQualityProfiles,
      getTags: mockLidarrGetTags,
    };
  }),
}));

// ---- Radarr mocks ----
const mockRadarrGetMovies = vi.fn();
const mockRadarrGetQualityProfiles = vi.fn();
const mockRadarrGetTags = vi.fn();
const mockRadarrGetLanguages = vi.fn();

vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function () {
    return {
      getMovies: mockRadarrGetMovies,
      getQualityProfiles: mockRadarrGetQualityProfiles,
      getTags: mockRadarrGetTags,
      getLanguages: mockRadarrGetLanguages,
    };
  }),
}));

// ---- Sonarr mocks ----
const mockSonarrGetSeries = vi.fn();
const mockSonarrGetQualityProfiles = vi.fn();
const mockSonarrGetTags = vi.fn();
const mockSonarrGetLanguages = vi.fn();

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return {
      getSeries: mockSonarrGetSeries,
      getQualityProfiles: mockSonarrGetQualityProfiles,
      getTags: mockSonarrGetTags,
      getLanguages: mockSonarrGetLanguages,
    };
  }),
}));

// ---- Seerr mocks ----
const mockSeerrGetUsers = vi.fn();

vi.mock("@/lib/seerr/seerr-client", () => ({
  SeerrClient: vi.fn().mockImplementation(function () {
    return {
      getUsers: mockSeerrGetUsers,
    };
  }),
}));

// Import route handlers AFTER mocks
import { GET as LidarrMetadataGET } from "@/app/api/integrations/lidarr/[id]/metadata/route";
import { GET as RadarrMetadataGET } from "@/app/api/integrations/radarr/[id]/metadata/route";
import { GET as SonarrMetadataGET } from "@/app/api/integrations/sonarr/[id]/metadata/route";
import { GET as SeerrMetadataGET } from "@/app/api/integrations/seerr/[id]/metadata/route";

describe("Integration metadata endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();

    // Default mock return values
    mockLidarrGetArtists.mockResolvedValue([]);
    mockLidarrGetQualityProfiles.mockResolvedValue([]);
    mockLidarrGetTags.mockResolvedValue([]);

    mockRadarrGetMovies.mockResolvedValue([]);
    mockRadarrGetQualityProfiles.mockResolvedValue([]);
    mockRadarrGetTags.mockResolvedValue([]);
    mockRadarrGetLanguages.mockResolvedValue([]);

    mockSonarrGetSeries.mockResolvedValue([]);
    mockSonarrGetQualityProfiles.mockResolvedValue([]);
    mockSonarrGetTags.mockResolvedValue([]);
    mockSonarrGetLanguages.mockResolvedValue([]);

    mockSeerrGetUsers.mockResolvedValue({
      pageInfo: { pages: 1, page: 1, results: 0 },
      results: [],
    });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ===== Lidarr metadata =====

  describe("GET /api/integrations/lidarr/[id]/metadata", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(LidarrMetadataGET, { id: "any" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent instance", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(LidarrMetadataGET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns 404 when accessing another user's instance", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });
      const instance = await createTestLidarrInstance(owner.id);
      setMockSession({ userId: intruder.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(LidarrMetadataGET, { id: instance.id });
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns artists, tags, and quality profiles", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockLidarrGetArtists.mockResolvedValue([
        {
          foreignArtistId: "mb-123",
          tags: [1],
          qualityProfileId: 1,
          monitored: true,
          ratings: { value: 8.5 },
        },
      ]);
      mockLidarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "Lossless" }]);
      mockLidarrGetTags.mockResolvedValue([{ id: 1, label: "favorite" }]);

      const response = await callRouteWithParams(LidarrMetadataGET, { id: instance.id });
      const body = await expectJson<{
        artists: Record<string, { tags: string[]; qualityProfile: string; monitored: boolean; rating: number | null }>;
        tags: { id: number; label: string }[];
        qualityProfiles: { id: number; name: string }[];
      }>(response, 200);

      expect(body.artists["mb-123"]).toEqual({
        tags: ["favorite"],
        qualityProfile: "Lossless",
        monitored: true,
        rating: 8.5,
      });
      expect(body.tags).toEqual([{ id: 1, label: "favorite" }]);
      expect(body.qualityProfiles).toEqual([{ id: 1, name: "Lossless" }]);
    });

    it("falls back to tag id string when tag not found", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockLidarrGetArtists.mockResolvedValue([
        { foreignArtistId: "mb-1", tags: [99], qualityProfileId: 1, monitored: false, ratings: null },
      ]);
      mockLidarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "Any" }]);
      mockLidarrGetTags.mockResolvedValue([]);

      const response = await callRouteWithParams(LidarrMetadataGET, { id: instance.id });
      const body = await expectJson<{
        artists: Record<string, { tags: string[] }>;
      }>(response, 200);

      expect(body.artists["mb-1"].tags).toEqual(["99"]);
    });
  });

  // ===== Radarr metadata =====

  describe("GET /api/integrations/radarr/[id]/metadata", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(RadarrMetadataGET, { id: "any" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent instance", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(RadarrMetadataGET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns 404 when accessing another user's instance", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });
      const instance = await createTestRadarrInstance(owner.id);
      setMockSession({ userId: intruder.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(RadarrMetadataGET, { id: instance.id });
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns movies, tags, quality profiles, and languages", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockRadarrGetMovies.mockResolvedValue([
        {
          tmdbId: 550,
          tags: [2],
          qualityProfileId: 1,
          monitored: true,
          ratings: { imdb: { value: 8.8 } },
        },
      ]);
      mockRadarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "HD-1080p" }]);
      mockRadarrGetTags.mockResolvedValue([{ id: 2, label: "action" }]);
      mockRadarrGetLanguages.mockResolvedValue([
        { id: 1, name: "English" },
        { id: 2, name: "French" },
        { id: 3, name: "Unknown" },
      ]);

      const response = await callRouteWithParams(RadarrMetadataGET, { id: instance.id });
      const body = await expectJson<{
        movies: Record<string, { tags: string[]; qualityProfile: string; monitored: boolean; rating: number | null }>;
        tags: { id: number; label: string }[];
        qualityProfiles: { id: number; name: string }[];
        languages: string[];
      }>(response, 200);

      expect(body.movies["550"]).toEqual({
        tags: ["action"],
        qualityProfile: "HD-1080p",
        monitored: true,
        rating: 8.8,
      });
      expect(body.tags).toEqual([{ id: 2, label: "action" }]);
      expect(body.qualityProfiles).toEqual([{ id: 1, name: "HD-1080p" }]);
      // "Unknown" should be filtered out, remaining sorted alphabetically
      expect(body.languages).toEqual(["English", "French"]);
    });

    it("handles movie with no ratings", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockRadarrGetMovies.mockResolvedValue([
        { tmdbId: 100, tags: [], qualityProfileId: 99, monitored: false, ratings: {} },
      ]);
      mockRadarrGetQualityProfiles.mockResolvedValue([]);
      mockRadarrGetTags.mockResolvedValue([]);
      mockRadarrGetLanguages.mockResolvedValue([]);

      const response = await callRouteWithParams(RadarrMetadataGET, { id: instance.id });
      const body = await expectJson<{
        movies: Record<string, { rating: number | null; qualityProfile: string }>;
      }>(response, 200);

      expect(body.movies["100"].rating).toBeNull();
      expect(body.movies["100"].qualityProfile).toBe("Unknown");
    });
  });

  // ===== Sonarr metadata =====

  describe("GET /api/integrations/sonarr/[id]/metadata", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(SonarrMetadataGET, { id: "any" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent instance", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(SonarrMetadataGET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns 404 when accessing another user's instance", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });
      const instance = await createTestSonarrInstance(owner.id);
      setMockSession({ userId: intruder.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(SonarrMetadataGET, { id: instance.id });
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns series, tags, quality profiles, and languages", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockSonarrGetSeries.mockResolvedValue([
        {
          tvdbId: 81189,
          tags: [1, 3],
          qualityProfileId: 2,
          monitored: true,
          ratings: { imdb: { value: 9.3 } },
        },
      ]);
      mockSonarrGetQualityProfiles.mockResolvedValue([{ id: 2, name: "Ultra-HD" }]);
      mockSonarrGetTags.mockResolvedValue([
        { id: 1, label: "drama" },
        { id: 3, label: "hbo" },
      ]);
      mockSonarrGetLanguages.mockResolvedValue([
        { id: 1, name: "English" },
        { id: 2, name: "Unknown" },
        { id: 3, name: "Spanish" },
      ]);

      const response = await callRouteWithParams(SonarrMetadataGET, { id: instance.id });
      const body = await expectJson<{
        series: Record<string, { tags: string[]; qualityProfile: string; monitored: boolean; rating: number | null }>;
        tags: { id: number; label: string }[];
        qualityProfiles: { id: number; name: string }[];
        languages: string[];
      }>(response, 200);

      expect(body.series["81189"]).toEqual({
        tags: ["drama", "hbo"],
        qualityProfile: "Ultra-HD",
        monitored: true,
        rating: 9.3,
      });
      expect(body.tags).toHaveLength(2);
      expect(body.qualityProfiles).toEqual([{ id: 2, name: "Ultra-HD" }]);
      // "Unknown" filtered, rest sorted
      expect(body.languages).toEqual(["English", "Spanish"]);
    });

    it("handles series with no ratings", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockSonarrGetSeries.mockResolvedValue([
        { tvdbId: 999, tags: [], qualityProfileId: 1, monitored: false, ratings: {} },
      ]);
      mockSonarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "SD" }]);
      mockSonarrGetTags.mockResolvedValue([]);
      mockSonarrGetLanguages.mockResolvedValue([]);

      const response = await callRouteWithParams(SonarrMetadataGET, { id: instance.id });
      const body = await expectJson<{
        series: Record<string, { rating: number | null }>;
      }>(response, 200);

      expect(body.series["999"].rating).toBeNull();
    });
  });

  // ===== Seerr metadata =====

  describe("GET /api/integrations/seerr/[id]/metadata", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(SeerrMetadataGET, { id: "any" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent instance", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(SeerrMetadataGET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns 404 when accessing another user's instance", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });
      const instance = await createTestSeerrInstance(owner.id);
      setMockSession({ userId: intruder.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns sorted unique users", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockSeerrGetUsers.mockResolvedValue({
        pageInfo: { pages: 1, page: 1, results: 3 },
        results: [
          { id: 1, email: "z@test.com", username: "zuser", plexUsername: "PlexZed" },
          { id: 2, email: "a@test.com", username: "auser", plexUsername: "PlexAlpha" },
          { id: 3, email: "m@test.com", username: "muser" },
        ],
      });

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      const body = await expectJson<{ users: string[] }>(response, 200);

      // plexUsername takes priority, sorted alphabetically
      expect(body.users).toEqual(["muser", "PlexAlpha", "PlexZed"]);
    });

    it("deduplicates users across pages", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // First call returns full page (length === take), second returns partial
      mockSeerrGetUsers
        .mockResolvedValueOnce({
          pageInfo: { pages: 2, page: 1, results: 100 },
          results: Array.from({ length: 100 }, (_, i) => ({
            id: i,
            email: `u${i}@test.com`,
            username: `user${i}`,
          })),
        })
        .mockResolvedValueOnce({
          pageInfo: { pages: 2, page: 2, results: 1 },
          results: [
            // Duplicate of first page user
            { id: 0, email: "u0@test.com", username: "user0" },
          ],
        });

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      const body = await expectJson<{ users: string[] }>(response, 200);

      // 100 unique users (duplicate removed)
      expect(body.users).toHaveLength(100);
      // Sorted alphabetically
      expect(body.users[0]).toBe("user0");
    });

    it("returns empty users array when no users exist", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockSeerrGetUsers.mockResolvedValue({
        pageInfo: { pages: 1, page: 1, results: 0 },
        results: [],
      });

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      const body = await expectJson<{ users: string[] }>(response, 200);

      expect(body.users).toEqual([]);
    });

    it("uses email as fallback when username and plexUsername are missing", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockSeerrGetUsers.mockResolvedValue({
        pageInfo: { pages: 1, page: 1, results: 1 },
        results: [
          { id: 1, email: "fallback@test.com", username: "" },
        ],
      });

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      const body = await expectJson<{ users: string[] }>(response, 200);

      expect(body.users).toEqual(["fallback@test.com"]);
    });
  });
});
