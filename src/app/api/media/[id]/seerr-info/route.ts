import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SeerrClient, type SeerrMediaInfo, type SeerrRequest } from "@/lib/seerr/seerr-client";
import { walkSeerrRequests } from "@/lib/seerr/request-walk";
import { seerrRequesterName } from "@/lib/seerr/seerr-data-map";
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

function toSummary(req: SeerrRequest): SeerrRequestSummary {
  return {
    id: req.id,
    status: req.status,
    is4k: req.is4k,
    requestedBy: seerrRequesterName(req),
    createdAt: req.createdAt,
    updatedAt: req.updatedAt,
  };
}

/**
 * Paginated fallback used when no TMDB ID is available (rare: series with only TVDB).
 * Walks the instance's whole request list (bounded, shift-tolerant — see
 * `walkSeerrRequests`), filtering by external IDs.
 */
async function findRequestsByPagination(
  client: SeerrClient,
  instanceName: string,
  tmdbId: string | null,
  tvdbId: string,
): Promise<{ requests: SeerrRequest[]; media: SeerrMediaInfo | null }> {
  const matching: SeerrRequest[] = [];
  let media: SeerrMediaInfo | null = null;

  await walkSeerrRequests(client, { instanceName, mediaType: "tv" }, (req) => {
    const tmdbMatch = tmdbId !== null && String(req.media?.tmdbId) === tmdbId;
    const tvdbMatch = req.media?.tvdbId != null && String(req.media.tvdbId) === tvdbId;
    if (tmdbMatch || tvdbMatch) {
      matching.push(req);
      if (media === null && req.media) media = req.media;
    }
  });

  return { requests: matching, media };
}

/**
 * The media status the card shows. Seerr tracks the 4K copy separately
 * (`status4k`); when every request is a 4K one, the non-4K `status` describes
 * a copy nobody asked for (typically still UNKNOWN), so report the 4K copy's.
 */
function pickMediaStatus(media: SeerrMediaInfo | null | undefined, requests: SeerrRequest[]): number | null {
  if (!media) return null;
  const only4k = requests.length > 0 && requests.every((r) => r.is4k);
  return (only4k ? media.status4k ?? media.status : media.status) ?? null;
}

// Each instance is a live call (15s client timeout, plus retries). Query them
// in parallel and give up on one that takes longer than this rather than
// holding the detail page's Integrations section — Arr cards included — for
// the slowest instance. The TVDB-only fallback walks a whole request list, so
// the bound is looser than the health check's 5s.
const PER_INSTANCE_TIMEOUT_MS = 10_000;

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
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const queryInstance = async (instance: (typeof seerrInstances)[number]): Promise<SeerrMatch | null> => {
    try {
      const client = new SeerrClient(instance.url, instance.apiKey);

      let requests: SeerrRequest[] = [];
      let media: SeerrMediaInfo | null = null;

      // Fast path: per-media endpoint returns all associated requests in one call.
      // Both /movie/{id} and /tv/{id} are TMDB-based, so we need a TMDB ID to use it.
      if (tmdbId) {
        const tmdbNum = Number(tmdbId);
        if (Number.isFinite(tmdbNum)) {
          const details = mediaType === "movie"
            ? await client.getMovie(tmdbNum)
            : await client.getTvShow(tmdbNum);
          requests = details.mediaInfo?.requests ?? [];
          media = details.mediaInfo ?? null;
        }
      }

      // Fallback: TVDB-only series — walk /request to find matches. Series
      // only: a movie request can be matched by TMDB id alone, so for a movie
      // without one the walk could never find anything.
      if (requests.length === 0 && !tmdbId && tvdbId && mediaType === "tv") {
        const result = await findRequestsByPagination(client, instance.name, tmdbId, tvdbId);
        requests = result.requests;
        media = result.media;
      }

      if (requests.length === 0) return null;

      const baseUrl = (instance.url || "").replace(/\/+$/, "");
      const seerrUrl = tmdbId ? `${baseUrl}/${mediaType}/${tmdbId}` : null;

      return {
        instanceId: instance.id,
        instanceName: instance.name,
        matchedVia,
        externalId,
        seerrUrl,
        mediaStatus: pickMediaStatus(media, requests),
        requests: requests.map(toSummary),
      };
    } catch (error) {
      apiLogger.error("Media", `Failed to query Seerr instance ${instance.name}`, { error: String(error) });
      return null;
    }
  };

  const settled = await Promise.all(
    seerrInstances.map((instance) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          apiLogger.warn("Media", `Seerr instance ${instance.name} did not answer within ${PER_INSTANCE_TIMEOUT_MS / 1000}s`);
          resolve(null);
        }, PER_INSTANCE_TIMEOUT_MS);
      });
      return Promise.race([queryInstance(instance), timeout]).finally(() => clearTimeout(timer));
    }),
  );
  const matches = settled.filter((m): m is SeerrMatch => m !== null);

  return NextResponse.json({ matches });
}
