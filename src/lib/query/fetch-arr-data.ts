import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { mapRadarrMovie, mapSonarrSeries, mapLidarrArtist } from "@/lib/arr/metadata";
import { splitProgress, subProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

// How often (in items) the in-memory mapping loop reports sub-progress.
const MAP_PROGRESS_INTERVAL = 500;

type QueryMediaType = "MOVIE" | "SERIES" | "MUSIC";

const ARR_FAMILY: Record<QueryMediaType, { key: "radarr" | "sonarr" | "lidarr"; label: string; typeLabel: string }> = {
  MOVIE: { key: "radarr", label: "Radarr", typeLabel: "Movies" },
  SERIES: { key: "sonarr", label: "Sonarr", typeLabel: "Series" },
  MUSIC: { key: "lidarr", label: "Lidarr", typeLabel: "Music" },
};

/**
 * Which of a query's media types its Arr criteria can be judged for: those
 * with an Arr server selected that still exists and is enabled. A type without
 * one has no Arr data, so a rule like "Found In Arr = false" would match every
 * item of it — the engine leaves such a type out of the results instead, and
 * `unevaluable` says why for each.
 */
export async function resolveQueryArrScope(
  userId: string,
  arrServerIds: { radarr?: string; sonarr?: string; lidarr?: string } | undefined,
  mediaTypes: string[],
): Promise<{ evaluable: QueryMediaType[]; unevaluable: Array<{ type: QueryMediaType; reason: string }> }> {
  const typesInScope = (mediaTypes.length === 0 ? ["MOVIE", "SERIES", "MUSIC"] : mediaTypes) as QueryMediaType[];
  const evaluable: QueryMediaType[] = [];
  const unevaluable: Array<{ type: QueryMediaType; reason: string }> = [];
  for (const type of typesInScope) {
    const family = ARR_FAMILY[type];
    if (!family) continue;
    const id = arrServerIds?.[family.key];
    if (!id) {
      unevaluable.push({ type, reason: `${family.typeLabel} left out: no ${family.label} server is selected for the query's Arr criteria` });
      continue;
    }
    const where = { id, userId };
    const select = { name: true, enabled: true } as const;
    const instance =
      type === "MOVIE" ? await prisma.radarrInstance.findFirst({ where, select })
      : type === "SERIES" ? await prisma.sonarrInstance.findFirst({ where, select })
      : await prisma.lidarrInstance.findFirst({ where, select });
    if (!instance) {
      unevaluable.push({ type, reason: `${family.typeLabel} left out: the selected ${family.label} server no longer exists` });
    } else if (!instance.enabled) {
      unevaluable.push({ type, reason: `${family.typeLabel} left out: ${family.label} server "${instance.name}" is disabled` });
    } else {
      evaluable.push(type);
    }
  }
  return { evaluable, unevaluable };
}

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
  // A disabled instance is one the user switched off — its data may be stale
  // or its server gone — so it answers no criteria (resolveQueryArrScope).
  const instance = await prisma.radarrInstance.findFirst({
    where: { id: instanceId, userId, enabled: true },
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
  // A disabled instance is one the user switched off — its data may be stale
  // or its server gone — so it answers no criteria (resolveQueryArrScope).
  const instance = await prisma.sonarrInstance.findFirst({
    where: { id: instanceId, userId, enabled: true },
  });
  if (!instance) return null;

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
  const arrData: ArrDataMap = {};

  const mapReport = subProgress(onProgress, 0.5, 1);
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    arrData[String(s.tvdbId)] = mapSonarrSeries(s, profileMap, tagMap, upcoming);
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
  // A disabled instance is one the user switched off — its data may be stale
  // or its server gone — so it answers no criteria (resolveQueryArrScope).
  const instance = await prisma.lidarrInstance.findFirst({
    where: { id: instanceId, userId, enabled: true },
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
