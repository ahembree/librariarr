import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  radarrInstance: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  sonarrInstance: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  lidarrInstance: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
}));

const mockRadarrClient = vi.hoisted(() => ({
  getMovies: vi.fn(),
  getQualityProfiles: vi.fn(),
  getTags: vi.fn(),
  getCustomFormatScores: vi.fn(),
}));

const mockSonarrClient = vi.hoisted(() => ({
  getSeries: vi.fn(),
  getSeriesIdsWithUpcomingEpisodes: vi.fn().mockResolvedValue(new Set()),
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

import { fetchArrMetadata, hasEnabledArrInstances, arrFamilyLabel } from "@/lib/lifecycle/fetch-arr-metadata";

describe("hasEnabledArrInstances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts enabled Radarr instances for MOVIE", async () => {
    mockPrisma.radarrInstance.count.mockResolvedValue(1);
    await expect(hasEnabledArrInstances("u1", "MOVIE")).resolves.toBe(true);
    expect(mockPrisma.radarrInstance.count).toHaveBeenCalledWith({
      where: { userId: "u1", enabled: true },
    });
  });

  it("answers with the named instance's own state, not the family's", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue({ id: "r2", name: "Radarr 4K", enabled: false });
    mockPrisma.radarrInstance.count.mockResolvedValue(3);
    await expect(hasEnabledArrInstances("u1", "MOVIE", "r2")).resolves.toBe(false);
    expect(mockPrisma.radarrInstance.count).not.toHaveBeenCalled();
  });

  it("counts the family when the named id is not one of its instances", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.radarrInstance.count.mockResolvedValue(1);
    await expect(hasEnabledArrInstances("u1", "MOVIE", "missing")).resolves.toBe(true);
  });

  it("counts enabled Sonarr instances for SERIES", async () => {
    mockPrisma.sonarrInstance.count.mockResolvedValue(0);
    await expect(hasEnabledArrInstances("u1", "SERIES")).resolves.toBe(false);
    expect(mockPrisma.sonarrInstance.count).toHaveBeenCalledWith({
      where: { userId: "u1", enabled: true },
    });
  });

  it("counts enabled Lidarr instances for MUSIC", async () => {
    mockPrisma.lidarrInstance.count.mockResolvedValue(0);
    await expect(hasEnabledArrInstances("u1", "MUSIC")).resolves.toBe(false);
    expect(mockPrisma.lidarrInstance.count).toHaveBeenCalledWith({
      where: { userId: "u1", enabled: true },
    });
  });
});

describe("arrFamilyLabel", () => {
  it("maps each library type to its Arr family", () => {
    expect(arrFamilyLabel("MOVIE")).toBe("Radarr");
    expect(arrFamilyLabel("SERIES")).toBe("Sonarr");
    expect(arrFamilyLabel("MUSIC")).toBe("Lidarr");
  });
});

