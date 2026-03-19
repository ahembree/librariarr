import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  radarrInstance: { findMany: vi.fn() },
  sonarrInstance: { findMany: vi.fn() },
  lidarrInstance: { findMany: vi.fn() },
}));

const mockRadarrClient = vi.hoisted(() => ({
  getMovies: vi.fn(),
  getQualityProfiles: vi.fn(),
  getTags: vi.fn(),
}));

const mockSonarrClient = vi.hoisted(() => ({
  getSeries: vi.fn(),
  getQualityProfiles: vi.fn(),
  getTags: vi.fn(),
}));

const mockLidarrClient = vi.hoisted(() => ({
  getArtists: vi.fn(),
  getQualityProfiles: vi.fn(),
  getTags: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: function () { return mockRadarrClient; },
}));
vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: function () { return mockSonarrClient; },
}));
vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: function () { return mockLidarrClient; },
}));

import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";

describe("fetchArrMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("MOVIE type", () => {
    it("returns empty map when no Radarr instances exist", async () => {
      mockPrisma.radarrInstance.findMany.mockResolvedValue([]);
      const result = await fetchArrMetadata("u1", "MOVIE");
      expect(result).toEqual({});
    });

    it("fetches and maps Radarr movie metadata", async () => {
      mockPrisma.radarrInstance.findMany.mockResolvedValue([
        { id: "r1", url: "http://radarr", apiKey: "key" },
      ]);
      mockRadarrClient.getMovies.mockResolvedValue([
        {
          id: 1,
          tmdbId: 550,
          tags: [1, 2],
          qualityProfileId: 10,
          monitored: true,
          ratings: { imdb: { value: 8.8 }, tmdb: { value: 8.5 }, rottenTomatoes: { value: 90 } },
          added: "2024-01-01",
          path: "/movies/fight-club",
          sizeOnDisk: 5000000000,
          originalLanguage: { name: "English" },
          digitalRelease: "2024-06-01",
          physicalRelease: null,
          inCinemas: "2024-03-01",
          runtime: 139,
          movieFile: { quality: { quality: { name: "Bluray-1080p" } }, dateAdded: "2024-02-01" },
          qualityCutoffNotMet: false,
          hasFile: true,
          movieFileId: 99,
        },
      ]);
      mockRadarrClient.getQualityProfiles.mockResolvedValue([
        { id: 10, name: "HD - 1080p" },
      ]);
      mockRadarrClient.getTags.mockResolvedValue([
        { id: 1, label: "lifecycle" },
        { id: 2, label: "watched" },
      ]);

      const result = await fetchArrMetadata("u1", "MOVIE");

      expect(result["550"]).toBeDefined();
      expect(result["550"].arrId).toBe(1);
      expect(result["550"].tags).toEqual(["lifecycle", "watched"]);
      expect(result["550"].qualityProfile).toBe("HD - 1080p");
      expect(result["550"].monitored).toBe(true);
      expect(result["550"].rating).toBe(8.8);
      expect(result["550"].tmdbRating).toBe(8.5);
      expect(result["550"].rtCriticRating).toBe(9); // 90/10
      expect(result["550"].dateAdded).toBe("2024-01-01");
      expect(result["550"].path).toBe("/movies/fight-club");
      expect(result["550"].originalLanguage).toBe("English");
      expect(result["550"].releaseDate).toBe("2024-06-01");
      expect(result["550"].inCinemasDate).toBe("2024-03-01");
      expect(result["550"].runtime).toBe(139);
      expect(result["550"].qualityName).toBe("Bluray-1080p");
      expect(result["550"].qualityCutoffMet).toBe(true); // !false
      expect(result["550"].downloadDate).toBe("2024-02-01");
    });

    it("handles unknown tag IDs gracefully", async () => {
      mockPrisma.radarrInstance.findMany.mockResolvedValue([
        { id: "r1", url: "http://radarr", apiKey: "key" },
      ]);
      mockRadarrClient.getMovies.mockResolvedValue([
        {
          id: 1, tmdbId: 100, tags: [999], qualityProfileId: 1,
          monitored: false, ratings: {}, added: null, path: null, sizeOnDisk: null,
          originalLanguage: null, digitalRelease: null, physicalRelease: null,
          inCinemas: null, runtime: null, movieFile: null, qualityCutoffNotMet: null,
        },
      ]);
      mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
      mockRadarrClient.getTags.mockResolvedValue([]);

      const result = await fetchArrMetadata("u1", "MOVIE");

      expect(result["100"].tags).toEqual(["999"]);
      expect(result["100"].qualityProfile).toBe("Unknown");
    });

    it("prefers digitalRelease over physicalRelease for releaseDate", async () => {
      mockPrisma.radarrInstance.findMany.mockResolvedValue([
        { id: "r1", url: "http://radarr", apiKey: "key" },
      ]);
      mockRadarrClient.getMovies.mockResolvedValue([
        {
          id: 1, tmdbId: 200, tags: [], qualityProfileId: 1,
          monitored: true, ratings: {}, added: null, path: null, sizeOnDisk: null,
          originalLanguage: null, digitalRelease: null, physicalRelease: "2024-09-01",
          inCinemas: null, runtime: null, movieFile: null, qualityCutoffNotMet: null,
        },
      ]);
      mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
      mockRadarrClient.getTags.mockResolvedValue([]);

      const result = await fetchArrMetadata("u1", "MOVIE");

      expect(result["200"].releaseDate).toBe("2024-09-01");
    });

    it("aggregates metadata from multiple Radarr instances", async () => {
      mockPrisma.radarrInstance.findMany.mockResolvedValue([
        { id: "r1", url: "http://radarr1", apiKey: "key1" },
        { id: "r2", url: "http://radarr2", apiKey: "key2" },
      ]);
      mockRadarrClient.getMovies
        .mockResolvedValueOnce([
          { id: 1, tmdbId: 100, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, added: null, path: null, sizeOnDisk: null, originalLanguage: null, digitalRelease: null, physicalRelease: null, inCinemas: null, runtime: null, movieFile: null, qualityCutoffNotMet: null },
        ])
        .mockResolvedValueOnce([
          { id: 2, tmdbId: 200, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, added: null, path: null, sizeOnDisk: null, originalLanguage: null, digitalRelease: null, physicalRelease: null, inCinemas: null, runtime: null, movieFile: null, qualityCutoffNotMet: null },
        ]);
      mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
      mockRadarrClient.getTags.mockResolvedValue([]);

      const result = await fetchArrMetadata("u1", "MOVIE");

      expect(Object.keys(result)).toHaveLength(2);
      expect(result["100"]).toBeDefined();
      expect(result["200"]).toBeDefined();
    });
  });

  describe("SERIES type", () => {
    it("returns empty map when no Sonarr instances exist", async () => {
      mockPrisma.sonarrInstance.findMany.mockResolvedValue([]);
      const result = await fetchArrMetadata("u1", "SERIES");
      expect(result).toEqual({});
    });

    it("fetches and maps Sonarr series metadata", async () => {
      mockPrisma.sonarrInstance.findMany.mockResolvedValue([
        { id: "s1", url: "http://sonarr", apiKey: "key" },
      ]);
      mockSonarrClient.getSeries.mockResolvedValue([
        {
          id: 1,
          tvdbId: 12345,
          tags: [1],
          qualityProfileId: 5,
          monitored: true,
          ratings: { imdb: { value: 9.0 }, tmdb: { value: 8.7 }, rottenTomatoes: { value: 95 } },
          added: "2023-01-01",
          path: "/tv/breaking-bad",
          statistics: { sizeOnDisk: 80000000000, seasonCount: 5, episodeCount: 62 },
          originalLanguage: { name: "English" },
          firstAired: "2008-01-20",
          status: "ended",
          ended: true,
          seriesType: "standard",
          nextAiring: null,
          seasons: [
            { monitored: true, statistics: { episodeCount: 10 } },
            { monitored: false, statistics: { episodeCount: 13 } },
          ],
        },
      ]);
      mockSonarrClient.getQualityProfiles.mockResolvedValue([
        { id: 5, name: "HD-1080p" },
      ]);
      mockSonarrClient.getTags.mockResolvedValue([{ id: 1, label: "auto" }]);

      const result = await fetchArrMetadata("u1", "SERIES");

      expect(result["12345"]).toBeDefined();
      expect(result["12345"].arrId).toBe(1);
      expect(result["12345"].qualityProfile).toBe("HD-1080p");
      expect(result["12345"].rating).toBe(9.0);
      expect(result["12345"].tmdbRating).toBe(8.7);
      expect(result["12345"].rtCriticRating).toBe(9.5); // 95/10
      expect(result["12345"].firstAired).toBe("2008-01-20");
      expect(result["12345"].seasonCount).toBe(5);
      expect(result["12345"].episodeCount).toBe(62);
      expect(result["12345"].status).toBe("ended");
      expect(result["12345"].ended).toBe(true);
      expect(result["12345"].hasUnaired).toBe(false);
      expect(result["12345"].monitoredSeasonCount).toBe(1);
      expect(result["12345"].monitoredEpisodeCount).toBe(10);
    });

    it("sets hasUnaired to true when nextAiring exists", async () => {
      mockPrisma.sonarrInstance.findMany.mockResolvedValue([
        { id: "s1", url: "http://sonarr", apiKey: "key" },
      ]);
      mockSonarrClient.getSeries.mockResolvedValue([
        {
          id: 1, tvdbId: 555, tags: [], qualityProfileId: 1,
          monitored: true, ratings: {}, added: null, path: null,
          statistics: {}, originalLanguage: null, firstAired: null,
          status: "continuing", ended: false, seriesType: "standard",
          nextAiring: "2025-01-01",
          seasons: [],
        },
      ]);
      mockSonarrClient.getQualityProfiles.mockResolvedValue([]);
      mockSonarrClient.getTags.mockResolvedValue([]);

      const result = await fetchArrMetadata("u1", "SERIES");

      expect(result["555"].hasUnaired).toBe(true);
    });
  });

  describe("MUSIC type", () => {
    it("returns empty map when no Lidarr instances exist", async () => {
      mockPrisma.lidarrInstance.findMany.mockResolvedValue([]);
      const result = await fetchArrMetadata("u1", "MUSIC");
      expect(result).toEqual({});
    });

    it("fetches and maps Lidarr artist metadata", async () => {
      mockPrisma.lidarrInstance.findMany.mockResolvedValue([
        { id: "l1", url: "http://lidarr", apiKey: "key" },
      ]);
      mockLidarrClient.getArtists.mockResolvedValue([
        {
          id: 1,
          foreignArtistId: "mb-abc-123",
          tags: [1],
          qualityProfileId: 3,
          monitored: true,
          ratings: { value: 7.5 },
          added: "2024-03-01",
          path: "/music/radiohead",
          statistics: { sizeOnDisk: 2000000000 },
        },
      ]);
      mockLidarrClient.getQualityProfiles.mockResolvedValue([
        { id: 3, name: "Lossless" },
      ]);
      mockLidarrClient.getTags.mockResolvedValue([{ id: 1, label: "favorite" }]);

      const result = await fetchArrMetadata("u1", "MUSIC");

      expect(result["mb-abc-123"]).toBeDefined();
      expect(result["mb-abc-123"].arrId).toBe(1);
      expect(result["mb-abc-123"].tags).toEqual(["favorite"]);
      expect(result["mb-abc-123"].qualityProfile).toBe("Lossless");
      expect(result["mb-abc-123"].monitored).toBe(true);
      expect(result["mb-abc-123"].rating).toBe(7.5);
      expect(result["mb-abc-123"].path).toBe("/music/radiohead");
      // Music-specific nulls
      expect(result["mb-abc-123"].tmdbRating).toBeNull();
      expect(result["mb-abc-123"].rtCriticRating).toBeNull();
      expect(result["mb-abc-123"].originalLanguage).toBeNull();
      expect(result["mb-abc-123"].releaseDate).toBeNull();
      expect(result["mb-abc-123"].firstAired).toBeNull();
    });
  });
});
