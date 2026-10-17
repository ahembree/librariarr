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

vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(LidarrMetadataGET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      expect(await expectJson(response, 404)).toEqual({ error: "Instance not found" });
    });

    it("returns 404 when accessing another user's instance", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });
      const instance = await createTestLidarrInstance(owner.id);
      setMockSession({ userId: intruder.id, isLoggedIn: true });

      const response = await callRouteWithParams(LidarrMetadataGET, { id: instance.id });
      expect(await expectJson(response, 404)).toEqual({ error: "Instance not found" });
    });

    it("returns artists, tags, and quality profiles", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockLidarrGetArtists.mockResolvedValue([
        {
          id: 1,
          artistName: "Daft Punk",
          foreignArtistId: "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
          qualityProfileId: 1,
          metadataProfileId: 1,
          monitored: true,
          path: "/music/Daft Punk",
          tags: [1],
          ratings: { votes: 96, value: 8.5 },
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

      expect(body.artists["056e4f3e-d505-4dad-8ec1-d04f521cbb56"]).toEqual({
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockLidarrGetArtists.mockResolvedValue([
        { foreignArtistId: "cc197bad-dc9c-440d-a5b5-d52ba2e14234", tags: [99], qualityProfileId: 1, monitored: false },
      ]);
      mockLidarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "Any" }]);
      mockLidarrGetTags.mockResolvedValue([]);

      const response = await callRouteWithParams(LidarrMetadataGET, { id: instance.id });
      const body = await expectJson<{
        artists: Record<string, { tags: string[] }>;
      }>(response, 200);

      expect(body.artists["cc197bad-dc9c-440d-a5b5-d52ba2e14234"].tags).toEqual(["99"]);
    });

    it("derives distinct artist statuses for the enumerable arrStatus field", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockLidarrGetArtists.mockResolvedValue([
        { foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711", tags: [], qualityProfileId: 1, monitored: true, status: "continuing" },
        { foreignArtistId: "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d", tags: [], qualityProfileId: 1, monitored: true, status: "ended" },
        // Duplicate dedupes; the artist with no status is filtered out.
        { foreignArtistId: "056e4f3e-d505-4dad-8ec1-d04f521cbb56", tags: [], qualityProfileId: 1, monitored: true, status: "continuing" },
        { foreignArtistId: "cc197bad-dc9c-440d-a5b5-d52ba2e14234", tags: [], qualityProfileId: 1, monitored: false },
      ]);
      mockLidarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "Lossless" }]);

      const response = await callRouteWithParams(LidarrMetadataGET, { id: instance.id });
      const body = await expectJson<{ statuses: string[] }>(response, 200);

      expect(body.statuses).toEqual(["continuing", "ended"]);
    });

    it("returns 502 with the address scrubbed when Lidarr cannot be reached", async () => {
      const user = await createTestUser();
      const instance = await createTestLidarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockLidarrGetArtists.mockRejectedValue(new Error("connect ECONNREFUSED 192.168.1.20:8686"));

      const response = await callRouteWithParams(LidarrMetadataGET, { id: instance.id });
      expect(await expectJson(response, 502)).toEqual({
        error: "connect ECONNREFUSED [internal]:8686",
      });
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(RadarrMetadataGET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      expect(await expectJson(response, 404)).toEqual({ error: "Instance not found" });
    });

    it("returns 404 when accessing another user's instance", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });
      const instance = await createTestRadarrInstance(owner.id);
      setMockSession({ userId: intruder.id, isLoggedIn: true });

      const response = await callRouteWithParams(RadarrMetadataGET, { id: instance.id });
      expect(await expectJson(response, 404)).toEqual({ error: "Instance not found" });
    });

    it("returns movies, tags, quality profiles, and languages", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockRadarrGetMovies.mockResolvedValue([
        {
          tmdbId: 550,
          tags: [2],
          qualityProfileId: 1,
          monitored: true,
          ratings: { imdb: { votes: 2_400_000, value: 8.8, type: "user" } },
          status: "released",
        },
      ]);
      mockRadarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "HD-1080p" }]);
      mockRadarrGetTags.mockResolvedValue([{ id: 2, label: "action" }]);
      // Radarr's /language list as served: Unknown plus the quality-profile
      // pseudo-languages Any (-1) and Original (-2).
      mockRadarrGetLanguages.mockResolvedValue([
        { id: 0, name: "Unknown" },
        { id: 2, name: "French" },
        { id: 1, name: "English" },
        { id: -1, name: "Any" },
        { id: -2, name: "Original" },
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
      // Only real languages — no title's original language is Unknown, Any or
      // Original — sorted alphabetically.
      expect(body.languages).toEqual(["English", "French"]);
    });

    it("derives distinct movie statuses for the enumerable arrStatus field", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockRadarrGetMovies.mockResolvedValue([
        { tmdbId: 1, tags: [], qualityProfileId: 1, monitored: true, status: "released" },
        { tmdbId: 2, tags: [], qualityProfileId: 1, monitored: true, status: "announced" },
        // Duplicate dedupes; the movie with no status is filtered out.
        { tmdbId: 3, tags: [], qualityProfileId: 1, monitored: true, status: "released" },
        { tmdbId: 4, tags: [], qualityProfileId: 1, monitored: false },
      ]);
      mockRadarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "HD" }]);

      const response = await callRouteWithParams(RadarrMetadataGET, { id: instance.id });
      const body = await expectJson<{ statuses: string[] }>(response, 200);

      expect(body.statuses).toEqual(["announced", "released"]);
    });

    it("handles movie with no ratings", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

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

    it("derives distinct downloaded-file quality names for the enumerable arrQualityName field", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockRadarrGetMovies.mockResolvedValue([
        { tmdbId: 1, tags: [], qualityProfileId: 1, monitored: true, movieFile: { quality: { quality: { name: "Bluray-1080p" } } } },
        { tmdbId: 2, tags: [], qualityProfileId: 1, monitored: true, movieFile: { quality: { quality: { name: "WEBDL-2160p" } } } },
        // Duplicate name dedupes; the movie with no file is filtered out.
        { tmdbId: 3, tags: [], qualityProfileId: 1, monitored: true, movieFile: { quality: { quality: { name: "Bluray-1080p" } } } },
        { tmdbId: 4, tags: [], qualityProfileId: 1, monitored: false },
      ]);
      mockRadarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "HD" }]);

      const response = await callRouteWithParams(RadarrMetadataGET, { id: instance.id });
      const body = await expectJson<{ qualityNames: string[] }>(response, 200);

      expect(body.qualityNames).toEqual(["Bluray-1080p", "WEBDL-2160p"]);
    });

    it("returns 502 with the address scrubbed when Radarr cannot be reached", async () => {
      const user = await createTestUser();
      const instance = await createTestRadarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockRadarrGetTags.mockRejectedValue(new Error("connect ECONNREFUSED 192.168.1.20:7878"));

      const response = await callRouteWithParams(RadarrMetadataGET, { id: instance.id });
      expect(await expectJson(response, 502)).toEqual({
        error: "connect ECONNREFUSED [internal]:7878",
      });
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(SonarrMetadataGET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      expect(await expectJson(response, 404)).toEqual({ error: "Instance not found" });
    });

    it("returns 404 when accessing another user's instance", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });
      const instance = await createTestSonarrInstance(owner.id);
      setMockSession({ userId: intruder.id, isLoggedIn: true });

      const response = await callRouteWithParams(SonarrMetadataGET, { id: instance.id });
      expect(await expectJson(response, 404)).toEqual({ error: "Instance not found" });
    });

    it("returns series, tags, quality profiles, and languages", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockSonarrGetSeries.mockResolvedValue([
        {
          tvdbId: 81189,
          tags: [1, 3],
          qualityProfileId: 2,
          monitored: true,
          ratings: { votes: 300, value: 9.3 },
        },
      ]);
      mockSonarrGetQualityProfiles.mockResolvedValue([{ id: 2, name: "Ultra-HD" }]);
      mockSonarrGetTags.mockResolvedValue([
        { id: 1, label: "drama" },
        { id: 3, label: "hbo" },
      ]);
      // Sonarr's /language list as served: Unknown plus the quality-profile
      // pseudo-language Original (-2).
      mockSonarrGetLanguages.mockResolvedValue([
        { id: 0, name: "Unknown" },
        { id: 3, name: "Spanish" },
        { id: 1, name: "English" },
        { id: -2, name: "Original" },
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
      expect(body.tags).toEqual([
        { id: 1, label: "drama" },
        { id: 3, label: "hbo" },
      ]);
      expect(body.qualityProfiles).toEqual([{ id: 2, name: "Ultra-HD" }]);
      // Only real languages (no Unknown or Original), sorted
      expect(body.languages).toEqual(["English", "Spanish"]);
    });

    it("derives distinct statuses and seriesTypes for the enumerable fields", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockSonarrGetSeries.mockResolvedValue([
        { tvdbId: 1, tags: [], qualityProfileId: 1, monitored: true, status: "continuing", seriesType: "standard" },
        { tvdbId: 2, tags: [], qualityProfileId: 1, monitored: true, status: "ended", seriesType: "anime" },
        // Duplicate values dedupe; the series with no status/seriesType is filtered out.
        { tvdbId: 3, tags: [], qualityProfileId: 1, monitored: true, status: "continuing", seriesType: "anime" },
        { tvdbId: 4, tags: [], qualityProfileId: 1, monitored: true },
      ]);
      mockSonarrGetQualityProfiles.mockResolvedValue([{ id: 1, name: "HD" }]);

      const response = await callRouteWithParams(SonarrMetadataGET, { id: instance.id });
      const body = await expectJson<{ statuses: string[]; seriesTypes: string[] }>(response, 200);

      expect(body.statuses).toEqual(["continuing", "ended"]);
      expect(body.seriesTypes).toEqual(["anime", "standard"]);
    });

    it("returns empty statuses/seriesTypes when there are no series", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(SonarrMetadataGET, { id: instance.id });
      const body = await expectJson<{ statuses: string[]; seriesTypes: string[] }>(response, 200);

      expect(body.statuses).toEqual([]);
      expect(body.seriesTypes).toEqual([]);
    });

    it("handles series with no ratings", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

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

    it("returns 502 with the address scrubbed when Sonarr cannot be reached", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockSonarrGetQualityProfiles.mockRejectedValue(new Error("connect ECONNREFUSED 192.168.1.20:8989"));

      const response = await callRouteWithParams(SonarrMetadataGET, { id: instance.id });
      expect(await expectJson(response, 502)).toEqual({
        error: "connect ECONNREFUSED [internal]:8989",
      });
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(SeerrMetadataGET, {
        id: "00000000-0000-0000-0000-000000000000",
      });
      expect(await expectJson(response, 404)).toEqual({ error: "Instance not found" });
    });

    it("returns 404 when accessing another user's instance", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });
      const instance = await createTestSeerrInstance(owner.id);
      setMockSession({ userId: intruder.id, isLoggedIn: true });

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      expect(await expectJson(response, 404)).toEqual({ error: "Instance not found" });
    });

    it("returns sorted unique users", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockSeerrGetUsers.mockResolvedValue({
        pageInfo: { pages: 1, page: 1, results: 4 },
        results: [
          { id: 1, email: "z@test.com", username: "zuser", plexUsername: "PlexZed" },
          { id: 2, email: "a@test.com", username: "auser", plexUsername: "PlexAlpha" },
          { id: 3, email: "m@test.com", username: "muser" },
          // A local user named like a Plex user resolves to the same name once.
          { id: 4, email: "zed@test.com", username: "PlexZed" },
        ],
      });

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      const body = await expectJson<{ users: string[] }>(response, 200);

      // plexUsername takes priority, sorted alphabetically, each name once
      expect(body.users).toEqual(["muser", "PlexAlpha", "PlexZed"]);
      expect(mockSeerrGetUsers).toHaveBeenCalledTimes(1);
    });

    it("deduplicates users across pages", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      // A full first page (length === take) asks for the next one. A user added
      // between the two requests shifts the offset list, so the second page
      // repeats a user the first already returned. pageInfo.results is Seerr's
      // total user count, not the page's.
      mockSeerrGetUsers
        .mockResolvedValueOnce({
          pageInfo: { pages: 1, page: 1, results: 100 },
          results: Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            email: `u${i}@test.com`,
            username: `user${i}`,
          })),
        })
        .mockResolvedValueOnce({
          pageInfo: { pages: 2, page: 2, results: 101 },
          results: [{ id: 100, email: "u99@test.com", username: "user99" }],
        });

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      const body = await expectJson<{ users: string[] }>(response, 200);

      expect(mockSeerrGetUsers).toHaveBeenNthCalledWith(1, { take: 100, skip: 0 });
      expect(mockSeerrGetUsers).toHaveBeenNthCalledWith(2, { take: 100, skip: 100 });
      // 100 unique users (duplicate removed), sorted
      expect(body.users).toEqual(
        Array.from({ length: 100 }, (_, i) => `user${i}`).sort((a, b) => a.localeCompare(b)),
      );
    });

    it("returns empty users array when no users exist", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockSeerrGetUsers.mockResolvedValue({
        pageInfo: { pages: 1, page: 1, results: 1 },
        results: [
          { id: 1, email: "fallback@test.com", username: null, plexUsername: null },
        ],
      });

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      const body = await expectJson<{ users: string[] }>(response, 200);

      expect(body.users).toEqual(["fallback@test.com"]);
    });

    it("returns 502 with the address scrubbed when Seerr cannot be reached", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockSeerrGetUsers.mockRejectedValue(new Error("connect ECONNREFUSED 192.168.1.20:5055"));

      const response = await callRouteWithParams(SeerrMetadataGET, { id: instance.id });
      expect(await expectJson(response, 502)).toEqual({
        error: "connect ECONNREFUSED [internal]:5055",
      });
    });
  });
});
