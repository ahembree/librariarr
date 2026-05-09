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

function pickHighestMediaStatus(requests: SeerrRequest[]): number | null {
  // SeerrMediaInfo.status: 1=UNKNOWN, 2=PENDING, 3=PROCESSING, 4=PARTIAL, 5=AVAILABLE, 6=DELETED
  // The same media object is referenced by every request for that item, so any req.media.status will do.
  return requests[0]?.media?.status ?? null;
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

  // Seerr does not handle music
  if (item.type === "MUSIC") {
    return NextResponse.json(empty);
  }

  const tmdbId = item.externalIds.find((e) => e.source === "TMDB")?.externalId ?? null;
  const tvdbId = item.externalIds.find((e) => e.source === "TVDB")?.externalId ?? null;

  if (!tmdbId && !tvdbId) {
    return NextResponse.json(empty);
  }

  const mediaType = item.type === "MOVIE" ? "movie" : "tv";

  const matchedVia: "TMDB" | "TVDB" = item.type === "MOVIE" ? "TMDB" : tvdbId ? "TVDB" : "TMDB";
  const externalId = item.type === "MOVIE" ? tmdbId! : (tvdbId ?? tmdbId)!;

  const seerrInstances = await prisma.seerrInstance.findMany({
    where: { userId: session.userId!, enabled: true },
  });

  const matches: SeerrMatch[] = [];

  for (const instance of seerrInstances) {
    try {
      const client = new SeerrClient(instance.url, instance.apiKey);
      const response = await client.getRequests({ take: REQUEST_PAGE_SIZE, mediaType });

      const matching = response.results.filter((req) => {
        if (item.type === "MOVIE") {
          return tmdbId !== null && String(req.media.tmdbId) === tmdbId;
        }
        // SERIES: prefer TVDB, fall back to TMDB
        if (tvdbId && req.media.tvdbId !== null && String(req.media.tvdbId) === tvdbId) return true;
        if (tmdbId && String(req.media.tmdbId) === tmdbId) return true;
        return false;
      });

      if (matching.length === 0) continue;

      const baseUrl = (instance.url || "").replace(/\/+$/, "");
      const seerrUrl = tmdbId ? `${baseUrl}/${mediaType}/${tmdbId}` : null;

      matches.push({
        instanceId: instance.id,
        instanceName: instance.name,
        matchedVia,
        externalId,
        seerrUrl,
        mediaStatus: pickHighestMediaStatus(matching),
        requests: matching.map((req) => ({
          id: req.id,
          status: req.status,
          is4k: req.is4k,
          requestedBy: summarizeRequester(req),
          createdAt: req.createdAt,
          updatedAt: req.updatedAt,
        })),
      });
    } catch (error) {
      apiLogger.error("Media", `Failed to query Seerr instance ${instance.name}`, { error: String(error) });
    }
  }

  return NextResponse.json({ matches });
}
