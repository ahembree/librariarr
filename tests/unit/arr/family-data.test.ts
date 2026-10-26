import { describe, it, expect, beforeEach, vi } from "vitest";

const radarr = vi.hoisted(() => ({
  getMovies: vi.fn(), getQualityProfiles: vi.fn(), getTags: vi.fn(), getCustomFormatScores: vi.fn(),
}));
const sonarr = vi.hoisted(() => ({
  getSeries: vi.fn(), getQualityProfiles: vi.fn(), getTags: vi.fn(), getSeriesIdsWithUpcomingEpisodes: vi.fn(),
}));
const lidarr = vi.hoisted(() => ({ getArtists: vi.fn(), getQualityProfiles: vi.fn(), getTags: vi.fn() }));
const constructed = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: function (url: string) { constructed.push(url); return radarr; },
}));
vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: function (url: string) { constructed.push(url); return sonarr; },
}));
vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: function (url: string) { constructed.push(url); return lidarr; },
}));

import { loadArrFamilyData, loadArrInstanceData, loadArrRecord } from "@/lib/arr/family-data";

const inst = { url: "http://arr", apiKey: "k" };

describe("loadArrInstanceData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructed.length = 0;
    for (const c of [radarr, sonarr, lidarr]) {
      c.getQualityProfiles.mockResolvedValue([{ id: 1, name: "HD" }]);
      c.getTags.mockResolvedValue([{ id: 5, label: "keep" }]);
    }
  });

  it("keys Radarr movies by TMDB id, with the scores only when asked", async () => {
    radarr.getMovies.mockResolvedValue([
      { id: 1, tmdbId: 10, tags: [5], qualityProfileId: 1, monitored: true, hasFile: true },
      { id: 2, tmdbId: 20, tags: [], qualityProfileId: 1, monitored: true, hasFile: false },
    ]);
    radarr.getCustomFormatScores.mockResolvedValue(new Map([[1, 42]]));

    const without = await loadArrInstanceData("RADARR", inst);
    expect(radarr.getCustomFormatScores).not.toHaveBeenCalled();
    expect(without["10"]).toMatchObject({ arrId: 1, tags: ["keep"], qualityProfile: "HD", customFormatScore: null });

    const fractions: number[] = [];
    const withScores = await loadArrInstanceData("RADARR", inst, { customFormatScores: true, onProgress: (f) => fractions.push(f) });
    expect(radarr.getCustomFormatScores).toHaveBeenCalledWith([1], expect.any(Function));
    expect(withScores["10"].customFormatScore).toBe(42);
    expect(fractions[0]).toBe(0.1);
    expect(fractions.at(-1)).toBe(1);
  });

  it("keys Sonarr series by TVDB id and reads the upcoming-episode calendar", async () => {
    sonarr.getSeries.mockResolvedValue([{ id: 3, tvdbId: 81189, tags: [], qualityProfileId: 1, monitored: true, seasons: [] }]);
    sonarr.getSeriesIdsWithUpcomingEpisodes.mockResolvedValue(new Set([3]));
    const fractions: number[] = [];
    const data = await loadArrInstanceData("SONARR", inst, { onProgress: (f) => fractions.push(f) });
    expect(data["81189"]).toMatchObject({ arrId: 3, hasUnaired: true });
    expect(fractions).toEqual([0.5, 1]);
  });

  it("keys Lidarr artists by their MusicBrainz id", async () => {
    lidarr.getArtists.mockResolvedValue([{ id: 4, foreignArtistId: "mbid-1", tags: [5], qualityProfileId: 1, monitored: false }]);
    const data = await loadArrInstanceData("LIDARR", inst);
    expect(data["mbid-1"]).toMatchObject({ arrId: 4, tags: ["keep"], monitored: false });
  });
});

