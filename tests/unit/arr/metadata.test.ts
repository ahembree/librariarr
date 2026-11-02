import { describe, it, expect } from "vitest";
import { mapRadarrMovie, mapSonarrSeries, mapLidarrArtist } from "@/lib/arr/metadata";
import type { RadarrMovie } from "@/lib/arr/radarr-client";
import type { SonarrSeries } from "@/lib/arr/sonarr-client";
import type { LidarrArtist } from "@/lib/arr/lidarr-client";

const profileMap = new Map<number, string>([[1, "HD-1080p"]]);
const tagMap = new Map<number, string>([[10, "keep"], [20, "archive"]]);

describe("mapRadarrMovie", () => {
  it("maps ratings, tags, quality, and customFormatScore; leaves series fields null", () => {
    const movie = {
      id: 5, title: "Dune", year: 2021, tmdbId: 438631, qualityProfileId: 1, monitored: true, tags: [10, 20],
      ratings: {
        imdb: { votes: 812_000, value: 8.1, type: "user" },
        tmdb: { votes: 12_400, value: 7.2, type: "user" },
        rottenTomatoes: { votes: 0, value: 90, type: "user" },
      },
      added: "2024-01-01T09:15:00Z", path: "/movies/Dune (2021)", sizeOnDisk: 15_032_385_536,
      hasFile: true, movieFileId: 77,
      originalLanguage: { id: 1, name: "English" },
      digitalRelease: "2021-10-22T00:00:00Z", physicalRelease: "2022-01-11T00:00:00Z", inCinemas: "2021-09-15T00:00:00Z",
      runtime: 155, status: "released",
      // qualityCutoffNotMet is nested on the movieFile (MovieFileResource), not the movie.
      movieFile: {
        quality: { quality: { name: "Bluray-1080p" } },
        dateAdded: "2024-01-02T03:04:05Z",
        customFormatScore: 150,
        qualityCutoffNotMet: false,
      },
    } as RadarrMovie;

    expect(mapRadarrMovie(movie, profileMap, tagMap)).toEqual({
      arrId: 5,
      tags: ["keep", "archive"],
      qualityProfile: "HD-1080p",
      monitored: true,
      rating: 8.1,
      tmdbRating: 7.2,
      rtCriticRating: 9, // 90% on Rotten Tomatoes, on the rules' 0-10 scale
      dateAdded: "2024-01-01T09:15:00Z",
      path: "/movies/Dune (2021)",
      sizeOnDisk: 15_032_385_536,
      originalLanguage: "English",
      // The digital release is preferred over the physical one.
      releaseDate: "2021-10-22T00:00:00Z",
      inCinemasDate: "2021-09-15T00:00:00Z",
      runtime: 155,
      qualityName: "Bluray-1080p",
      qualityCutoffMet: true, // !qualityCutoffNotMet
      customFormatScore: 150,
      downloadDate: "2024-01-02T03:04:05Z",
      firstAired: null,
      seasonCount: null,
      episodeCount: null,
      status: "released",
      ended: null,
      seriesType: null,
      hasUnaired: null,
      monitoredSeasonCount: null,
      monitoredEpisodeCount: null,
    });
  });

  it("falls back to the physical release date when there is no digital one", () => {
    const movie = {
      id: 6, tmdbId: 27205, qualityProfileId: 1, monitored: true, tags: [],
      physicalRelease: "2010-12-07T00:00:00Z",
    } as unknown as RadarrMovie;
    expect(mapRadarrMovie(movie, profileMap, tagMap).releaseDate).toBe("2010-12-07T00:00:00Z");
  });

  it("reads qualityCutoffMet from the nested movieFile, not the top-level movie", () => {
    const base = { id: 1, tmdbId: 1, qualityProfileId: 1, monitored: false, tags: [] } as unknown as RadarrMovie;
    // Cutoff NOT met → qualityCutoffMet false.
    expect(
      mapRadarrMovie({ ...base, movieFile: { qualityCutoffNotMet: true } } as RadarrMovie, profileMap, tagMap).qualityCutoffMet,
    ).toBe(false);
    // Cutoff met → qualityCutoffMet true.
    expect(
      mapRadarrMovie({ ...base, movieFile: { qualityCutoffNotMet: false } } as RadarrMovie, profileMap, tagMap).qualityCutoffMet,
    ).toBe(true);
    // No movie file → null (cutoff is N/A without a downloaded file).
    expect(mapRadarrMovie(base, profileMap, tagMap).qualityCutoffMet).toBeNull();
    // A stray top-level value (which the real Radarr API never sends) is ignored.
    expect(
      mapRadarrMovie({ ...base, qualityCutoffNotMet: false } as unknown as RadarrMovie, profileMap, tagMap).qualityCutoffMet,
    ).toBeNull();
  });

  it("preserves a zero/negative custom format score and nulls a missing one (no falsy coercion)", () => {
    const base = { id: 1, tmdbId: 1, qualityProfileId: 1, monitored: false, tags: [] } as unknown as RadarrMovie;
    expect(mapRadarrMovie({ ...base, movieFile: { customFormatScore: 0 } } as RadarrMovie, profileMap, tagMap).customFormatScore).toBe(0);
    expect(mapRadarrMovie({ ...base, movieFile: { customFormatScore: -40 } } as RadarrMovie, profileMap, tagMap).customFormatScore).toBe(-40);
    expect(mapRadarrMovie(base, profileMap, tagMap).customFormatScore).toBeNull(); // no movieFile
  });

  it("uses the explicit customFormatScore override over the embedded movieFile value", () => {
    const base = { id: 1, tmdbId: 1, qualityProfileId: 1, monitored: false, tags: [] } as unknown as RadarrMovie;
    // Override wins over the (unreliable) embedded value.
    expect(
      mapRadarrMovie({ ...base, movieFile: { customFormatScore: 999 } } as RadarrMovie, profileMap, tagMap, 50).customFormatScore,
    ).toBe(50);
    // A zero override is preserved (no falsy coercion).
    expect(mapRadarrMovie(base, profileMap, tagMap, 0).customFormatScore).toBe(0);
    // A negative override is preserved.
    expect(mapRadarrMovie(base, profileMap, tagMap, -25).customFormatScore).toBe(-25);
    // null override falls back to the embedded value, then to null.
    expect(
      mapRadarrMovie({ ...base, movieFile: { customFormatScore: 7 } } as RadarrMovie, profileMap, tagMap, null).customFormatScore,
    ).toBe(7);
    expect(mapRadarrMovie(base, profileMap, tagMap, null).customFormatScore).toBeNull();
  });

  it("falls back to Unknown profile and the raw tag id when unmapped", () => {
    const movie = { id: 2, tmdbId: 2, qualityProfileId: 999, monitored: false, tags: [55] } as unknown as RadarrMovie;
    const m = mapRadarrMovie(movie, profileMap, tagMap);
    expect(m.qualityProfile).toBe("Unknown");
    expect(m.tags).toEqual(["55"]);
  });
});