describe("fetchArrMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no scores. Individual tests override as needed.
    mockRadarrClient.getCustomFormatScores.mockResolvedValue(new Map());
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
          movieFile: { quality: { quality: { name: "Bluray-1080p" } }, dateAdded: "2024-02-01", qualityCutoffNotMet: false },
          hasFile: true,
          movieFileId: 99,
          status: "released",
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
      expect(result["550"].sizeOnDisk).toBe(5000000000);
      expect(result["550"].originalLanguage).toBe("English");
      expect(result["550"].releaseDate).toBe("2024-06-01");
      expect(result["550"].inCinemasDate).toBe("2024-03-01");
      expect(result["550"].runtime).toBe(139);
      expect(result["550"].qualityName).toBe("Bluray-1080p");
      expect(result["550"].qualityCutoffMet).toBe(true); // !false
      expect(result["550"].downloadDate).toBe("2024-02-01");
      // Movie status is now populated (was previously hardcoded null).
      expect(result["550"].status).toBe("released");
    });

    it("merges customFormatScore from /moviefile, querying only movies with files", async () => {
      mockPrisma.radarrInstance.findMany.mockResolvedValue([
        { id: "r1", url: "http://radarr", apiKey: "key" },
      ]);
      mockRadarrClient.getMovies.mockResolvedValue([
        { id: 1, tmdbId: 100, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, hasFile: true, movieFile: { customFormatScore: 999 } },
        { id: 2, tmdbId: 200, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, hasFile: false, movieFile: null },
      ]);
      mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
      mockRadarrClient.getTags.mockResolvedValue([]);
      // The real score (from /moviefile) differs from the stale embedded value.
      mockRadarrClient.getCustomFormatScores.mockResolvedValue(new Map([[1, 50]]));

      const result = await fetchArrMetadata("u1", "MOVIE");

      // Only the movie with a file is queried for scores (plus a progress reporter).
      expect(mockRadarrClient.getCustomFormatScores).toHaveBeenCalledWith([1], expect.any(Function));
      // The /moviefile score wins over the unreliable embedded /movie value.
      expect(result["100"].customFormatScore).toBe(50);
      // No file → no score recorded → null.
      expect(result["200"].customFormatScore).toBeNull();
    });

    it("reports monotonic progress fractions ending at 1", async () => {
      mockPrisma.radarrInstance.findMany.mockResolvedValue([
        { id: "r1", url: "http://radarr", apiKey: "key" },
      ]);
      mockRadarrClient.getMovies.mockResolvedValue([
        { id: 1, tmdbId: 100, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, hasFile: true, movieFile: null },
      ]);
      mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
      mockRadarrClient.getTags.mockResolvedValue([]);
      // Simulate the moviefile sweep completing within its sub-range.
      mockRadarrClient.getCustomFormatScores.mockImplementation(async (_ids, onProgress) => {
        onProgress?.(1);
        return new Map();
      });

      const fractions: number[] = [];
      await fetchArrMetadata("u1", "MOVIE", (f) => fractions.push(f));

      expect(fractions.length).toBeGreaterThan(0);
      expect(fractions[fractions.length - 1]).toBe(1);
      // Post-list checkpoint (0.1) and post-scores checkpoint (0.85, the top of
      // the moviefile sweep's sub-range) are both reported.
      expect(fractions).toContain(0.1);
      expect(fractions).toContain(0.85);
      for (let i = 1; i < fractions.length; i++) {
        expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
      }
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
          inCinemas: null, runtime: null, movieFile: null,
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
          inCinemas: null, runtime: null, movieFile: null,
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
          { id: 1, tmdbId: 100, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, added: null, path: null, sizeOnDisk: null, originalLanguage: null, digitalRelease: null, physicalRelease: null, inCinemas: null, runtime: null, movieFile: null },
        ])
        .mockResolvedValueOnce([
          { id: 2, tmdbId: 200, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, added: null, path: null, sizeOnDisk: null, originalLanguage: null, digitalRelease: null, physicalRelease: null, inCinemas: null, runtime: null, movieFile: null },
        ]);
      mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
      mockRadarrClient.getTags.mockResolvedValue([]);

      const result = await fetchArrMetadata("u1", "MOVIE");

      expect(Object.keys(result).sort()).toEqual(["100", "200"]);
      expect(result["100"].arrId).toBe(1);
      expect(result["200"].arrId).toBe(2);
    });

    it("keeps the oldest instance's record for a movie on several instances", async () => {
      mockPrisma.radarrInstance.findMany.mockResolvedValue([
        { id: "r1", url: "http://radarr1", apiKey: "key1" },
        { id: "r2", url: "http://radarr2", apiKey: "key2" },
      ]);
      mockRadarrClient.getMovies
        .mockResolvedValueOnce([{ id: 1, tmdbId: 100, tags: [1], qualityProfileId: 1, monitored: true, ratings: {}, added: null, path: null, sizeOnDisk: null, originalLanguage: null, digitalRelease: null, physicalRelease: null, inCinemas: null, runtime: null, movieFile: null }])
        .mockResolvedValueOnce([{ id: 9, tmdbId: 100, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, added: null, path: null, sizeOnDisk: null, originalLanguage: null, digitalRelease: null, physicalRelease: null, inCinemas: null, runtime: null, movieFile: null }]);
      mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
      mockRadarrClient.getTags.mockResolvedValue([{ id: 1, label: "keep" }]);

      const result = await fetchArrMetadata("u1", "MOVIE");

      expect(mockPrisma.radarrInstance.findMany).toHaveBeenCalledWith({
        where: { userId: "u1", enabled: true },
        orderBy: { createdAt: "asc" },
      });
      expect(result["100"].arrId).toBe(1);
      expect(result["100"].tags).toEqual(["keep"]);
    });

    it("reads only the rule set's own instance when one is named", async () => {
      mockPrisma.radarrInstance.findFirst.mockResolvedValue({ id: "r2", name: "Radarr 4K", enabled: true });
      mockPrisma.radarrInstance.findMany.mockResolvedValue([
        { id: "r2", url: "http://radarr2", apiKey: "key2" },
      ]);
      mockRadarrClient.getMovies.mockResolvedValueOnce([{ id: 9, tmdbId: 100, tags: [1], qualityProfileId: 1, monitored: true, ratings: {}, added: null, path: null, sizeOnDisk: null, originalLanguage: null, digitalRelease: null, physicalRelease: null, inCinemas: null, runtime: null, movieFile: null }]);
      mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
      mockRadarrClient.getTags.mockResolvedValue([{ id: 1, label: "keep" }]);

      const result = await fetchArrMetadata("u1", "MOVIE", undefined, "r2");

      expect(mockPrisma.radarrInstance.findFirst).toHaveBeenCalledWith({
        where: { id: "r2", userId: "u1" },
        select: { id: true, name: true, enabled: true },
      });
      expect(mockPrisma.radarrInstance.findMany).toHaveBeenCalledWith({
        where: { id: "r2", userId: "u1", enabled: true },
        orderBy: { createdAt: "asc" },
      });
      expect(result["100"].arrId).toBe(9);
    });

    it("falls back to every instance when the named id is not a Radarr instance", async () => {
      mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
      mockPrisma.radarrInstance.findMany.mockResolvedValue([]);

      await fetchArrMetadata("u1", "MOVIE", undefined, "sonarr-1");

      expect(mockPrisma.radarrInstance.findMany).toHaveBeenCalledWith({
        where: { userId: "u1", enabled: true },
        orderBy: { createdAt: "asc" },
      });
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
      // Breaking Bad: 62 regular episodes over 5 seasons plus 9 specials,
      // only seasons 1 and 5 (and the specials) monitored and on disk.
      const season = (seasonNumber: number, monitored: boolean, total: number, onDisk: number) => ({
        seasonNumber,
        monitored,
        statistics: { episodeCount: onDisk, episodeFileCount: onDisk, totalEpisodeCount: total },
      });
      mockSonarrClient.getSeries.mockResolvedValue([
        {
          id: 1,
          tvdbId: 81189,
          tags: [1],
          qualityProfileId: 5,
          monitored: true,
          ratings: { votes: 1000, value: 9.0 },
          added: "2023-01-01",
          path: "/tv/breaking-bad",
          // Sonarr's own episodeCount (23) counts only monitored-and-aired or
          // on-disk episodes; its totalEpisodeCount (71) includes the specials.
          statistics: { sizeOnDisk: 80000000000, seasonCount: 5, episodeCount: 23, episodeFileCount: 23, totalEpisodeCount: 71 },
          originalLanguage: { id: 1, name: "English" },
          firstAired: "2008-01-20",
          status: "ended",
          ended: true,
          seriesType: "standard",
          seasons: [
            season(0, true, 9, 0),
            season(1, true, 7, 7),
            season(2, false, 13, 0),
            season(3, false, 13, 0),
            season(4, false, 13, 0),
            season(5, true, 16, 16),
          ],
        },
      ]);
      mockSonarrClient.getQualityProfiles.mockResolvedValue([
        { id: 5, name: "HD-1080p" },
      ]);
      mockSonarrClient.getTags.mockResolvedValue([{ id: 1, label: "auto" }]);

      const result = await fetchArrMetadata("u1", "SERIES");

      expect(Object.keys(result)).toEqual(["81189"]);
      const meta = result["81189"];
      expect(meta.arrId).toBe(1);
      expect(meta.tags).toEqual(["auto"]);
      expect(meta.qualityProfile).toBe("HD-1080p");
      // Sonarr's flat series rating maps to `rating`; it has no per-source
      // TMDB or Rotten Tomatoes rating, so those stay null.
      expect(meta.rating).toBe(9.0);
      expect(meta.tmdbRating).toBeNull();
      expect(meta.rtCriticRating).toBeNull();
      expect(meta.sizeOnDisk).toBe(80000000000);
      expect(meta.originalLanguage).toBe("English");
      expect(meta.firstAired).toBe("2008-01-20");
      expect(meta.seasonCount).toBe(5);
      // Every regular episode Sonarr knows of — not its monitored-or-on-disk
      // count, and without the specials.
      expect(meta.episodeCount).toBe(62);
      expect(meta.status).toBe("ended");
      expect(meta.ended).toBe(true);
      expect(meta.seriesType).toBe("standard");
      expect(meta.hasUnaired).toBe(false);
      // Seasons 1 and 5; a monitored specials season is not one of them.
      expect(meta.monitoredSeasonCount).toBe(2);
      // Every episode of the monitored seasons, aired or not.
      expect(meta.monitoredEpisodeCount).toBe(23);
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

    it("sets hasUnaired from the calendar when only an unmonitored episode is upcoming", async () => {
      // nextAiring covers monitored episodes only.
      mockPrisma.sonarrInstance.findMany.mockResolvedValue([
        { id: "s1", url: "http://sonarr", apiKey: "key" },
      ]);
      mockSonarrClient.getSeries.mockResolvedValue([
        {
          id: 7, tvdbId: 777, tags: [], qualityProfileId: 1,
          monitored: false, ratings: {}, path: "/tv/show",
          status: "continuing", ended: false, seriesType: "standard",
          seasons: [],
        },
        {
          id: 8, tvdbId: 888, tags: [], qualityProfileId: 1,
          monitored: false, ratings: {}, path: "/tv/other",
          status: "continuing", ended: false, seriesType: "standard",
          seasons: [],
        },
      ]);
      mockSonarrClient.getSeriesIdsWithUpcomingEpisodes.mockResolvedValueOnce(new Set([7]));
      mockSonarrClient.getQualityProfiles.mockResolvedValue([]);
      mockSonarrClient.getTags.mockResolvedValue([]);

      const result = await fetchArrMetadata("u1", "SERIES");

      expect(result["777"].hasUnaired).toBe(true);
      expect(result["888"].hasUnaired).toBe(false);
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
          foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
          tags: [1],
          qualityProfileId: 3,
          monitored: true,
          ratings: { value: 7.5 },
          added: "2024-03-01",
          path: "/music/radiohead",
          statistics: { sizeOnDisk: 2000000000 },
          status: "continuing",
        },
      ]);
      mockLidarrClient.getQualityProfiles.mockResolvedValue([
        { id: 3, name: "Lossless" },
      ]);
      mockLidarrClient.getTags.mockResolvedValue([{ id: 1, label: "favorite" }]);

      const result = await fetchArrMetadata("u1", "MUSIC");

      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"]).toBeDefined();
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].arrId).toBe(1);
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].tags).toEqual(["favorite"]);
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].qualityProfile).toBe("Lossless");
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].monitored).toBe(true);
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].rating).toBe(7.5);
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].path).toBe("/music/radiohead");
      // Artist status is now populated (was previously hardcoded null).
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].status).toBe("continuing");
      // Music-specific nulls
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].tmdbRating).toBeNull();
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].rtCriticRating).toBeNull();
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].originalLanguage).toBeNull();
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].releaseDate).toBeNull();
      expect(result["a74b1b7f-71a5-4011-9441-d0b5e4122711"].firstAired).toBeNull();
    });
  });
});
