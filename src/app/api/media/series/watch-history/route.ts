import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { fetchPlayHistory, parsePlayHistoryPaging } from "@/lib/media/play-history";

/**
 * Per-play watch history scoped to one series (and optionally one season or a
 * single episode), for the watch-history section on the series/season/episode
 * detail pages.
 *
 * This route owns only the SCOPE RESOLUTION — which episodes belong to the
 * series being asked about. The row shape, ordering, paging and ownership
 * guard live in `src/lib/media/play-history.ts`, shared with the item-scoped
 * route that backs movies and tracks, so the two cannot drift into showing
 * different detail for the same underlying rows.
 *
 * Reads the stored `WatchHistory` table rather than the live server, because
 * this view needs the individual play events (who / when / which episode).
 * `/api/media/[id]/history` deliberately answers a different question — a
 * per-user aggregate for ONE item, fetched live — so it can't be reused here.
 *
 * Every user's plays are included. `WatchHistory` is populated from the
 * server-wide, per-user `getDetailedWatchHistory()` (Plex's
 * `/status/sessions/history/all` resolved through its account map;
 * Jellyfin/Emby's per-user `/Users/{id}/Items`), and nothing here filters on
 * `serverUsername` — `session.userId` is the Librariarr admin who owns the
 * server record, not a media-server account.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // `seriesKey` (series identity) is preferred; `parentTitle` is still accepted
  // for backward compatibility but is ambiguous across same-titled shows.
  const seriesKey = searchParams.get("seriesKey");
  const parentTitle = searchParams.get("parentTitle");
  if (!seriesKey && !parentTitle) {
    return NextResponse.json({ error: "seriesKey or parentTitle is required" }, { status: 400 });
  }

  const { page, limit, serverId } = parsePlayHistoryPaging(searchParams);

  // A season/episode number of 0 is real (Specials, and some servers number a
  // pilot as episode 0), so parse explicitly rather than leaning on falsiness.
  const rawSeason = searchParams.get("seasonNumber");
  const seasonNumber = rawSeason != null && rawSeason !== "" ? parseInt(rawSeason) : null;
  if (seasonNumber != null && Number.isNaN(seasonNumber)) {
    return NextResponse.json({ error: "seasonNumber must be a number" }, { status: 400 });
  }
  const rawEpisode = searchParams.get("episodeNumber");
  const episodeNumber = rawEpisode != null && rawEpisode !== "" ? parseInt(rawEpisode) : null;
  if (episodeNumber != null && Number.isNaN(episodeNumber)) {
    return NextResponse.json({ error: "episodeNumber must be a number" }, { status: 400 });
  }

  // Resolve the episodes in scope FIRST, keyed by series identity (`seriesKey`
  // — the same key /api/media/series/grouped groups shows on). This keeps the
  // two properties that matter here: two different shows sharing a title stay
  // separate (distinct seriesKey), and the SAME show on two servers still
  // merges — its episodes share a TVDB-derived seriesKey, so a household member
  // watching on either server contributes to the show's history. That
  // cross-server merge is exactly what this route must preserve (it doesn't
  // apply dedup). The legacy `parentTitle` param falls back to the old
  // case/space-insensitive title match.
  //
  // Filtering by the resolved ids also lets the history query use
  // WatchHistory(mediaItemId) instead of joining and filtering MediaItem.
  const scopedItems = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT mi."id"
    FROM "MediaItem" mi
    JOIN "Library" l ON l."id" = mi."libraryId"
    JOIN "MediaServer" ms ON ms."id" = l."mediaServerId"
    WHERE ms."userId" = ${session.userId!}
      AND mi."type" = 'SERIES'::"LibraryType"
      AND (
        (${seriesKey}::text IS NOT NULL AND mi."seriesKey" = ${seriesKey}::text)
        OR (${seriesKey}::text IS NULL AND mi."parentTitle" IS NOT NULL
            AND LOWER(TRIM(mi."parentTitle")) = LOWER(TRIM(${parentTitle}::text)))
      )
      AND (${seasonNumber}::int IS NULL OR mi."seasonNumber" = ${seasonNumber}::int)
      AND (${episodeNumber}::int IS NULL OR mi."episodeNumber" = ${episodeNumber}::int)
  `;

  return NextResponse.json(
    await fetchPlayHistory({
      userId: session.userId!,
      mediaItemIds: scopedItems.map((i) => i.id),
      serverId,
      page,
      limit,
    }),
  );
}
