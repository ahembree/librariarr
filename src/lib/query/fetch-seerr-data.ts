import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { splitProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { SeerrDataMap } from "@/lib/rules/lifecycle-engine";

/**
 * Fetch Seerr metadata for the query builder from a specific instance.
 * Returns a map keyed by media type: { MOVIE: SeerrDataMap, SERIES: SeerrDataMap }
 *
 * `onProgress` (optional) reports combined 0..1 completion across the per-type
 * request sweeps.
 */
export async function fetchSeerrDataForQuery(
  userId: string,
  seerrInstanceId: string,
  mediaTypes: string[],
  onProgress?: FractionReporter,
): Promise<Record<string, SeerrDataMap>> {
  const instance = await prisma.seerrInstance.findFirst({
    where: { id: seerrInstanceId, userId, enabled: true },
  });
  if (!instance) return {};

  const client = new SeerrClient(instance.url, instance.apiKey);
  const result: Record<string, SeerrDataMap> = {};

  const typesInScope = mediaTypes.length === 0
    ? ["MOVIE", "SERIES"]
    : mediaTypes.filter((t) => t === "MOVIE" || t === "SERIES");

  const reporters = splitProgress(onProgress, typesInScope.length);
  for (let idx = 0; idx < typesInScope.length; idx++) {
    const type = typesInScope[idx];
    const report = reporters[idx];
    const mediaType = type === "MOVIE" ? "movie" : "tv";
    const seerrData: SeerrDataMap = {};

    let skip = 0;
    const take = 100;
    let hasMore = true;
    let processed = 0;

    while (hasMore) {
      const response = await client.getRequests({ take, skip, mediaType });

      for (const req of response.results) {
        const keys: string[] = [];
        if (type === "MOVIE") {
          if (req.media.tmdbId != null) keys.push(`TMDB:${req.media.tmdbId}`);
        } else {
          if (req.media.tvdbId != null) keys.push(`TVDB:${req.media.tvdbId}`);
          if (req.media.tmdbId != null) keys.push(`TMDB:${req.media.tmdbId}`);
        }

        const username = req.requestedBy?.plexUsername || req.requestedBy?.username || req.requestedBy?.email || "Unknown";

        for (const key of keys) {
          const existing = seerrData[key];
          if (existing) {
            existing.requestCount += 1;
            if (!existing.requestedBy.includes(username)) {
              existing.requestedBy.push(username);
            }
            if (req.createdAt && (!existing.requestDate || req.createdAt < existing.requestDate)) {
              existing.requestDate = req.createdAt;
            }
            if (req.status === 2 && req.updatedAt) {
              if (!existing.approvalDate || req.updatedAt < existing.approvalDate) {
                existing.approvalDate = req.updatedAt;
              }
            }
            if (req.status === 3 && req.updatedAt) {
              if (!existing.declineDate || req.updatedAt < existing.declineDate) {
                existing.declineDate = req.updatedAt;
              }
            }
          } else {
            seerrData[key] = {
              requested: true,
              requestCount: 1,
              requestDate: req.createdAt || null,
              requestedBy: [username],
              approvalDate: req.status === 2 ? (req.updatedAt || null) : null,
              declineDate: req.status === 3 ? (req.updatedAt || null) : null,
            };
          }
        }
      }

      skip += take;
      processed += response.results.length;
      hasMore = response.results.length === take;
      const total = response.pageInfo?.results ?? processed;
      report(total > 0 ? Math.min(1, processed / total) : 1);
    }
    report(1);

    result[type] = seerrData;
  }

  return result;
}
