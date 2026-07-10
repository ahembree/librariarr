import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { logger } from "@/lib/logger";
import { splitProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { SeerrDataMap } from "@/lib/rules/lifecycle-engine";

// Hard ceiling on Seerr request pagination so a huge or looping instance can't
// hang lifecycle processing indefinitely. 1000 pages × 100 per page = 100k requests.
const MAX_PAGES = 1000;

/**
 * Whether at least one ENABLED Seerr instance exists. Rule sets that reference
 * Seerr fields must be skipped when this is false: `fetchSeerrMetadata` would
 * return an empty map, and the Phase 2 evaluator substitutes a default
 * "never requested" record for missing entries — making rules like
 * `seerrRequested equals false` vacuously true for the ENTIRE library.
 * "No instance" must read as "Seerr data unavailable", never as "nothing was
 * ever requested".
 */
export async function hasEnabledSeerrInstances(userId: string): Promise<boolean> {
  return (await prisma.seerrInstance.count({ where: { userId, enabled: true } })) > 0;
}

export async function fetchSeerrMetadata(
  userId: string,
  type: "MOVIE" | "SERIES",
  onProgress?: FractionReporter,
): Promise<SeerrDataMap> {
  const seerrData: SeerrDataMap = {};

  const instances = await prisma.seerrInstance.findMany({
    where: { userId, enabled: true },
  });

  const reporters = splitProgress(onProgress, instances.length);
  for (let idx = 0; idx < instances.length; idx++) {
    const inst = instances[idx];
    const report = reporters[idx];
    const client = new SeerrClient(inst.url, inst.apiKey);
    const mediaType = type === "MOVIE" ? "movie" : "tv";

    // Fetch all requests for this media type (paginate through all)
    let skip = 0;
    const take = 100;
    let hasMore = true;
    let pages = 0;
    let processed = 0;

    while (hasMore) {
      if (pages >= MAX_PAGES) {
        logger.warn(
          "Seerr",
          `Request pagination hit MAX_PAGES (${MAX_PAGES}) for ${inst.name} (${mediaType}) — truncating`
        );
        break;
      }
      const response = await client.getRequests({ take, skip, mediaType });
      pages += 1;

      for (const req of response.results) {
        // Namespace keys with source prefix so TMDB and TVDB IDs can't collide in the same map
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
            // Merge with existing metadata
            existing.requestCount += 1;
            if (!existing.requestedBy.includes(username)) {
              existing.requestedBy.push(username);
            }
            // Use earliest request date
            if (req.createdAt && (!existing.requestDate || req.createdAt < existing.requestDate)) {
              existing.requestDate = req.createdAt;
            }
            // Use earliest approval date
            if (req.status === 2 && req.updatedAt) {
              if (!existing.approvalDate || req.updatedAt < existing.approvalDate) {
                existing.approvalDate = req.updatedAt;
              }
            }
            // Use earliest decline date
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
      // pageInfo.results is the total across all pages; use it to report a
      // determinate fraction (fall back to "done" when nothing to fetch).
      const total = response.pageInfo?.results ?? processed;
      report(total > 0 ? Math.min(1, processed / total) : 1);
    }
    report(1);
  }

  return seerrData;
}
