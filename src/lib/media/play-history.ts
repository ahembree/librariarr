import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The shared shape of a per-play watch-history row — the `select` and the
 * serializer, used by every route that returns individual play events.
 *
 * Two routes do: the series-scoped one (a show, season or single episode) and
 * the item-scoped one (a movie, a track, or any single item). They differ only
 * in how they resolve WHICH `MediaItem`s are in scope; what a play looks like
 * once resolved is identical, and had to stop being written twice — a column
 * added to one and not the other shows the enriched detail on series pages and
 * silently omits it on movies.
 *
 * Not to be confused with `/api/media/[id]/history`, which answers a different
 * question: a per-user AGGREGATE for one item (username, play count, last
 * played), fetched live from the media server, with no per-play timestamps and
 * none of the Tracearr detail. It is the older view and cannot be reused here.
 */

/** Page size bounds — mirrors /api/media/history so every play list behaves alike. */
export const DEFAULT_PLAY_LIMIT = 50;
export const MAX_PLAY_LIMIT = 200;

/**
 * Every column a play row exposes.
 *
 * A row's `source` says where it came from: `NATIVE` (the media-server scan,
 * which knows only who/when/what) or `TRACEARR` (an imported play event, which
 * additionally carries completion, transcode decisions and full stream
 * fidelity). Every Tracearr column is nullable and null on a native row, so
 * they are selected unconditionally and the UI renders each only when present
 * rather than as empty placeholders.
 */
export const PLAY_HISTORY_SELECT = {
  id: true,
  serverUsername: true,
  watchedAt: true,
  deviceName: true,
  platform: true,
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
      type: true,
      parentTitle: true,
      seasonNumber: true,
      episodeNumber: true,
    },
  },
  mediaServer: { select: { id: true, name: true, type: true } },
} satisfies Prisma.WatchHistorySelect;

type PlayRow = Prisma.WatchHistoryGetPayload<{ select: typeof PLAY_HISTORY_SELECT }>;

/** Serialize one play row for the wire (Dates → ISO, relations flattened). */
export function serializePlayRow(row: PlayRow) {
  return {
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
    // without a scalar column per field. The UI reads them structurally;
    // nothing here reshapes or validates them.
    transcodeInfo: row.transcodeInfo,
    subtitleInfo: row.subtitleInfo,
    streamQuality: row.streamQuality,
    mediaItem: {
      id: row.mediaItem.id,
      title: row.mediaItem.title,
      type: row.mediaItem.type,
      parentTitle: row.mediaItem.parentTitle,
      seasonNumber: row.mediaItem.seasonNumber,
      episodeNumber: row.mediaItem.episodeNumber,
    },
    server: {
      id: row.mediaServer.id,
      name: row.mediaServer.name,
      type: row.mediaServer.type,
    },
  };
}

/**
 * Fetch one page of plays for an already-resolved set of media items.
 *
 * Callers resolve scope themselves — the series route by series identity, the
 * item route by id — and both must have applied their own ownership guard to
 * that resolution. The `mediaServer` filter below re-applies ownership anyway,
 * so a caller that resolved ids loosely still cannot read another owner's
 * plays.
 *
 * Dedup is deliberately NOT applied. A `WatchHistory` row is a real play event
 * recorded against the copy that was actually played; filtering to
 * `dedupCanonical` would silently drop every play that happened on a
 * non-canonical server. Each row carries its server so a multi-server library
 * stays legible.
 *
 * A `watched: false` row is returned like any other — this is display data, and
 * a partial play is a real play. Only the watch-state reconcile
 * (`src/lib/sync/watch-reconcile.ts`) cares about the completion threshold.
 */
export async function fetchPlayHistory(options: {
  userId: string;
  mediaItemIds: string[];
  serverId?: string | null;
  page: number;
  limit: number;
}) {
  const { userId, mediaItemIds, serverId, page, limit } = options;

  if (mediaItemIds.length === 0) {
    return { items: [], pagination: { page, limit, hasMore: false, totalCount: 0 } };
  }

  const where: Prisma.WatchHistoryWhereInput = {
    mediaItemId: { in: mediaItemIds },
    // Ownership guard: only history recorded on this user's servers.
    mediaServer: { userId, ...(serverId ? { id: serverId } : {}) },
  };

  const [rows, totalCount] = await Promise.all([
    prisma.watchHistory.findMany({
      where,
      // Newest play first. A unique tiebreaker after the user-visible sort keeps
      // the order total, so paging can't duplicate or drop rows in a tie block.
      orderBy: [{ watchedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: limit + 1,
      skip: (page - 1) * limit,
      select: PLAY_HISTORY_SELECT,
    }),
    prisma.watchHistory.count({ where }),
  ]);

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  return {
    items: rows.map(serializePlayRow),
    pagination: { page, limit, hasMore, totalCount },
  };
}

/** Parse and clamp the shared `page`/`limit`/`serverId` query params. */
export function parsePlayHistoryPaging(searchParams: URLSearchParams) {
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
  const rawLimit = parseInt(searchParams.get("limit") ?? String(DEFAULT_PLAY_LIMIT));
  // Floor at 1 and cap — a negative/zero limit produced LIMIT 0 or a negative
  // OFFSET (Postgres rejects a negative OFFSET → 500).
  const limit = Math.max(
    1,
    Math.min(Number.isNaN(rawLimit) ? DEFAULT_PLAY_LIMIT : rawLimit, MAX_PLAY_LIMIT),
  );
  return { page, limit, serverId: searchParams.get("serverId") };
}
