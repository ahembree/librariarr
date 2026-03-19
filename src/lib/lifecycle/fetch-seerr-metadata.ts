import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import type { SeerrDataMap } from "@/lib/rules/engine";

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

    while (hasMore) {
      const response = await client.getRequests({ take, skip, mediaType });

      for (const req of response.results) {
        // Key by TMDB ID for movies, TVDB ID (if available) or TMDB ID for series
        const keys: string[] = [];
        if (type === "MOVIE") {
          keys.push(String(req.media.tmdbId));
        } else {
          // For series, prefer TVDB ID since that's what Librariarr uses for series correlation
          if (req.media.tvdbId) {
            keys.push(String(req.media.tvdbId));
          }
          // Also key by TMDB ID as fallback
          keys.push(String(req.media.tmdbId));
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
