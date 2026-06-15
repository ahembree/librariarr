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
      id: 5, tmdbId: 100, qualityProfileId: 1, monitored: true, tags: [10, 20],
      ratings: { imdb: { value: 8.1 }, tmdb: { value: 7.2 }, rottenTomatoes: { value: 90 } },
      added: "2024-01-01", path: "/movies/x", sizeOnDisk: 2048, originalLanguage: { id: 1, name: "English" },
      digitalRelease: "2024-02-01", physicalRelease: "2024-03-01", inCinemas: "2024-01-10",
      runtime: 120, status: "released",
      // qualityCutoffNotMet is nested on the movieFile (MovieFileResource), not the movie.
      movieFile: { quality: { quality: { name: "Bluray-1080p" } }, dateAdded: "2024-02-02", customFormatScore: 150, qualityCutoffNotMet: false },
    } as RadarrMovie;

    expect(mapRadarrMovie(movie, profileMap, tagMap)).toMatchObject({
      arrId: 5,
      qualityProfile: "HD-1080p",
      tags: ["keep", "archive"],
      monitored: true,
      rating: 8.1,
      tmdbRating: 7.2,
      rtCriticRating: 9, // 90 / 10
      qualityName: "Bluray-1080p",
      qualityCutoffMet: true, // !qualityCutoffNotMet
      customFormatScore: 150,
      seasonCount: null,
      monitoredSeasonCount: null,
    });
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
      id: 7, tvdbId: 200, qualityProfileId: 1, monitored: true, tags: [10],
      ratings: { votes: 500, value: 9 }, added: "2023-01-01", path: "/tv/x",
      statistics: { sizeOnDisk: 5000, seasonCount: 3, episodeCount: 30 },
      originalLanguage: { id: 1, name: "English" }, firstAired: "2020-01-01", status: "continuing",
      ended: false, seriesType: "standard", nextAiring: "2025-01-01",
      seasons: [
        { monitored: true, statistics: { episodeCount: 10 } },
        { monitored: false, statistics: { episodeCount: 8 } },
      ],
    } as unknown as SonarrSeries;

    expect(mapSonarrSeries(series, profileMap, tagMap)).toMatchObject({
      arrId: 7,
      seasonCount: 3,
      episodeCount: 30,
      hasUnaired: true, // nextAiring present
      monitoredSeasonCount: 1,
      monitoredEpisodeCount: 10, // only the monitored season's episodes
      customFormatScore: null,
      qualityName: null,
      runtime: null,
      // Sonarr's flat rating maps to `rating`; no per-source TMDB/RT rating.
      rating: 9,
      tmdbRating: null,
      rtCriticRating: null,
    });
  });
});

describe("mapLidarrArtist", () => {
  it("maps artist fields and leaves movie/series-only fields null", () => {
    const artist = {
      id: 9, foreignArtistId: "mb-1", qualityProfileId: 1, monitored: true, tags: [20],
      ratings: { value: 7 }, added: "2024-01-01", path: "/music/x",
      statistics: { sizeOnDisk: 3000 }, status: "continuing",
    } as unknown as LidarrArtist;

    expect(mapLidarrArtist(artist, profileMap, tagMap)).toMatchObject({
      arrId: 9,
      rating: 7,
      qualityProfile: "HD-1080p",
      tags: ["archive"],
      tmdbRating: null,
      customFormatScore: null,
      seasonCount: null,
      sizeOnDisk: 3000,
    });
  });
});
