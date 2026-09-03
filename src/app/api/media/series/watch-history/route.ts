import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/** Page size bounds — mirrors /api/media/history so the two behave alike. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Per-play watch history scoped to one series (and optionally one season or a
 * single episode), for the watch-history section on the series/season/episode
 * detail pages.
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
 *
 * Dedup is deliberately NOT applied. A `WatchHistory` row is a real play event
 * recorded against the copy that was actually played; filtering to
 * `dedupCanonical` would silently drop every play that happened on a
 * non-canonical server. `/api/media/history` scopes the same way — by owner,
 * with an optional explicit `serverId` — and each row carries its server so a
 * multi-server library stays legible.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parentTitle = searchParams.get("parentTitle");
  if (!parentTitle) {
    return NextResponse.json({ error: "parentTitle is required" }, { status: 400 });
  }

  const serverId = searchParams.get("serverId");
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
  const rawLimit = parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT));
  // Floor at 1 and cap at MAX_LIMIT — a negative/zero limit produced LIMIT 0 or
  // a negative OFFSET (Postgres rejects a negative OFFSET → 500).
  const limit = Math.max(1, Math.min(Number.isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit, MAX_LIMIT));

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

  // Resolve the episodes in scope FIRST, keyed the same way the series listing
  // groups shows: `LOWER(TRIM(parentTitle))` (see /api/media/series/grouped).
  // Matching `parentTitle` exactly instead looks right on one server and
  // silently loses plays on a second: the library merges "Test Kingdom" and
  // "test kingdom " into one show, so a household member watching on the
  // server with the other spelling disappears from the show's history — the
  // very cross-server plays this route keeps by not applying dedup.
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
      AND mi."parentTitle" IS NOT NULL
      AND LOWER(TRIM(mi."parentTitle")) = LOWER(TRIM(${parentTitle}))
      AND (${seasonNumber}::int IS NULL OR mi."seasonNumber" = ${seasonNumber}::int)
      AND (${episodeNumber}::int IS NULL OR mi."episodeNumber" = ${episodeNumber}::int)
  `;

  if (scopedItems.length === 0) {
    return NextResponse.json({
      items: [],
      pagination: { page, limit, hasMore: false, totalCount: 0 },
    });
  }

  const where: Prisma.WatchHistoryWhereInput = {
    mediaItemId: { in: scopedItems.map((i) => i.id) },
    // Ownership guard: only history recorded on this user's servers.
    mediaServer: { userId: session.userId!, ...(serverId ? { id: serverId } : {}) },
  };

  const [rows, totalCount] = await Promise.all([
    prisma.watchHistory.findMany({
      where,
      // Newest play first. A unique tiebreaker after the user-visible sort keeps
      // the order total, so paging can't duplicate or drop rows in a tie block.
      orderBy: [{ watchedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: limit + 1,
      skip: (page - 1) * limit,
      select: {
        id: true,
        serverUsername: true,
        watchedAt: true,
        deviceName: true,
        platform: true,
        mediaItem: {
          select: {
            id: true,
            title: true,
            parentTitle: true,
            seasonNumber: true,
            episodeNumber: true,
          },
        },
        mediaServer: { select: { id: true, name: true, type: true } },
      },
    }),
    prisma.watchHistory.count({ where }),
  ]);

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  const items = rows.map((row) => ({
    id: row.id,
    serverUsername: row.serverUsername,
    watchedAt: row.watchedAt?.toISOString() ?? null,
    deviceName: row.deviceName,
    platform: row.platform,
    mediaItem: {
      id: row.mediaItem.id,
      title: row.mediaItem.title,
      parentTitle: row.mediaItem.parentTitle,
      seasonNumber: row.mediaItem.seasonNumber,
      episodeNumber: row.mediaItem.episodeNumber,
    },
    server: {
      id: row.mediaServer.id,
      name: row.mediaServer.name,
      type: row.mediaServer.type,
    },
  }));

  return NextResponse.json({
    items,
    pagination: { page, limit, hasMore, totalCount },
  });
}
