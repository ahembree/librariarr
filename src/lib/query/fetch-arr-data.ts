import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { mapRadarrMovie, mapSonarrSeries, mapLidarrArtist } from "@/lib/arr/metadata";
import { splitProgress, subProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

// How often (in items) the in-memory mapping loop reports sub-progress.
const MAP_PROGRESS_INTERVAL = 500;

/**
 * Fetch Arr metadata from specific instances for the query builder.
 * Unlike the lifecycle fetcher (which queries ALL instances), this fetches
 * from the user-selected instance per Arr type.
 *
 * Returns a map keyed by media type: { MOVIE: ArrDataMap, SERIES: ArrDataMap, MUSIC: ArrDataMap }
 *
 * `onProgress` (optional) reports combined 0..1 completion across the per-type
 * fetches, which run concurrently.
 */
export async function fetchArrDataForQuery(
  userId: string,
  arrServerIds: { radarr?: string; sonarr?: string; lidarr?: string },
  mediaTypes: string[],
  onProgress?: FractionReporter,
): Promise<Record<string, ArrDataMap>> {
  const result: Record<string, ArrDataMap> = {};
  const typesInScope = mediaTypes.length === 0
    ? ["MOVIE", "SERIES", "MUSIC"]
    : mediaTypes;

  // Resolve which per-type fetches will run BEFORE creating reporters so the
  // combined progress is averaged over exactly the active fetches.
  const tasks: Array<(report: FractionReporter) => Promise<void>> = [];

  if (arrServerIds.radarr && typesInScope.includes("MOVIE")) {
    tasks.push(async (report) => {
      const data = await fetchRadarrData(userId, arrServerIds.radarr!, report);
      if (data) result.MOVIE = data;
    });
  }

  if (arrServerIds.sonarr && typesInScope.includes("SERIES")) {
    tasks.push(async (report) => {
      const data = await fetchSonarrData(userId, arrServerIds.sonarr!, report);
      if (data) result.SERIES = data;
    });
  }

  if (arrServerIds.lidarr && typesInScope.includes("MUSIC")) {
    tasks.push(async (report) => {
      const data = await fetchLidarrData(userId, arrServerIds.lidarr!, report);
      if (data) result.MUSIC = data;
    });
  }

  const reporters = splitProgress(onProgress, tasks.length);
  await Promise.all(tasks.map((task, i) => task(reporters[i])));
  return result;
}

async function fetchRadarrData(
  userId: string,
  instanceId: string,
  onProgress?: FractionReporter,
): Promise<ArrDataMap | null> {
  const instance = await prisma.radarrInstance.findFirst({
    where: { id: instanceId, userId },
  });
  if (!instance) return null;

  const client = new RadarrClient(instance.url, instance.apiKey);
  const [movies, profiles, tags] = await Promise.all([
    client.getMovies(),
    client.getQualityProfiles(),
    client.getTags(),
  ]);
  onProgress?.(0.1);

  const tagMap = new Map(tags.map((t) => [t.id, t.label]));
  const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
  const arrData: ArrDataMap = {};

  // customFormatScore is only computed by Radarr's /moviefile endpoint,
  // never on the /movie listing — fetch it separately and merge it in.
  // This chunked sweep is the slow part, so it owns the bulk of the bar.
  const scores = await client.getCustomFormatScores(
    movies.filter((m) => m.hasFile).map((m) => m.id),
    subProgress(onProgress, 0.1, 0.85),
  );
  const mapReport = subProgress(onProgress, 0.85, 1);
  for (let i = 0; i < movies.length; i++) {
    const movie = movies[i];
    arrData[String(movie.tmdbId)] = mapRadarrMovie(
      movie, profileMap, tagMap, scores.get(movie.id) ?? null,
    );
    if (mapReport && (i + 1) % MAP_PROGRESS_INTERVAL === 0) {
      mapReport((i + 1) / movies.length);
    }
  }
  onProgress?.(1);

  return arrData;
}

async function fetchSonarrData(
  userId: string,
  instanceId: string,
  onProgress?: FractionReporter,
): Promise<ArrDataMap | null> {
  const instance = await prisma.sonarrInstance.findFirst({
    where: { id: instanceId, userId },
  });
  if (!instance) return null;

  const client = new SonarrClient(instance.url, instance.apiKey);
  const [series, profiles, tags] = await Promise.all([
    client.getSeries(),
    client.getQualityProfiles(),
    client.getTags(),
  ]);
  onProgress?.(0.5);

  const tagMap = new Map(tags.map((t) => [t.id, t.label]));
  const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
  const arrData: ArrDataMap = {};

  const mapReport = subProgress(onProgress, 0.5, 1);
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    arrData[String(s.tvdbId)] = mapSonarrSeries(s, profileMap, tagMap);
    if (mapReport && (i + 1) % MAP_PROGRESS_INTERVAL === 0) {
      mapReport((i + 1) / series.length);
    }
  }
  onProgress?.(1);

  return arrData;
}

async function fetchLidarrData(
  userId: string,
  instanceId: string,
  onProgress?: FractionReporter,
): Promise<ArrDataMap | null> {
  const instance = await prisma.lidarrInstance.findFirst({
    where: { id: instanceId, userId },
  });
  if (!instance) return null;

  const client = new LidarrClient(instance.url, instance.apiKey);
  const [artists, profiles, tags] = await Promise.all([
    client.getArtists(),
    client.getQualityProfiles(),
    client.getTags(),
  ]);
  onProgress?.(0.5);

  const tagMap = new Map(tags.map((t) => [t.id, t.label]));
  const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
  const arrData: ArrDataMap = {};

  const mapReport = subProgress(onProgress, 0.5, 1);
  for (let i = 0; i < artists.length; i++) {
    const a = artists[i];
    arrData[a.foreignArtistId] = mapLidarrArtist(a, profileMap, tagMap);
    if (mapReport && (i + 1) % MAP_PROGRESS_INTERVAL === 0) {
      mapReport((i + 1) / artists.length);
    }
  }
  onProgress?.(1);

  return arrData;
}
