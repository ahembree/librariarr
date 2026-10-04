import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { mapRadarrMovie, mapSonarrSeries, mapLidarrArtist } from "@/lib/arr/metadata";
import { splitProgress, subProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

// How often (in items) the in-memory mapping loop reports sub-progress.
const MAP_PROGRESS_INTERVAL = 500;

/** Human label for the Arr family that serves a library type. */
export function arrFamilyLabel(type: "MOVIE" | "SERIES" | "MUSIC"): string {
  return type === "MOVIE" ? "Radarr" : type === "MUSIC" ? "Lidarr" : "Sonarr";
}

/**
 * The one Arr instance a rule set's Arr criteria are read from.
 *
 * A rule set's action runs against `RuleSet.arrInstanceId`, so its criteria
 * must be judged on that same instance's records. Merged across every
 * instance, a movie present on two Radarrs (a 1080p and a 4K one is the common
 * setup) was judged on whichever instance happened to be read last: a `keep`
 * tag on the 4K copy could be replaced by the 1080p copy's tags, the rule set
 * matched, and its DELETE ran against the 4K instance.
 *
 * Returns the instance when `arrInstanceId` names one of this family that the
 * user owns; `null` otherwise (no instance chosen, or an id from another
 * family — those rule sets keep reading every enabled instance).
 */
export async function resolveArrInstanceScope(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  arrInstanceId?: string | null,
): Promise<{ id: string; name: string; enabled: boolean } | null> {
  if (!arrInstanceId) return null;
  const where = { id: arrInstanceId, userId };
  const select = { id: true, name: true, enabled: true } as const;
  if (type === "MOVIE") return prisma.radarrInstance.findFirst({ where, select });
  if (type === "MUSIC") return prisma.lidarrInstance.findFirst({ where, select });
  return prisma.sonarrInstance.findFirst({ where, select });
}

/**
 * Whether at least one ENABLED Arr instance of the family serving `type`
 * exists — or, when `arrInstanceId` names an instance of that family, whether
 * THAT instance is enabled (see `resolveArrInstanceScope`). Rule sets that
 * reference Arr fields must be skipped when this is false: `fetchArrMetadata`
 * would return an empty map, and Phase 2 then
 * evaluates every item with `meta === undefined` — which makes
 * `foundInArr equals false` (the common "not managed by Radarr" rule)
 * vacuously true for the ENTIRE library. With a destructive action attached,
 * one detection cycle while an instance is disabled floods RuleMatch and
 * schedules deletes for everything; re-enabling the instance before the next
 * detection would then let those actions execute. "No instance" must read as
 * "Arr data unavailable" (skip, like a fetch failure), never as "nothing is
 * in Arr".
 */
export async function hasEnabledArrInstances(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  arrInstanceId?: string | null,
): Promise<boolean> {
  const scoped = await resolveArrInstanceScope(userId, type, arrInstanceId);
  if (scoped) return scoped.enabled;
  if (type === "MOVIE") {
    return (await prisma.radarrInstance.count({ where: { userId, enabled: true } })) > 0;
  }
  if (type === "MUSIC") {
    return (await prisma.lidarrInstance.count({ where: { userId, enabled: true } })) > 0;
  }
  return (await prisma.sonarrInstance.count({ where: { userId, enabled: true } })) > 0;
}

/**
 * Arr metadata keyed by the family's external id. With `arrInstanceId` naming
 * an instance of the family, only that instance is read (see
 * `resolveArrInstanceScope`); otherwise every enabled instance is, oldest
 * first, and an item on several keeps the OLDEST instance's record — a fixed
 * order, where the unordered query let the answer change from run to run.
 */
export async function fetchArrMetadata(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  onProgress?: FractionReporter,
  arrInstanceId?: string | null,
): Promise<ArrDataMap> {
  const arrData: ArrDataMap = {};
  const scoped = await resolveArrInstanceScope(userId, type, arrInstanceId);
  const instanceWhere = scoped
    ? { id: scoped.id, userId, enabled: true }
    : { userId, enabled: true };
  const instanceOrder = { createdAt: "asc" } as const;
  const put = (key: string, meta: ArrDataMap[string]) => {
    if (!(key in arrData)) arrData[key] = meta;
  };

  if (type === "MOVIE") {
    const instances = await prisma.radarrInstance.findMany({
      where: instanceWhere,
      orderBy: instanceOrder,
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
        put(String(movie.tmdbId), mapRadarrMovie(
          movie, profileMap, tagMap, scores.get(movie.id) ?? null,
        ));
        if (mapReport && (i + 1) % MAP_PROGRESS_INTERVAL === 0) {
          mapReport((i + 1) / movies.length);
        }
      }
      report(1);
    }
  } else if (type === "MUSIC") {
    const instances = await prisma.lidarrInstance.findMany({
      where: instanceWhere,
      orderBy: instanceOrder,
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
        put(a.foreignArtistId, mapLidarrArtist(a, profileMap, tagMap));
        if (mapReport && (i + 1) % MAP_PROGRESS_INTERVAL === 0) {
          mapReport((i + 1) / artists.length);
        }
      }
      report(1);
    }
  } else {
    const instances = await prisma.sonarrInstance.findMany({
      where: instanceWhere,
      orderBy: instanceOrder,
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
        put(String(s.tvdbId), mapSonarrSeries(s, profileMap, tagMap));
        if (mapReport && (i + 1) % MAP_PROGRESS_INTERVAL === 0) {
          mapReport((i + 1) / series.length);
        }
      }
      report(1);
    }
  }

  return arrData;
}
