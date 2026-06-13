import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  radarrInstance: { findFirst: vi.fn() },
  sonarrInstance: { findFirst: vi.fn() },
  lidarrInstance: { findFirst: vi.fn() },
}));

const mockRadarrClient = vi.hoisted(() => ({
  getMovies: vi.fn(),
  getQualityProfiles: vi.fn(),
  getTags: vi.fn(),
  getCustomFormatScores: vi.fn(),
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

import { fetchArrDataForQuery } from "@/lib/query/fetch-arr-data";

describe("fetchArrDataForQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRadarrClient.getCustomFormatScores.mockResolvedValue(new Map());
  });

  it("returns an empty result when no arr server ids are supplied", async () => {
    const result = await fetchArrDataForQuery("u1", {}, []);
    expect(result).toEqual({});
    expect(mockPrisma.radarrInstance.findFirst).not.toHaveBeenCalled();
  });

  it("returns no MOVIE data when the selected Radarr instance is not found", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    const result = await fetchArrDataForQuery("u1", { radarr: "r1" }, ["MOVIE"]);
    expect(result.MOVIE).toBeUndefined();
  });

  it("merges customFormatScore from /moviefile, querying only movies with files", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue({
      id: "r1", url: "http://radarr", apiKey: "key",
    });
    mockRadarrClient.getMovies.mockResolvedValue([
      { id: 1, tmdbId: 100, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, hasFile: true, movieFile: { customFormatScore: 999 } },
      { id: 2, tmdbId: 200, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, hasFile: false, movieFile: null },
    ]);
    mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
    mockRadarrClient.getTags.mockResolvedValue([]);
    mockRadarrClient.getCustomFormatScores.mockResolvedValue(new Map([[1, 50]]));

    const result = await fetchArrDataForQuery("u1", { radarr: "r1" }, ["MOVIE"]);

    // Only the movie with a file is queried for scores (plus a progress reporter).
    expect(mockRadarrClient.getCustomFormatScores).toHaveBeenCalledWith([1], expect.any(Function));
    // The /moviefile score wins over the unreliable embedded /movie value.
    expect(result.MOVIE["100"].customFormatScore).toBe(50);
    // No file → no score recorded → null.
    expect(result.MOVIE["200"].customFormatScore).toBeNull();
  });

  it("reports combined progress across active fetches, ending at 1", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue({ id: "r1", url: "http://radarr", apiKey: "key" });
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue({ id: "n1", url: "http://sonarr", apiKey: "key" });
    mockRadarrClient.getMovies.mockResolvedValue([
      { id: 1, tmdbId: 100, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, hasFile: true, movieFile: null },
    ]);
    mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
    mockRadarrClient.getTags.mockResolvedValue([]);
    mockRadarrClient.getCustomFormatScores.mockResolvedValue(new Map());
    mockSonarrClient.getSeries.mockResolvedValue([
      { id: 1, tvdbId: 200, tags: [], qualityProfileId: 1, monitored: true, ratings: {}, statistics: {}, seasons: [] },
    ]);
    mockSonarrClient.getQualityProfiles.mockResolvedValue([]);
    mockSonarrClient.getTags.mockResolvedValue([]);

    const fractions: number[] = [];
    await fetchArrDataForQuery("u1", { radarr: "r1", sonarr: "n1" }, ["MOVIE", "SERIES"], (f) => fractions.push(f));

    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    // Combined across two fetches, so intermediate values never exceed 1.
    expect(Math.max(...fractions)).toBeLessThanOrEqual(1);
  });

  it("scopes the Radarr lookup to the user and selected instance", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue({
      id: "r1", url: "http://radarr", apiKey: "key",
    });
    mockRadarrClient.getMovies.mockResolvedValue([]);
    mockRadarrClient.getQualityProfiles.mockResolvedValue([]);
    mockRadarrClient.getTags.mockResolvedValue([]);

    await fetchArrDataForQuery("u1", { radarr: "r1" }, ["MOVIE"]);

    expect(mockPrisma.radarrInstance.findFirst).toHaveBeenCalledWith({
      where: { id: "r1", userId: "u1" },
    });
  });
});
