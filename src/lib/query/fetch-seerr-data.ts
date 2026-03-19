import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import type { SeerrDataMap } from "@/lib/rules/engine";

/**
 * Fetch Seerr metadata for the query builder from a specific instance.
 * Returns a map keyed by media type: { MOVIE: SeerrDataMap, SERIES: SeerrDataMap }
 */
export async function fetchSeerrDataForQuery(
  userId: string,
  seerrInstanceId: string,
  mediaTypes: string[],
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

  for (const type of typesInScope) {
    const mediaType = type === "MOVIE" ? "movie" : "tv";
    const seerrData: SeerrDataMap = {};

    let skip = 0;
    const take = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await client.getRequests({ take, skip, mediaType });

      for (const req of response.results) {
        const keys: string[] = [];
        if (type === "MOVIE") {
          keys.push(String(req.media.tmdbId));
        } else {
          if (req.media.tvdbId) {
            keys.push(String(req.media.tvdbId));
          }
          keys.push(String(req.media.tmdbId));
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
      hasMore = response.results.length === take;
    }

    result[type] = seerrData;
  }

  return result;
}
