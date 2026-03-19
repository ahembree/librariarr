import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import type { ArrDataMap } from "@/lib/rules/engine";

export async function fetchArrMetadata(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC"
): Promise<ArrDataMap> {
  const arrData: ArrDataMap = {};

  if (type === "MOVIE") {
    const instances = await prisma.radarrInstance.findMany({
      where: { userId, enabled: true },
    });
    for (const inst of instances) {
      const client = new RadarrClient(inst.url, inst.apiKey);
      const [movies, profiles, tags] = await Promise.all([
        client.getMovies(),
        client.getQualityProfiles(),
        client.getTags(),
      ]);
      const tagMap = new Map(tags.map((t) => [t.id, t.label]));
      const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
      for (const movie of movies) {
        arrData[String(movie.tmdbId)] = {
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
    }
  } else if (type === "MUSIC") {
    const instances = await prisma.lidarrInstance.findMany({
      where: { userId, enabled: true },
    });
    for (const inst of instances) {
      const client = new LidarrClient(inst.url, inst.apiKey);
      const [artists, profiles, tags] = await Promise.all([
        client.getArtists(),
        client.getQualityProfiles(),
        client.getTags(),
      ]);
      const tagMap = new Map(tags.map((t) => [t.id, t.label]));
      const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
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
    }
  } else {
    const instances = await prisma.sonarrInstance.findMany({
      where: { userId, enabled: true },
    });
    for (const inst of instances) {
      const client = new SonarrClient(inst.url, inst.apiKey);
      const [series, profiles, tags] = await Promise.all([
        client.getSeries(),
        client.getQualityProfiles(),
        client.getTags(),
      ]);
      const tagMap = new Map(tags.map((t) => [t.id, t.label]));
      const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
      for (const s of series) {
        const monitoredSeasons = s.seasons?.filter((sn) => sn.monitored) ?? [];
        arrData[String(s.tvdbId)] = {
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
    }
  }

  return arrData;
}
