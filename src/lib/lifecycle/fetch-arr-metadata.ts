import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { mapRadarrMovie, mapSonarrSeries, mapLidarrArtist } from "@/lib/arr/metadata";
import { splitProgress, subProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

// How often (in items) the in-memory mapping loop reports sub-progress.
const MAP_PROGRESS_INTERVAL = 500;

export async function fetchArrMetadata(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  onProgress?: FractionReporter,
): Promise<ArrDataMap> {
  const arrData: ArrDataMap = {};

  if (type === "MOVIE") {
    const instances = await prisma.radarrInstance.findMany({
      where: { userId, enabled: true },
    });
    const reporters = splitProgress(onProgress, instances.length);
    for (let idx = 0; idx < instances.length; idx++) {
      const inst = instances[idx];
      const report = reporters[idx];
      const client = new RadarrClient(inst.url, inst.apiKey);
      const [movies, profiles, tags] = await Promise.all([
        client.getMovies(),
        client.getQualityProfiles(),
        client.getTags(),
      ]);
      report(0.1);
      const tagMap = new Map(tags.map((t) => [t.id, t.label]));
      const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
      // customFormatScore is only computed by Radarr's /moviefile endpoint,
      // never on the /movie listing — fetch it separately and merge it in.
      // This chunked sweep is the slow part, so it owns the bulk of the bar.
      const scores = await client.getCustomFormatScores(
        movies.filter((m) => m.hasFile).map((m) => m.id),
        subProgress(report, 0.1, 0.85),
      );
      const mapReport = subProgress(report, 0.85, 1);
      for (let i = 0; i < movies.length; i++) {
        const movie = movies[i];
        arrData[String(movie.tmdbId)] = mapRadarrMovie(
          movie, profileMap, tagMap, scores.get(movie.id) ?? null,
        );
        if (mapReport && (i + 1) % MAP_PROGRESS_INTERVAL === 0) {
          mapReport((i + 1) / movies.length);
        }
      }
      report(1);
    }
  } else if (type === "MUSIC") {
    const instances = await prisma.lidarrInstance.findMany({
      where: { userId, enabled: true },
    });
    const reporters = splitProgress(onProgress, instances.length);
    for (let idx = 0; idx < instances.length; idx++) {
      const inst = instances[idx];
      const report = reporters[idx];
      const client = new LidarrClient(inst.url, inst.apiKey);
      const [artists, profiles, tags] = await Promise.all([
        client.getArtists(),
        client.getQualityProfiles(),
        client.getTags(),
      ]);
      report(0.5);
      const tagMap = new Map(tags.map((t) => [t.id, t.label]));
      const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
      const mapReport = subProgress(report, 0.5, 1);
      for (let i = 0; i < artists.length; i++) {
        const a = artists[i];
        arrData[a.foreignArtistId] = mapLidarrArtist(a, profileMap, tagMap);
        if (mapReport && (i + 1) % MAP_PROGRESS_INTERVAL === 0) {
          mapReport((i + 1) / artists.length);
        }
      }
      report(1);
    }
  } else {
    const instances = await prisma.sonarrInstance.findMany({
      where: { userId, enabled: true },
    });
    const reporters = splitProgress(onProgress, instances.length);
    for (let idx = 0; idx < instances.length; idx++) {
      const inst = instances[idx];
      const report = reporters[idx];
      const client = new SonarrClient(inst.url, inst.apiKey);
      const [series, profiles, tags] = await Promise.all([
        client.getSeries(),
        client.getQualityProfiles(),
        client.getTags(),
      ]);
      report(0.5);
      const tagMap = new Map(tags.map((t) => [t.id, t.label]));
      const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
      const mapReport = subProgress(report, 0.5, 1);
      for (let i = 0; i < series.length; i++) {
        const s = series[i];
        arrData[String(s.tvdbId)] = mapSonarrSeries(s, profileMap, tagMap);
        if (mapReport && (i + 1) % MAP_PROGRESS_INTERVAL === 0) {
          mapReport((i + 1) / series.length);
        }
      }
      report(1);
    }
  }

  return arrData;
}
