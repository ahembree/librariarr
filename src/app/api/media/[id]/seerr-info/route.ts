import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SeerrClient, type SeerrRequest } from "@/lib/seerr/seerr-client";
import { apiLogger } from "@/lib/logger";

interface SeerrRequestSummary {
  id: number;
  status: number;
  is4k: boolean;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface SeerrMatch {
  instanceId: string;
  instanceName: string;
  matchedVia: "TMDB" | "TVDB";
  externalId: string;
  seerrUrl: string | null;
  mediaStatus: number | null;
  requests: SeerrRequestSummary[];
}

interface SeerrInfoResponse {
  matches: SeerrMatch[];
}

const REQUEST_PAGE_SIZE = 100;

function summarizeRequester(req: SeerrRequest): string {
  return req.requestedBy?.plexUsername || req.requestedBy?.username || req.requestedBy?.email || "Unknown";
}

function toSummary(req: SeerrRequest): SeerrRequestSummary {
  return {
    id: req.id,
    status: req.status,
    is4k: req.is4k,
    requestedBy: summarizeRequester(req),
    createdAt: req.createdAt,
    updatedAt: req.updatedAt,
  };
}

/**
 * Paginated fallback used when no TMDB ID is available (rare: series with only TVDB).
 * Walks /api/v1/request in pages of 100 until exhausted, filtering by external IDs.
 */
async function findRequestsByPagination(
  client: SeerrClient,
  mediaType: "movie" | "tv",
  tmdbId: string | null,
  tvdbId: string | null,
): Promise<{ requests: SeerrRequest[]; mediaStatus: number | null }> {
  const matching: SeerrRequest[] = [];
  let mediaStatus: number | null = null;
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await client.getRequests({ take: REQUEST_PAGE_SIZE, skip, mediaType });
    for (const req of response.results) {
      const tmdbMatch = tmdbId !== null && String(req.media.tmdbId) === tmdbId;
      const tvdbMatch =
        mediaType === "tv" && tvdbId !== null && req.media.tvdbId !== null && String(req.media.tvdbId) === tvdbId;
      if (tmdbMatch || tvdbMatch) {
        matching.push(req);
        if (mediaStatus === null && req.media?.status != null) mediaStatus = req.media.status;
      }
    }
    hasMore = response.results.length === REQUEST_PAGE_SIZE;
    skip += REQUEST_PAGE_SIZE;
  }

  return { requests: matching, mediaStatus };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const item = await prisma.mediaItem.findUnique({
    where: { id },
    include: {
      externalIds: true,
      library: { include: { mediaServer: true } },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!item.library.mediaServer || item.library.mediaServer.userId !== session.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const empty: SeerrInfoResponse = { matches: [] };

  if (item.type === "MUSIC") {
    return NextResponse.json(empty);
  }

  const tmdbId = item.externalIds.find((e) => e.source === "TMDB")?.externalId ?? null;
  const tvdbId = item.externalIds.find((e) => e.source === "TVDB")?.externalId ?? null;

  if (!tmdbId && !tvdbId) {
    return NextResponse.json(empty);
  }

  const mediaType: "movie" | "tv" = item.type === "MOVIE" ? "movie" : "tv";
  const matchedVia: "TMDB" | "TVDB" = item.type === "MOVIE" ? "TMDB" : tvdbId ? "TVDB" : "TMDB";
  const externalId = item.type === "MOVIE" ? tmdbId! : (tvdbId ?? tmdbId)!;

  const seerrInstances = await prisma.seerrInstance.findMany({
    where: { userId: session.userId!, enabled: true },
  });

  const matches: SeerrMatch[] = [];

  for (const instance of seerrInstances) {
    try {
      const client = new SeerrClient(instance.url, instance.apiKey);

      let requests: SeerrRequest[] = [];
      let mediaStatus: number | null = null;

      // Fast path: per-media endpoint returns all associated requests in one call.
      // Both /movie/{id} and /tv/{id} are TMDB-based, so we need a TMDB ID to use it.
      if (tmdbId) {
        const tmdbNum = Number(tmdbId);
        if (Number.isFinite(tmdbNum)) {
          const details = mediaType === "movie"
            ? await client.getMovie(tmdbNum)
            : await client.getTvShow(tmdbNum);
          requests = details.mediaInfo?.requests ?? [];
          mediaStatus = details.mediaInfo?.status ?? null;
        }
      }

      // Fallback: TVDB-only series — walk /request to find matches.
      if (requests.length === 0 && !tmdbId && tvdbId) {
        const result = await findRequestsByPagination(client, mediaType, tmdbId, tvdbId);
        requests = result.requests;
        mediaStatus = result.mediaStatus;
      }

      if (requests.length === 0) continue;

      const baseUrl = (instance.url || "").replace(/\/+$/, "");
      const seerrUrl = tmdbId ? `${baseUrl}/${mediaType}/${tmdbId}` : null;

      matches.push({
        instanceId: instance.id,
        instanceName: instance.name,
        matchedVia,
        externalId,
        seerrUrl,
        mediaStatus,
        requests: requests.map(toSummary),
      });
    } catch (error) {
      apiLogger.error("Media", `Failed to query Seerr instance ${instance.name}`, { error: String(error) });
    }
  }

  return NextResponse.json({ matches });
}
