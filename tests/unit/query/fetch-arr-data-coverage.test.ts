import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  radarrInstance: { findFirst: vi.fn() },
  sonarrInstance: { findFirst: vi.fn() },
  lidarrInstance: { findFirst: vi.fn() },
}));
const mockRadarr = vi.hoisted(() => ({
  getMovies: vi.fn(), getQualityProfiles: vi.fn(), getTags: vi.fn(), getCustomFormatScores: vi.fn(),
}));
const mockSonarr = vi.hoisted(() => ({
  getSeries: vi.fn(), getSeriesIdsWithUpcomingEpisodes: vi.fn(), getQualityProfiles: vi.fn(), getTags: vi.fn(),
}));
const mockLidarr = vi.hoisted(() => ({ getArtists: vi.fn(), getQualityProfiles: vi.fn(), getTags: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/arr/radarr-client", () => ({ RadarrClient: function () { return mockRadarr; } }));
vi.mock("@/lib/arr/sonarr-client", () => ({ SonarrClient: function () { return mockSonarr; } }));
vi.mock("@/lib/arr/lidarr-client", () => ({ LidarrClient: function () { return mockLidarr; } }));

import { fetchArrDataForQuery } from "@/lib/query/fetch-arr-data";

const instance = { id: "i1", url: "http://arr", apiKey: "k" };

beforeEach(() => {
  vi.resetAllMocks();
  mockRadarr.getCustomFormatScores.mockResolvedValue(new Map());
  mockSonarr.getSeriesIdsWithUpcomingEpisodes.mockResolvedValue(new Set<number>());
});

describe("fetchArrDataForQuery — instance scoping", () => {
  it("looks each instance up scoped to the user and skips a family whose instance is not theirs", async () => {
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.lidarrInstance.findFirst.mockResolvedValue(null);

    const result = await fetchArrDataForQuery("u1", { sonarr: "s1", lidarr: "l1" }, ["SERIES", "MUSIC"]);

    expect(result).toEqual({});
    expect(mockPrisma.sonarrInstance.findFirst).toHaveBeenCalledWith({ where: { id: "s1", userId: "u1" } });
    expect(mockPrisma.lidarrInstance.findFirst).toHaveBeenCalledWith({ where: { id: "l1", userId: "u1" } });
    expect(mockSonarr.getSeries).not.toHaveBeenCalled();
    expect(mockLidarr.getArtists).not.toHaveBeenCalled();
  });

  it("does not fetch a family whose media type is out of scope", async () => {
    await fetchArrDataForQuery("u1", { radarr: "r1", sonarr: "s1", lidarr: "l1" }, ["MOVIE"]);
    expect(mockPrisma.radarrInstance.findFirst).toHaveBeenCalled();
    expect(mockPrisma.sonarrInstance.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.lidarrInstance.findFirst).not.toHaveBeenCalled();
  });

  it("treats an empty media-type list as every type", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.lidarrInstance.findFirst.mockResolvedValue(null);
    await fetchArrDataForQuery("u1", { radarr: "r1", sonarr: "s1", lidarr: "l1" }, []);
    expect(mockPrisma.radarrInstance.findFirst).toHaveBeenCalled();
    expect(mockPrisma.sonarrInstance.findFirst).toHaveBeenCalled();
    expect(mockPrisma.lidarrInstance.findFirst).toHaveBeenCalled();
  });
});

describe("fetchArrDataForQuery — mapping and progress", () => {
  it("maps Sonarr series by TVDB id with tag/profile names and reports progress through the loop", async () => {
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(instance);
    mockSonarr.getSeries.mockResolvedValue(
      Array.from({ length: 501 }, (_, i) => ({
        id: i + 1, tvdbId: 1000 + i, tags: i === 0 ? [7, 99] : [], qualityProfileId: 3, monitored: true,
        statistics: { totalEpisodeCount: 10, sizeOnDisk: 5 },
      })),
    );
    mockSonarr.getQualityProfiles.mockResolvedValue([{ id: 3, name: "HD-1080p" }]);
    mockSonarr.getTags.mockResolvedValue([{ id: 7, label: "keep" }]);
    const progress: number[] = [];

    const result = await fetchArrDataForQuery("u1", { sonarr: "s1" }, ["SERIES"], (f) => progress.push(f));

    expect(Object.keys(result.SERIES)).toHaveLength(501);
    expect(result.SERIES["1000"]).toMatchObject({ arrId: 1, tags: ["keep", "99"], qualityProfile: "HD-1080p", episodeCount: 10 });
    expect(progress.at(-1)).toBe(1);
    expect(progress.some((p) => p > 0.5 && p < 1)).toBe(true);
  });

  it("maps Lidarr artists by foreign artist id and reports progress", async () => {
    mockPrisma.lidarrInstance.findFirst.mockResolvedValue(instance);
    mockLidarr.getArtists.mockResolvedValue(
      Array.from({ length: 500 }, (_, i) => ({
        id: i + 1, foreignArtistId: `mb-${i}`, tags: [], qualityProfileId: 9, monitored: false, status: "ended",
      })),
    );
    mockLidarr.getQualityProfiles.mockResolvedValue([]);
    mockLidarr.getTags.mockResolvedValue([]);
    const progress: number[] = [];

    const result = await fetchArrDataForQuery("u1", { lidarr: "l1" }, ["MUSIC"], (f) => progress.push(f));

    expect(result.MUSIC["mb-0"]).toMatchObject({ arrId: 1, qualityProfile: "Unknown", monitored: false, status: "ended" });
    expect(progress.at(-1)).toBe(1);
  });

  it("reports Radarr mapping progress past 500 movies", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(instance);
    mockRadarr.getMovies.mockResolvedValue(
      Array.from({ length: 501 }, (_, i) => ({
        id: i + 1, tmdbId: i + 1, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, hasFile: false,
      })),
    );
    mockRadarr.getQualityProfiles.mockResolvedValue([]);
    mockRadarr.getTags.mockResolvedValue([]);
    const progress: number[] = [];

    const result = await fetchArrDataForQuery("u1", { radarr: "r1" }, ["MOVIE"], (f) => progress.push(f));

    expect(Object.keys(result.MOVIE)).toHaveLength(501);
    expect(mockRadarr.getCustomFormatScores).toHaveBeenCalledWith([], expect.any(Function));
    // The mapping loop owns 0.85..1 and reports after its 500th movie.
    expect(progress.some((p) => p > 0.85 && p < 1)).toBe(true);
    expect(progress.at(-1)).toBe(1);
  });

  it("propagates an Arr failure rather than returning a partial map", async () => {
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(instance);
    mockSonarr.getSeries.mockRejectedValue(new Error("Sonarr down"));
    mockSonarr.getQualityProfiles.mockResolvedValue([]);
    mockSonarr.getTags.mockResolvedValue([]);
    await expect(fetchArrDataForQuery("u1", { sonarr: "s1" }, ["SERIES"])).rejects.toThrow("Sonarr down");
  });
});
