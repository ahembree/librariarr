import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { mapRadarrMovie, mapSonarrSeries, mapLidarrArtist } from "@/lib/arr/metadata";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

/**
 * Fetch Arr metadata from specific instances for the query builder.
 * Unlike the lifecycle fetcher (which queries ALL instances), this fetches
 * from the user-selected instance per Arr type.
 *
 * Returns a map keyed by media type: { MOVIE: ArrDataMap, SERIES: ArrDataMap, MUSIC: ArrDataMap }
 */
export async function fetchArrDataForQuery(
  userId: string,
  arrServerIds: { radarr?: string; sonarr?: string; lidarr?: string },
  mediaTypes: string[],
): Promise<Record<string, ArrDataMap>> {
  const result: Record<string, ArrDataMap> = {};
  const typesInScope = mediaTypes.length === 0
    ? ["MOVIE", "SERIES", "MUSIC"]
    : mediaTypes;

  const promises: Promise<void>[] = [];

  if (arrServerIds.radarr && typesInScope.includes("MOVIE")) {
    promises.push(
      fetchRadarrData(userId, arrServerIds.radarr).then((data) => {
        if (data) result.MOVIE = data;
      }),
    );
  }

  if (arrServerIds.sonarr && typesInScope.includes("SERIES")) {
    promises.push(
      fetchSonarrData(userId, arrServerIds.sonarr).then((data) => {
        if (data) result.SERIES = data;
      }),
    );
  }

  if (arrServerIds.lidarr && typesInScope.includes("MUSIC")) {
    promises.push(
      fetchLidarrData(userId, arrServerIds.lidarr).then((data) => {
        if (data) result.MUSIC = data;
      }),
    );
  }

  await Promise.all(promises);
  return result;
}

async function fetchRadarrData(userId: string, instanceId: string): Promise<ArrDataMap | null> {
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

  const tagMap = new Map(tags.map((t) => [t.id, t.label]));
  const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
  const arrData: ArrDataMap = {};

  // customFormatScore is only computed by Radarr's /moviefile endpoint,
  // never on the /movie listing — fetch it separately and merge it in.
  const scores = await client.getCustomFormatScores(
    movies.filter((m) => m.hasFile).map((m) => m.id),
  );
  for (const movie of movies) {
    arrData[String(movie.tmdbId)] = mapRadarrMovie(
      movie, profileMap, tagMap, scores.get(movie.id) ?? null,
    );
  }

  return arrData;
}

async function fetchSonarrData(userId: string, instanceId: string): Promise<ArrDataMap | null> {
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

  const tagMap = new Map(tags.map((t) => [t.id, t.label]));
  const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
  const arrData: ArrDataMap = {};

  for (const s of series) {
    arrData[String(s.tvdbId)] = mapSonarrSeries(s, profileMap, tagMap);
  }

  return arrData;
}

async function fetchLidarrData(userId: string, instanceId: string): Promise<ArrDataMap | null> {
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

  const tagMap = new Map(tags.map((t) => [t.id, t.label]));
  const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
  const arrData: ArrDataMap = {};

  for (const a of artists) {
    arrData[a.foreignArtistId] = mapLidarrArtist(a, profileMap, tagMap);
  }

  return arrData;
}
