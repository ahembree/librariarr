import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { isUnreachable } from "@/lib/media-server/health-cache";

interface SeriesSummary {
  summary: string | null;
  genres: unknown;
  studio: string | null;
  contentRating: string | null;
  year: number | null;
}

/**
 * A show's metadata is the same for every episode page of it, so it is kept
 * per server and show key. Under the `group-summary:` prefix on purpose: it is
 * a show-level summary, and `invalidateMediaCaches()` drops that prefix after
 * every sync, which is when the show's metadata can have changed.
 */
const SHOW_SUMMARY_TTL_MS = 5 * 60_000;
const showSummaryKey = (serverId: string, showRatingKey: string) =>
  `group-summary:series-summary:${serverId}:${showRatingKey}`;

export const GET = withSession(async (
  session,
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const item = await prisma.mediaItem.findUnique({
    where: { id },
    select: {
      ratingKey: true,
      grandparentRatingKey: true,
      summary: true,
      genres: true,
      studio: true,
      contentRating: true,
      year: true,
      library: {
        select: {
          mediaServer: {
            select: { id: true, userId: true, type: true, url: true, accessToken: true, tlsSkipVerify: true },
          },
        },
      },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!item.library.mediaServer) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  if (item.library.mediaServer.userId !== session.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const server = item.library.mediaServer;
  const episodeFallback: SeriesSummary = {
    summary: item.summary,
    genres: item.genres ?? [],
    studio: item.studio,
    contentRating: item.contentRating,
    year: item.year,
  };

  // Skip the live fetch when the breaker is open — the page renders fine with
  // episode-level fallback data.
  if (isUnreachable(server.url)) {
    return NextResponse.json(episodeFallback);
  }

  try {
    const client = createMediaServerClient(server.type, server.url, server.accessToken, {
      skipTlsVerify: server.tlsSkipVerify,
    });

    // The show's key is stored on every episode the sync wrote; the episode's
    // own metadata was fetched only to read it back. That lookup stays for a
    // row stored without one.
    const showRatingKey =
      item.grandparentRatingKey ?? (await client.getItemMetadata(item.ratingKey)).grandparentRatingKey;

    if (!showRatingKey) {
      // Fall back to episode-level data if no grandparent
      return NextResponse.json(episodeFallback);
    }

    const summary = await appCache.getOrSet<SeriesSummary>(
      showSummaryKey(server.id, showRatingKey),
      async () => {
        const showMetadata = await client.getItemMetadata(showRatingKey);
        return {
          summary: showMetadata.summary ?? null,
          genres: showMetadata.Genre?.map((g) => g.tag) ?? [],
          studio: showMetadata.studio ?? null,
          contentRating: showMetadata.contentRating ?? null,
          year: showMetadata.year ?? null,
        };
      },
      SHOW_SUMMARY_TTL_MS,
    );
    return NextResponse.json(summary);
  } catch {
    // Fall back to episode-level data on error (never cached: a failed
    // lookup throws out of `getOrSet` before anything is stored).
    return NextResponse.json(episodeFallback);
  }
});