describe("loadArrRecord", () => {
  const radarrOne = vi.fn();
  const sonarrOne = vi.fn();
  const lidarrOne = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(radarr, { getMovieByTmdbId: radarrOne });
    Object.assign(sonarr, { getSeriesByTvdbId: sonarrOne });
    Object.assign(lidarr, { getArtistByMusicBrainzId: lidarrOne });
    for (const c of [radarr, sonarr, lidarr]) {
      c.getQualityProfiles.mockResolvedValue([{ id: 1, name: "HD" }]);
      c.getTags.mockResolvedValue([{ id: 5, label: "keep" }]);
    }
  });

  it("maps one movie exactly as the library read maps it", async () => {
    const movie = { id: 1, tmdbId: 10, tags: [5], qualityProfileId: 1, monitored: true, hasFile: true };
    radarrOne.mockResolvedValue(movie);
    radarr.getMovies.mockResolvedValue([movie]);
    radarr.getCustomFormatScores.mockResolvedValue(new Map([[1, 42]]));

    const one = await loadArrRecord("RADARR", inst, "10", { customFormatScores: true });
    const all = await loadArrInstanceData("RADARR", inst, { customFormatScores: true });
    expect(one).toEqual(all["10"]);
    expect(radarrOne).toHaveBeenCalledWith(10);
    expect(radarr.getCustomFormatScores).toHaveBeenCalledWith([1]);

    vi.clearAllMocks();
    expect((await loadArrRecord("RADARR", inst, "10"))!.customFormatScore).toBeNull();
    expect(radarr.getCustomFormatScores).not.toHaveBeenCalled();
  });

  it("finds nothing for an id the record does not carry exactly", async () => {
    radarrOne.mockResolvedValue({ id: 1, tmdbId: 10, tags: [], qualityProfileId: 1, monitored: true, hasFile: false });
    expect(await loadArrRecord("RADARR", inst, "010")).toBeNull();
    expect(await loadArrRecord("RADARR", inst, "abc")).toBeNull();
    // Lidarr answers an old (merged) MusicBrainz id with the artist's new one;
    // the library read keys by the new id, so neither finds it under the old.
    lidarrOne.mockResolvedValue({ id: 4, foreignArtistId: "new", tags: [], qualityProfileId: 1, monitored: true });
    expect(await loadArrRecord("LIDARR", inst, "old")).toBeNull();
    expect(await loadArrRecord("LIDARR", inst, "new")).toMatchObject({ arrId: 4 });
  });

  it("maps a series with the upcoming-episode calendar", async () => {
    sonarrOne.mockResolvedValue({ id: 3, tvdbId: 81189, tags: [], qualityProfileId: 1, monitored: true, seasons: [] });
    sonarr.getSeriesIdsWithUpcomingEpisodes.mockResolvedValue(new Set([3]));
    expect(await loadArrRecord("SONARR", inst, "81189")).toMatchObject({ arrId: 3, hasUnaired: true, qualityProfile: "HD" });
    sonarrOne.mockResolvedValue(null);
    expect(await loadArrRecord("SONARR", inst, "81189")).toBeNull();
  });
});

describe("loadArrFamilyData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructed.length = 0;
    lidarr.getQualityProfiles.mockResolvedValue([]);
    lidarr.getTags.mockResolvedValue([]);
  });

  it("merges instances in the order given, the first one listing an item keeping it", async () => {
    lidarr.getArtists
      .mockResolvedValueOnce([{ id: 1, foreignArtistId: "a", tags: [], qualityProfileId: 1, monitored: true }])
      .mockResolvedValueOnce([
        { id: 2, foreignArtistId: "a", tags: [], qualityProfileId: 1, monitored: true },
        { id: 3, foreignArtistId: "b", tags: [], qualityProfileId: 1, monitored: true },
      ]);
    const fractions: number[] = [];
    const data = await loadArrFamilyData(
      "LIDARR",
      [{ url: "http://one", apiKey: "k" }, { url: "http://two", apiKey: "k" }],
      { onProgress: (f) => fractions.push(f) },
    );
    expect(constructed).toEqual(["http://one", "http://two"]);
    expect(data.a.arrId).toBe(1);
    expect(data.b.arrId).toBe(3);
    expect(fractions.at(-1)).toBe(1);
  });

  it("answers an empty map for no instances", async () => {
    expect(await loadArrFamilyData("RADARR", [])).toEqual({});
  });
});
