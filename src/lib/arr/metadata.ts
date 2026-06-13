import type { RadarrMovie } from "@/lib/arr/radarr-client";
import type { SonarrSeries } from "@/lib/arr/sonarr-client";
import type { LidarrArtist } from "@/lib/arr/lidarr-client";
import type { ArrMetadata } from "@/lib/rules/lifecycle-engine";

/**
 * Shared mappers from Arr client records to the engine's `ArrMetadata` shape.
 *
 * Both metadata fetchers (`lib/lifecycle/fetch-arr-metadata` over all enabled
 * instances and `lib/query/fetch-arr-data` over a single selected instance)
 * call these, so the per-type field mapping lives in exactly one place — adding
 * a new `ArrMetadata` field is a one-line change here, not six across two files.
 *
 * `profileMap` maps quality-profile id → name; `tagMap` maps tag id → label.
 */

export function mapRadarrMovie(
  movie: RadarrMovie,
  profileMap: Map<number, string>,
  tagMap: Map<number, string>,
): ArrMetadata {
  return {
    arrId: movie.id,
    tags: movie.tags.map((tid) => tagMap.get(tid) ?? String(tid)),
    qualityProfile: profileMap.get(movie.qualityProfileId) ?? "Unknown",
    monitored: movie.monitored,
    rating: movie.ratings?.imdb?.value ?? null,
    tmdbRating: movie.ratings?.tmdb?.value ?? null,
    rtCriticRating: movie.ratings?.rottenTomatoes?.value != null
      ? movie.ratings.rottenTomatoes.value / 10
      : null,
    dateAdded: movie.added ?? null,
    path: movie.path ?? null,
    sizeOnDisk: movie.sizeOnDisk ?? null,
    originalLanguage: movie.originalLanguage?.name ?? null,
    releaseDate: movie.digitalRelease ?? movie.physicalRelease ?? null,
    inCinemasDate: movie.inCinemas ?? null,
    runtime: movie.runtime ?? null,
    qualityName: movie.movieFile?.quality?.quality?.name ?? null,
    qualityCutoffMet: movie.qualityCutoffNotMet != null ? !movie.qualityCutoffNotMet : null,
    customFormatScore: movie.movieFile?.customFormatScore ?? null,
    downloadDate: movie.movieFile?.dateAdded ?? null,
    firstAired: null,
    seasonCount: null,
    episodeCount: null,
    status: movie.status ?? null,
    ended: null,
    seriesType: null,
    hasUnaired: null,
    monitoredSeasonCount: null,
    monitoredEpisodeCount: null,
  };
}

export function mapSonarrSeries(
  s: SonarrSeries,
  profileMap: Map<number, string>,
  tagMap: Map<number, string>,
): ArrMetadata {
  const monitoredSeasons = s.seasons?.filter((sn) => sn.monitored) ?? [];
  return {
    arrId: s.id,
    tags: s.tags.map((tid) => tagMap.get(tid) ?? String(tid)),
    qualityProfile: profileMap.get(s.qualityProfileId) ?? "Unknown",
    monitored: s.monitored,
    rating: s.ratings?.imdb?.value ?? null,
    tmdbRating: s.ratings?.tmdb?.value ?? null,
    rtCriticRating: s.ratings?.rottenTomatoes?.value != null
      ? s.ratings.rottenTomatoes.value / 10
      : null,
    dateAdded: s.added ?? null,
    path: s.path ?? null,
    sizeOnDisk: s.statistics?.sizeOnDisk ?? null,
    originalLanguage: s.originalLanguage?.name ?? null,
    releaseDate: null,
    inCinemasDate: null,
    runtime: null,
    qualityName: null,
    qualityCutoffMet: null,
    customFormatScore: null,
    downloadDate: null,
    firstAired: s.firstAired ?? null,
    seasonCount: s.statistics?.seasonCount ?? null,
    episodeCount: s.statistics?.episodeCount ?? null,
    status: s.status ?? null,
    ended: s.ended ?? null,
    seriesType: s.seriesType ?? null,
    hasUnaired: s.nextAiring != null ? true : false,
    monitoredSeasonCount: monitoredSeasons.length,
    monitoredEpisodeCount: monitoredSeasons.reduce(
      (sum, sn) => sum + (sn.statistics?.episodeCount ?? 0),
      0,
    ),
  };
}

export function mapLidarrArtist(
  a: LidarrArtist,
  profileMap: Map<number, string>,
  tagMap: Map<number, string>,
): ArrMetadata {
  return {
    arrId: a.id,
    tags: a.tags.map((tid) => tagMap.get(tid) ?? String(tid)),
    qualityProfile: profileMap.get(a.qualityProfileId) ?? "Unknown",
    monitored: a.monitored,
    rating: a.ratings?.value ?? null,
    tmdbRating: null,
    rtCriticRating: null,
    dateAdded: a.added ?? null,
    path: a.path ?? null,
    sizeOnDisk: a.statistics?.sizeOnDisk ?? null,
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
    status: a.status ?? null,
    ended: null,
    seriesType: null,
    hasUnaired: null,
    monitoredSeasonCount: null,
    monitoredEpisodeCount: null,
  };
}
