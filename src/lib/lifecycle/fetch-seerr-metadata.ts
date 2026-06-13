import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { logger } from "@/lib/logger";
import type { SeerrDataMap } from "@/lib/rules/lifecycle-engine";

// Hard ceiling on Seerr request pagination so a huge or looping instance can't
// hang lifecycle processing indefinitely. 1000 pages × 100 per page = 100k requests.
const MAX_PAGES = 1000;

export async function fetchSeerrMetadata(
  userId: string,
  type: "MOVIE" | "SERIES"
): Promise<SeerrDataMap> {
  const seerrData: SeerrDataMap = {};

  const instances = await prisma.seerrInstance.findMany({
    where: { userId, enabled: true },
  });

  for (const inst of instances) {
    const client = new SeerrClient(inst.url, inst.apiKey);
    const mediaType = type === "MOVIE" ? "movie" : "tv";

    // Fetch all requests for this media type (paginate through all)
    let skip = 0;
    const take = 100;
    let hasMore = true;
    let pages = 0;

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
      hasMore = response.results.length === take;
    }
  }

  return seerrData;
}
