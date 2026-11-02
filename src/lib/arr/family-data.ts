import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { mapRadarrMovie, mapSonarrSeries, mapLidarrArtist } from "@/lib/arr/metadata";
import type { ArrFamily } from "@/lib/arr/instances";
import { splitProgress, subProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { ArrDataMap, ArrMetadata } from "@/lib/rules/lifecycle-engine";

// How often (in items) the in-memory mapping loop reports sub-progress.
const MAP_PROGRESS_INTERVAL = 500;

interface ArrInstanceCredentials {
  url: string;
  apiKey: string;
}

export interface ArrFamilyLoadOptions {
  /**
   * Read Radarr's custom-format scores. Only `/moviefile` computes them — one
   * request per 100 movies — so they are fetched only for a rule, query or
   * column that reads Custom Format Score (`arrCustomFormatScore`). Without
   * them every movie's score reads null, which nothing else looks at.
   */
  customFormatScores?: boolean;
  onProgress?: FractionReporter;
}

/** Map `records` into `out` by key, reporting the mapping loop's progress. */
function mapInto<T>(
  out: ArrDataMap,
  records: T[],
  keyOf: (record: T) => string,
  map: (record: T) => ArrMetadata,
  report: FractionReporter | undefined,
): void {
  for (let i = 0; i < records.length; i++) {
    out[keyOf(records[i])] = map(records[i]);
    if (report && (i + 1) % MAP_PROGRESS_INTERVAL === 0) report((i + 1) / records.length);
  }
}

/**
 * One instance's records as the rule engines read them, keyed by the
 * family's external id: TMDB for Radarr, TVDB for Sonarr, the artist's
 * MusicBrainz id for Lidarr.
 */
export async function loadArrInstanceData(
  family: ArrFamily,
  instance: ArrInstanceCredentials,
  options: ArrFamilyLoadOptions = {},
): Promise<ArrDataMap> {
  const { onProgress, customFormatScores = false } = options;
  const out: ArrDataMap = {};

  if (family === "RADARR") {
    const client = new RadarrClient(instance.url, instance.apiKey);
    const [movies, profiles, tags] = await Promise.all([
      client.getMovies(),
      client.getQualityProfiles(),
      client.getTags(),
    ]);
    const tagMap = new Map(tags.map((t) => [t.id, t.label]));
    const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
    let scores = new Map<number, number>();
    let mapReport: FractionReporter | undefined;
    if (customFormatScores) {
      onProgress?.(0.1);
      // The chunked /moviefile sweep is the slow part, so it owns the bulk of the bar.
      scores = await client.getCustomFormatScores(
        movies.filter((m) => m.hasFile).map((m) => m.id),
        subProgress(onProgress, 0.1, 0.85),
      );
      mapReport = subProgress(onProgress, 0.85, 1);
    } else {
      onProgress?.(0.5);
      mapReport = subProgress(onProgress, 0.5, 1);
    }
    mapInto(
      out,
      movies,
      (m) => String(m.tmdbId),
      (m) => mapRadarrMovie(m, profileMap, tagMap, scores.get(m.id) ?? null),
      mapReport,
    );
  } else if (family === "SONARR") {
    const client = new SonarrClient(instance.url, instance.apiKey);
    const [series, profiles, tags, upcoming] = await Promise.all([
      client.getSeries(),
      client.getQualityProfiles(),
      client.getTags(),
      client.getSeriesIdsWithUpcomingEpisodes(),
    ]);
    onProgress?.(0.5);
    const tagMap = new Map(tags.map((t) => [t.id, t.label]));
    const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
    mapInto(
      out,
      series,
      (s) => String(s.tvdbId),
      (s) => mapSonarrSeries(s, profileMap, tagMap, upcoming),
      subProgress(onProgress, 0.5, 1),
    );
  } else {
    const client = new LidarrClient(instance.url, instance.apiKey);
    const [artists, profiles, tags] = await Promise.all([
      client.getArtists(),
      client.getQualityProfiles(),
      client.getTags(),
    ]);
    onProgress?.(0.5);
    const tagMap = new Map(tags.map((t) => [t.id, t.label]));
    const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
    mapInto(
      out,
      artists,
      (a) => a.foreignArtistId,
      (a) => mapLidarrArtist(a, profileMap, tagMap),
      subProgress(onProgress, 0.5, 1),
    );
  }

  onProgress?.(1);
  return out;
}

/**
 * One record of one instance, by the family's external id, mapped exactly as
 * `loadArrInstanceData` maps it — for a caller that needs a single item
 * (Test Media) rather than the whole library. A record whose own id is not
 * exactly `externalId` is not it: `loadArrInstanceData` keys by that id, so
 * Lidarr answering an old MusicBrainz id with the merged artist (which
 * `getArtistByMusicBrainzId` accepts) is not found here either.
 */
export async function loadArrRecord(
  family: ArrFamily,
  instance: ArrInstanceCredentials,
  externalId: string,
  options: Pick<ArrFamilyLoadOptions, "customFormatScores"> = {},
): Promise<ArrMetadata | null> {
  if (family === "RADARR") {
    const tmdbId = Number(externalId);
    if (!Number.isSafeInteger(tmdbId)) return null;
    const client = new RadarrClient(instance.url, instance.apiKey);
    const movie = await client.getMovieByTmdbId(tmdbId);
    if (!movie || String(movie.tmdbId) !== externalId) return null;
    const [profiles, tags, scores] = await Promise.all([
      client.getQualityProfiles(),
      client.getTags(),
      // As the library read asks: only for a movie with a file.
      options.customFormatScores && movie.hasFile
        ? client.getCustomFormatScores([movie.id])
        : Promise.resolve(new Map<number, number>()),
    ]);
    return mapRadarrMovie(
      movie,
      new Map(profiles.map((p) => [p.id, p.name])),
      new Map(tags.map((t) => [t.id, t.label])),
      scores.get(movie.id) ?? null,
    );
  }
  if (family === "SONARR") {
    const tvdbId = Number(externalId);
    if (!Number.isSafeInteger(tvdbId)) return null;
    const client = new SonarrClient(instance.url, instance.apiKey);
    const series = await client.getSeriesByTvdbId(tvdbId);
    if (!series || String(series.tvdbId) !== externalId) return null;
    const [profiles, tags, upcoming] = await Promise.all([
      client.getQualityProfiles(),
      client.getTags(),
      client.getSeriesIdsWithUpcomingEpisodes(),
    ]);
    return mapSonarrSeries(
      series,
      new Map(profiles.map((p) => [p.id, p.name])),
      new Map(tags.map((t) => [t.id, t.label])),
      upcoming,
    );
  }
  const client = new LidarrClient(instance.url, instance.apiKey);
  const artist = await client.getArtistByMusicBrainzId(externalId);
  if (!artist || artist.foreignArtistId !== externalId) return null;
  const [profiles, tags] = await Promise.all([client.getQualityProfiles(), client.getTags()]);
  return mapLidarrArtist(
    artist,
    new Map(profiles.map((p) => [p.id, p.name])),
    new Map(tags.map((t) => [t.id, t.label])),
  );
}

/**
 * Several instances' records merged into one map. The instances are read in
 * parallel and merged in the order given, so an item on several keeps the
 * record of the FIRST instance listing it — callers pass them oldest first,
 * the fixed order the one-at-a-time reads used to give.
 */
export async function loadArrFamilyData(
  family: ArrFamily,
  instances: ArrInstanceCredentials[],
  options: ArrFamilyLoadOptions = {},
): Promise<ArrDataMap> {
  const reporters = splitProgress(options.onProgress, instances.length);
  const maps = await Promise.all(
    instances.map((instance, i) =>
      loadArrInstanceData(family, instance, { ...options, onProgress: reporters[i] }),
    ),
  );
  const merged: ArrDataMap = {};
  for (const map of maps) {
    for (const key in map) {
      if (!(key in merged)) merged[key] = map[key];
    }
  }
  return merged;
}