describe("mapSonarrSeries", () => {
  it("maps season/episode stats and leaves movie-only fields null", () => {
    const series = {
      id: 7, title: "Severance", tvdbId: 371980, qualityProfileId: 1, monitored: true, tags: [10],
      ratings: { votes: 500, value: 9 }, added: "2023-01-01T08:00:00Z", path: "/tv/Severance",
      statistics: { sizeOnDisk: 52_000_000_000, seasonCount: 3, episodeCount: 30, totalEpisodeCount: 30, episodeFileCount: 18 },
      originalLanguage: { id: 1, name: "English" }, firstAired: "2022-02-17T00:00:00Z", status: "continuing",
      ended: false, seriesType: "standard", nextAiring: "2025-01-17T02:00:00Z",
      seasons: [
        { seasonNumber: 1, monitored: true, statistics: { episodeCount: 10, totalEpisodeCount: 10, episodeFileCount: 10 } },
        { seasonNumber: 2, monitored: false, statistics: { episodeCount: 8, totalEpisodeCount: 8, episodeFileCount: 8 } },
        { seasonNumber: 3, monitored: false, statistics: { episodeCount: 12, totalEpisodeCount: 12, episodeFileCount: 0 } },
      ],
    } as unknown as SonarrSeries;

    expect(mapSonarrSeries(series, profileMap, tagMap)).toEqual({
      arrId: 7,
      tags: ["keep"],
      qualityProfile: "HD-1080p",
      monitored: true,
      // Sonarr's flat rating maps to `rating`; no per-source TMDB/RT rating.
      rating: 9,
      tmdbRating: null,
      rtCriticRating: null,
      dateAdded: "2023-01-01T08:00:00Z",
      path: "/tv/Severance",
      sizeOnDisk: 52_000_000_000,
      originalLanguage: "English",
      releaseDate: null,
      inCinemasDate: null,
      runtime: null,
      qualityName: null,
      qualityCutoffMet: null,
      customFormatScore: null,
      downloadDate: null,
      firstAired: "2022-02-17T00:00:00Z",
      seasonCount: 3,
      episodeCount: 30,
      status: "continuing",
      ended: false,
      seriesType: "standard",
      hasUnaired: true, // nextAiring present
      monitoredSeasonCount: 1,
      monitoredEpisodeCount: 10, // only the monitored season's episodes
    });
  });
});

