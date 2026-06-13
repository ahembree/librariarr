import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { mapRadarrMovie, mapSonarrSeries, mapLidarrArtist } from "@/lib/arr/metadata";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

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
        arrData[a.foreignArtistId] = mapLidarrArtist(a, profileMap, tagMap);
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
        arrData[String(s.tvdbId)] = mapSonarrSeries(s, profileMap, tagMap);
      }
    }
  }

  return arrData;
}
