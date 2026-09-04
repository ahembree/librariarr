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
 * A row's `source` says where it came from: `NATIVE` (the media-server scan,
 * which knows only who/when/what) or `TRACEARR` (an imported play event, which
 * additionally carries completion, transcode decisions and the full stream
 * fidelity). Every Tracearr column is nullable and null on a native row, so
 * this route returns them unconditionally and the card renders each only when
 * present. A `watched: false` row is returned like any other — this is display
 * data, and a partial play is a real play; only the watch-state reconcile
 * (`src/lib/sync/watch-reconcile.ts`) cares about the completion threshold.
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
  // `seriesKey` (series identity) is preferred; `parentTitle` is still accepted
  // for backward compatibility but is ambiguous across same-titled shows.
  const seriesKey = searchParams.get("seriesKey");
  const parentTitle = searchParams.get("parentTitle");
  if (!seriesKey && !parentTitle) {
    return NextResponse.json({ error: "seriesKey or parentTitle is required" }, { status: 400 });
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
        // Provenance + the rich per-play detail a Tracearr-sourced row carries.
        // Every one of these is nullable, and all of them are null on a NATIVE
        // row (a media-server scan only knows who/when/what), so the card
        // renders each only when present rather than as empty placeholders.
        source: true,
        sourceEventId: true,
        referenceId: true,
        watched: true,
        percentComplete: true,
        state: true,
        progressMs: true,
        durationMs: true,
        totalDurationMs: true,
        segmentCount: true,
        stoppedAt: true,
        player: true,
        product: true,
        isTranscode: true,
        videoDecision: true,
        audioDecision: true,
        bitrate: true,
        resolution: true,
        sourceVideoCodec: true,
        sourceAudioCodec: true,
        streamVideoCodec: true,
        streamAudioCodec: true,
        transcodeInfo: true,
        subtitleInfo: true,
        streamQuality: true,
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
    source: row.source,
    sourceEventId: row.sourceEventId,
    referenceId: row.referenceId,
    watched: row.watched,
    percentComplete: row.percentComplete,
    state: row.state,
    progressMs: row.progressMs,
    durationMs: row.durationMs,
    totalDurationMs: row.totalDurationMs,
    segmentCount: row.segmentCount,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    player: row.player,
    product: row.product,
    isTranscode: row.isTranscode,
    videoDecision: row.videoDecision,
    audioDecision: row.audioDecision,
    bitrate: row.bitrate,
    resolution: row.resolution,
    sourceVideoCodec: row.sourceVideoCodec,
    sourceAudioCodec: row.sourceAudioCodec,
    streamVideoCodec: row.streamVideoCodec,
    streamAudioCodec: row.streamAudioCodec,
    // Passed through verbatim. These are `Prisma.JsonValue`s — Tracearr's own
    // nested objects, stored as-is so the UI gets the full stream fidelity
    // without a scalar column per field. The card reads them structurally;
    // nothing here reshapes or validates them.
    transcodeInfo: row.transcodeInfo,
    subtitleInfo: row.subtitleInfo,
    streamQuality: row.streamQuality,
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