describe("mapSonarrSeries counts", () => {
  const base = {
    id: 7, tvdbId: 200, qualityProfileId: 1, monitored: false, tags: [],
    status: "continuing",
  };

  it("counts every regular episode, not Sonarr's monitored-and-aired-or-on-disk count", () => {
    const series = {
      ...base,
      // An unmonitored 100-episode show with no files: Sonarr's episodeCount is 0.
      statistics: { seasonCount: 2, episodeCount: 0, totalEpisodeCount: 103 },
      seasons: [
        { seasonNumber: 0, monitored: true, statistics: { episodeCount: 0, totalEpisodeCount: 3 } },
        { seasonNumber: 1, monitored: false, statistics: { episodeCount: 0, totalEpisodeCount: 50 } },
        { seasonNumber: 2, monitored: false, statistics: { episodeCount: 0, totalEpisodeCount: 50 } },
      ],
    } as unknown as SonarrSeries;

    const meta = mapSonarrSeries(series, profileMap, tagMap);
    expect(meta.episodeCount).toBe(100);
    // A monitored specials season is not one of the show's monitored seasons.
    expect(meta.monitoredSeasonCount).toBe(0);
    expect(meta.monitoredEpisodeCount).toBe(0);
  });

  it("counts unaired episodes of monitored seasons as monitored episodes", () => {
    const series = {
      ...base,
      statistics: { seasonCount: 1, episodeCount: 4, totalEpisodeCount: 10 },
      seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 4, totalEpisodeCount: 10 } }],
    } as unknown as SonarrSeries;
    expect(mapSonarrSeries(series, profileMap, tagMap).monitoredEpisodeCount).toBe(10);
  });

  it("sees unaired episodes that are unmonitored, through the calendar", () => {
    const series = { ...base, nextAiring: undefined } as unknown as SonarrSeries;
    expect(mapSonarrSeries(series, profileMap, tagMap, new Set()).hasUnaired).toBe(false);
    expect(mapSonarrSeries(series, profileMap, tagMap, new Set([7])).hasUnaired).toBe(true);
    expect(mapSonarrSeries({ ...series, status: "upcoming" } as SonarrSeries, profileMap, tagMap).hasUnaired).toBe(true);
  });
});

describe("mapLidarrArtist", () => {
  it("maps artist fields and leaves movie/series-only fields null", () => {
    const artist = {
      id: 9, artistName: "Radiohead", foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
      qualityProfileId: 1, metadataProfileId: 1, monitored: true, tags: [20],
      ratings: { votes: 41, value: 7 }, added: "2024-01-01T10:00:00Z", path: "/music/Radiohead",
      statistics: { albumCount: 9, trackCount: 101, trackFileCount: 101, sizeOnDisk: 3_221_225_472 },
      status: "continuing",
    } as LidarrArtist;

    expect(mapLidarrArtist(artist, profileMap, tagMap)).toEqual({
      arrId: 9,
      tags: ["archive"],
      qualityProfile: "HD-1080p",
      monitored: true,
      rating: 7,
      tmdbRating: null,
      rtCriticRating: null,
      dateAdded: "2024-01-01T10:00:00Z",
      path: "/music/Radiohead",
      sizeOnDisk: 3_221_225_472,
      originalLanguage: null,
      releaseDate: null,
      inCinemasDate: null,
      runtime: null,
      qualityName: null,
      qualityCutoffMet: null,
      customFormatScore: null,
      downloadDate: null,
      firstAired: null,
      seasonCount: null,
      episodeCount: null,
      status: "continuing",
      ended: null,
      seriesType: null,
      hasUnaired: null,
      monitoredSeasonCount: null,
      monitoredEpisodeCount: null,
    });
  });
});
