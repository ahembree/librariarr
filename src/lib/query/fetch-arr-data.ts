import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import type { ArrDataMap } from "@/lib/rules/engine";

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

  for (const movie of movies) {
    arrData[String(movie.tmdbId)] = {
      arrId: movie.id,
      tags: movie.tags.map((tid) => tagMap.get(tid) ?? String(tid)),
      qualityProfile: profileMap.get(movie.qualityProfileId) ?? "Unknown",
      monitored: movie.monitored,
      rating: movie.ratings?.imdb?.value ?? null,
      tmdbRating: movie.ratings?.tmdb?.value ?? null,
      rtCriticRating: movie.ratings?.rottenTomatoes?.value != null ? movie.ratings.rottenTomatoes.value / 10 : null,
      dateAdded: movie.added ?? null,
      path: movie.path ?? null,
      sizeOnDisk: movie.sizeOnDisk ?? null,
      originalLanguage: movie.originalLanguage?.name ?? null,
      releaseDate: movie.digitalRelease ?? movie.physicalRelease ?? null,
      inCinemasDate: movie.inCinemas ?? null,
      runtime: movie.runtime ?? null,
      qualityName: movie.movieFile?.quality?.quality?.name ?? null,
      qualityCutoffMet: movie.qualityCutoffNotMet != null ? !movie.qualityCutoffNotMet : null,
      downloadDate: movie.movieFile?.dateAdded ?? null,
      firstAired: null,
      seasonCount: null,
      episodeCount: null,
      status: null,
      ended: null,
      seriesType: null,
      hasUnaired: null,
      monitoredSeasonCount: null,
      monitoredEpisodeCount: null,
    };
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
    const monitoredSeasons = s.seasons?.filter((sn) => sn.monitored) ?? [];
    arrData[String(s.tvdbId)] = {
      arrId: s.id,
      tags: s.tags.map((tid) => tagMap.get(tid) ?? String(tid)),
      qualityProfile: profileMap.get(s.qualityProfileId) ?? "Unknown",
      monitored: s.monitored,
      rating: s.ratings?.imdb?.value ?? null,
      tmdbRating: s.ratings?.tmdb?.value ?? null,
      rtCriticRating: s.ratings?.rottenTomatoes?.value != null ? s.ratings.rottenTomatoes.value / 10 : null,
      dateAdded: s.added ?? null,
      path: s.path ?? null,
      sizeOnDisk: s.statistics?.sizeOnDisk ?? null,
      originalLanguage: s.originalLanguage?.name ?? null,
      releaseDate: null,
      inCinemasDate: null,
      runtime: null,
      qualityName: null,
      qualityCutoffMet: null,
      downloadDate: null,
      firstAired: s.firstAired ?? null,
      seasonCount: s.statistics?.seasonCount ?? null,
      episodeCount: s.statistics?.episodeCount ?? null,
      status: s.status ?? null,
      ended: s.ended ?? null,
      seriesType: s.seriesType ?? null,
      hasUnaired: s.nextAiring != null ? true : false,
      monitoredSeasonCount: monitoredSeasons.length,
      monitoredEpisodeCount: monitoredSeasons.reduce((sum, sn) => sum + (sn.statistics?.episodeCount ?? 0), 0),
    };
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
    arrData[a.foreignArtistId] = {
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
      downloadDate: null,
      firstAired: null,
      seasonCount: null,
      episodeCount: null,
      status: null,
      ended: null,
      seriesType: null,
      hasUnaired: null,
      monitoredSeasonCount: null,
      monitoredEpisodeCount: null,
    };
  }

  return arrData;
}
