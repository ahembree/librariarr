import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { reconcileWatchStateFromHistory } from "@/lib/sync/watch-reconcile";
import {
  buildTracearrJoinIndex,
  resolveMediaItemId,
  type TracearrJoinSkipReason,
} from "@/lib/sync/tracearr-join";
import {
  MAX_PAGE_SIZE,
  TracearrClient,
  type TracearrHistoryRecord,
} from "@/lib/tracearr/tracearr-client";

/**
 * Incremental import of Tracearr play history into `WatchHistory`.
 *
 * This is the alternative to the native full-replace in `sync-watch-history.ts`,
 * chosen per media server by `MediaServer.tracearrServerId`. The two differ in
 * kind, not just in source:
 *
 *  - The native path DELETEs the server's rows and re-inserts everything the
 *    media server currently reports, because that is all a media server can
 *    tell us (Plex prunes, Jellyfin only exposes per-item counts).
 *  - Tracearr is a durable, keyset-paginated, `since`-filterable log with a
 *    stable id per play, so this path only ever **appends and upserts**. It
 *    never deletes. That is what makes a partial run safe: a mid-sync failure
 *    leaves the pages already written durably imported and nothing corrupt.
 *
 * The other structural difference — and the reason for the ON CONFLICT DO UPDATE
 * below rather than DO NOTHING — is that a Tracearr `HistoryRecord` is an
 * **aggregate over a resume chain**, not an immutable event. See the comment on
 * `WATCH_HISTORY_UPSERT_SUFFIX`.
 */

/**
 * How far back before the watermark to re-pull on every run.
 *
 * `since` is inclusive AND — per the API spec — also scopes the aggregation:
 * `duration_ms`, `segment_count` and `percent_complete` cover only the segments
 * inside the window. A chain whose first segment predates the window is
 * therefore reported with a *truncated* completion figure, so pulling from the
 * watermark itself would import a 100%-watched play as, say, 40% watched. One
 * hour of overlap is cheap (the upsert makes re-delivery idempotent) and covers
 * both that and any clock skew between us and Tracearr.
 */
const OVERLAP_MS = 60 * 60 * 1000;

/**
 * The hard floor on how far back an unfinished chain may drag `since`.
 *
 * A chain that is still `playing`/`paused`, or that never crossed the
 * completion threshold, is a row we must re-fetch until it settles — but an
 * abandoned one never settles. Without this clamp a single "playing" row from
 * six months ago would pin the watermark to six months ago and turn every
 * subsequent sync back into a full re-pull.
 */
const OPEN_CHAIN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Defensive bound on the paging loop. At `MAX_PAGE_SIZE` (100) this is 200k
 * records — far beyond any real first import — so tripping it means the cursor
 * is misbehaving, not that a library is large. Logged when it happens.
 */
const MAX_PAGES = 2_000;

/**
 * The insert column list, in order. Everything else (the VALUES tuples, the
 * conflict UPDATE set, the batch size) is derived from this array so the column
 * list and the parameter order cannot drift apart.
 */
const INSERT_COLUMNS = [
  "id",
  "mediaItemId",
  "mediaServerId",
  "serverUsername",
  "watchedAt",
  "deviceName",
  "platform",
  "createdAt",
  "source",
  "sourceEventId",
  "referenceId",
  "watched",
  "percentComplete",
  "state",
  "progressMs",
  "durationMs",
  "totalDurationMs",
  "segmentCount",
  "stoppedAt",
  "player",
  "product",
  "isTranscode",
  "videoDecision",
  "audioDecision",
  "bitrate",
  "resolution",
  "sourceVideoCodec",
  "sourceAudioCodec",
  "streamVideoCodec",
  "streamAudioCodec",
  "transcodeInfo",
  "subtitleInfo",
  "streamQuality",
] as const;

type InsertColumn = (typeof INSERT_COLUMNS)[number];

/** `Json?` columns — passed as JSON text and cast, so the placeholder needs `::jsonb`. */
const JSON_COLUMNS = new Set<InsertColumn>([
  "transcodeInfo",
  "subtitleInfo",
  "streamQuality",
]);

/**
 * The columns a re-delivered chain is allowed to overwrite.
 *
 * Deliberately excluded: `id` and `createdAt` (ours, and stable), `watchedAt`
 * (the chain's start instant — it is what the watermark is computed from, so it
 * must not move), and `mediaServerId`/`source`/`sourceEventId`/`referenceId`
 * (the identity we conflicted on, plus a value the spec defines as equal to it).
 */
const MUTABLE_COLUMNS = [
  "mediaItemId",
  "serverUsername",
  "deviceName",
  "platform",
  "watched",
  "percentComplete",
  "state",
  "progressMs",
  "durationMs",
  "totalDurationMs",
  "segmentCount",
  "stoppedAt",
  "player",
  "product",
  "isTranscode",
  "videoDecision",
  "audioDecision",
  "bitrate",
  "resolution",
  "sourceVideoCodec",
  "sourceAudioCodec",
  "streamVideoCodec",
  "streamAudioCodec",
  "transcodeInfo",
  "subtitleInfo",
  "streamQuality",
] as const satisfies readonly InsertColumn[];

/**
 * **ON CONFLICT DO UPDATE, never DO NOTHING.**
 *
 * The API spec defines a `HistoryRecord` as an aggregate over a resume chain
 * keyed by the chain id, so the same `sourceEventId` is re-delivered with
 * *different* values as the play progresses: `state`, `stopped_at`,
 * `progress_ms`, `duration_ms`, `percent_complete`, `segment_count` and —
 * critically — `watched` all move.
 *
 * `DO NOTHING` would freeze a play at whatever partial state it happened to
 * have when it was first imported. A movie imported at 12% while still playing
 * would stay `watched = false` forever, and `watch-reconcile.ts` skips
 * `watched = false` rows on purpose — so that play would never count toward
 * `playCount`/`lastPlayedAt`, and the lifecycle rules reading those columns
 * would treat a fully-watched film as untouched.
 */
const WATCH_HISTORY_UPSERT_SUFFIX = `ON CONFLICT ("mediaServerId","sourceEventId") DO UPDATE SET ${MUTABLE_COLUMNS.map(
  (column) => `"${column}" = EXCLUDED."${column}"`,
).join(",")}`;

const INSERT_COLUMN_LIST = INSERT_COLUMNS.map((column) => `"${column}"`).join(
  ",",
);

/**
 * Rows per INSERT, derived from the column count rather than a copied
 * constant. Postgres caps a statement at 65535 bind parameters; these rows are
 * ~4× wider than the native path's 8-column ones and carry three JSON blobs
 * each, so the budget is kept modest — the payload size, not the round-trip
 * count, is what matters here.
 */
const MAX_BIND_PARAMS_PER_STATEMENT = 6_000;
const BATCH_SIZE = Math.max(
  1,
  Math.floor(MAX_BIND_PARAMS_PER_STATEMENT / INSERT_COLUMNS.length),
);

type WatchHistoryRow = Record<InsertColumn, unknown>;

interface WatermarkRow {
  maxWatchedAt: Date | null;
  oldestOpenChain: Date | null;
}

/** Per-run tallies, for the summary log line. */
interface ImportCounters {
  inserted: number;
  updated: number;
  skipped: Record<TracearrJoinSkipReason, number>;
  /** Records whose `server_id` was not the one we asked for. */
  foreignServer: number;
  /** Records with an unparseable `started_at` — `watchedAt` is the whole point. */
  invalidTimestamp: number;
  /** The same chain id delivered more than once in a run (the overlap window). */
  duplicate: number;
}

/**
 * The `since` for the next pull, from the two watermark aggregates.
 *
 * Exported for direct unit coverage of the formula — it is the piece where an
 * off-by-one silently costs plays (too late a `since` skips them) or costs a
 * full re-pull every run (too early).
 */
export function resolveSince(
  maxWatchedAt: Date | null,
  oldestOpenChain: Date | null,
): Date | undefined {
  // First run: no Tracearr rows at all for this server, so pull the whole
  // history once. Tracearr keeps it durably; we only do this once per server.
  if (!maxWatchedAt) return undefined;

  const maxMs = maxWatchedAt.getTime();
  let sinceMs = maxMs - OVERLAP_MS;

  // An unfinished chain must be re-fetched until it settles, so reach back to
  // the oldest one we hold rather than to the newest row overall.
  if (oldestOpenChain != null) {
    sinceMs = Math.min(sinceMs, oldestOpenChain.getTime());
  }

  // ...but never further than the lookback floor, or one abandoned play pins
  // the watermark and every sync becomes a full re-pull.
  return new Date(Math.max(sinceMs, maxMs - OPEN_CHAIN_LOOKBACK_MS));
}

export async function syncTracearrHistory(
  serverId: string,
): Promise<{ count: number }> {
  const server = await prisma.mediaServer.findFirst({
    where: { id: serverId },
    select: {
      id: true,
      name: true,
      enabled: true,
      tracearrServerId: true,
      userId: true,
    },
  });

  if (!server) {
    logger.warn(
      "WatchHistory",
      `Tracearr history sync skipped — MediaServer not found: ${serverId}`,
    );
    return { count: 0 };
  }

  if (!server.enabled) {
    logger.info(
      "WatchHistory",
      `Skipping Tracearr history sync for disabled server "${server.name}"`,
    );
    return { count: 0 };
  }

  const tracearrServerId = server.tracearrServerId;
  if (!tracearrServerId) {
    logger.warn(
      "WatchHistory",
      `Tracearr history sync skipped for "${server.name}" — no Tracearr server mapped`,
    );
    return { count: 0 };
  }

  // One instance per install in practice; `createdAt asc` makes the choice
  // deterministic if an admin ever configures a second one.
  const instance = await prisma.tracearrInstance.findFirst({
    where: { userId: server.userId, enabled: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, url: true, apiKey: true },
  });

  if (!instance) {
    logger.warn(
      "WatchHistory",
      `Tracearr history sync skipped for "${server.name}" — no enabled Tracearr instance configured`,
    );
    return { count: 0 };
  }

  const since = await resolveSinceForServer(serverId);
  const client = new TracearrClient(instance.url, instance.apiKey);

  // One index for the whole run: a first import is tens of thousands of
  // records, so resolution must not cost a query per record.
  const joinIndex = await buildTracearrJoinIndex(serverId);

  logger.info(
    "WatchHistory",
    `Importing Tracearr history for "${server.name}" from "${instance.name}" ` +
      `(${since ? `since ${since.toISOString()}` : "full history — first run"}, ` +
      `${joinIndex.itemCount} candidate items)`,
  );

  const counters: ImportCounters = {
    inserted: 0,
    updated: 0,
    skipped: { unresolved: 0, ambiguous: 0, "unsupported-type": 0 },
    foreignServer: 0,
    invalidTimestamp: 0,
    duplicate: 0,
  };

  // Chain ids already written this run. The overlap window re-delivers recent
  // chains, and one INSERT statement may not touch the same conflicting row
  // twice ("ON CONFLICT DO UPDATE command cannot affect row a second time"
  // aborts the whole statement), so this both saves work and keeps the batches
  // valid.
  const seenEventIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  try {
    for (;;) {
      if (pages >= MAX_PAGES) {
        logger.warn(
          "WatchHistory",
          `Tracearr history import for "${server.name}" stopped at the ${MAX_PAGES}-page ` +
            `cap — the cursor is not terminating; the next run resumes from the watermark`,
        );
        break;
      }

      const page = await client.getHistoryPage(tracearrServerId, {
        cursor,
        since,
        pageSize: MAX_PAGE_SIZE,
      });
      pages++;

      const rows: WatchHistoryRow[] = [];
      const now = new Date();

      for (const record of page.records) {
        // One Tracearr instance aggregates many media servers; a record for
        // another one would attach a stranger's play to this server's items.
        if (record.server_id !== tracearrServerId) {
          counters.foreignServer++;
          continue;
        }

        if (seenEventIds.has(record.id)) {
          counters.duplicate++;
          continue;
        }

        const watchedAt = parseDate(record.started_at);
        if (!watchedAt) {
          counters.invalidTimestamp++;
          continue;
        }

        const resolved = resolveMediaItemId(joinIndex, record);
        if ("skipped" in resolved) {
          counters.skipped[resolved.skipped]++;
          continue;
        }

        seenEventIds.add(record.id);
        rows.push(buildRow(record, resolved.mediaItemId, serverId, watchedAt, now));
      }

      // Write this page's rows before fetching the next one. The model is
      // append/upsert-only, so a failure on a later page leaves these durably
      // imported rather than rolling back the run.
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const written = await writeBatch(serverId, rows.slice(i, i + BATCH_SIZE));
        counters.inserted += written.inserted;
        counters.updated += written.updated;
      }

      const next = page.nextCursor;
      if (!next) break;
      if (seenCursors.has(next)) {
        // A cursor we have already followed means the keyset is not advancing;
        // continuing would page forever over the same records.
        logger.warn(
          "WatchHistory",
          `Tracearr history import for "${server.name}" stopped after ${pages} page(s) — ` +
            `the cursor stopped advancing`,
        );
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }
  } catch (error) {
    // A fetch or write failure must never reach the job runner as a failed
    // sync: everything already written is committed and correct, and the next
    // run resumes from the watermark those rows establish.
    logger.warn(
      "WatchHistory",
      `Tracearr history import for "${server.name}" stopped early after ${pages} page(s) — ` +
        `keeping the ${counters.inserted + counters.updated} row(s) already imported`,
      { error: String(error) },
    );
  }

  const total = counters.inserted + counters.updated;

  if (total > 0) {
    // Same non-fatal contract as the native path: the history rows are already
    // committed, so a reconcile failure is corrected by the next run rather
    // than worth failing this one over.
    try {
      await reconcileWatchStateFromHistory(serverId);
    } catch (error) {
      logger.warn(
        "WatchHistory",
        `Failed to reconcile play state from Tracearr history for "${server.name}"`,
        { error: String(error) },
      );
    }

    invalidateMediaCaches();
  }

  logger.info(
    "WatchHistory",
    `Tracearr history for "${server.name}": ${counters.inserted} new, ` +
      `${counters.updated} updated over ${pages} page(s) — skipped ` +
      `${counters.skipped.unresolved} unresolved, ${counters.skipped.ambiguous} ambiguous, ` +
      `${counters.skipped["unsupported-type"]} unsupported type, ` +
      `${counters.foreignServer} other-server, ${counters.invalidTimestamp} bad timestamp, ` +
      `${counters.duplicate} repeated chain(s)`,
  );

  return { count: total };
}

/**
 * The two aggregates the `since` window is derived from, over this server's
 * TRACEARR rows only (native rows carry no chain id and are full-replaced by
 * the other path, so they say nothing about what we have imported).
 *
 * `oldestOpenChain` is the oldest row that has not settled — either it never
 * crossed the completion threshold (`watched IS NOT TRUE`, which also covers a
 * NULL) or its last segment was still `playing`/`paused`.
 */
async function resolveSinceForServer(
  serverId: string,
): Promise<Date | undefined> {
  const rows = await prisma.$queryRawUnsafe<WatermarkRow[]>(
    `SELECT MAX("watchedAt") AS "maxWatchedAt",
            MIN("watchedAt") FILTER (
              WHERE "watched" IS NOT TRUE OR "state" <> 'stopped'
            ) AS "oldestOpenChain"
       FROM "WatchHistory"
      WHERE "mediaServerId" = $1
        AND "source" = 'TRACEARR'`,
    serverId,
  );

  const row = rows[0] ?? { maxWatchedAt: null, oldestOpenChain: null };
  return resolveSince(
    row.maxWatchedAt ? new Date(row.maxWatchedAt) : null,
    row.oldestOpenChain ? new Date(row.oldestOpenChain) : null,
  );
}

/**
 * Upsert one batch, reporting how many rows were new.
 *
 * The existence pre-check is what makes "N new, M updated" honest: an
 * `ON CONFLICT DO UPDATE` rowcount counts inserts and updates alike, and the
 * split is worth knowing — a run that is all updates means resume chains are
 * settling, not that nothing happened. `(mediaServerId, sourceEventId)` is
 * unique, so the lookup is a single index probe per batch.
 */
async function writeBatch(
  serverId: string,
  rows: WatchHistoryRow[],
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };

  const eventIds = rows.map((row) => row.sourceEventId as string);
  const existing = await prisma.$queryRawUnsafe<
    Array<{ sourceEventId: string }>
  >(
    `SELECT "sourceEventId" FROM "WatchHistory"
      WHERE "mediaServerId" = $1 AND "sourceEventId" = ANY($2)`,
    serverId,
    eventIds,
  );
  const updated = existing.length;

  const params: unknown[] = [];
  const tuples: string[] = [];
  let paramIndex = 1;

  for (const row of rows) {
    const placeholders = INSERT_COLUMNS.map((column) => {
      const placeholder = `$${paramIndex++}`;
      params.push(row[column]);
      // A `Json?` column is fed JSON text (or null); Postgres needs the cast to
      // accept it, and being explicit documents the column's type at the call.
      return JSON_COLUMNS.has(column) ? `${placeholder}::jsonb` : placeholder;
    });
    tuples.push(`(${placeholders.join(",")})`);
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO "WatchHistory" (${INSERT_COLUMN_LIST})
     VALUES ${tuples.join(",")}
     ${WATCH_HISTORY_UPSERT_SUFFIX}`,
    ...params,
  );

  return { inserted: rows.length - updated, updated };
}

/** One record → one row, in the shape `writeBatch` serializes. */
function buildRow(
  record: TracearrHistoryRecord,
  mediaItemId: string,
  serverId: string,
  watchedAt: Date,
  now: Date,
): WatchHistoryRow {
  return {
    id: randomUUID(),
    mediaItemId,
    mediaServerId: serverId,
    // `serverUsername` is NOT NULL and Tracearr's `user.username` is nullable
    // (a server account with no name). "Unknown" is what the native Plex path
    // stores for the same case, so the History page groups them together.
    serverUsername: record.user?.username ?? "Unknown",
    watchedAt,
    deviceName: record.device,
    platform: record.platform,
    createdAt: now,
    source: "TRACEARR",
    sourceEventId: record.id,
    referenceId: record.reference_id,
    watched: record.watched,
    percentComplete: asFloat(record.percent_complete),
    state: record.state,
    progressMs: asInt(record.progress_ms),
    durationMs: asInt(record.duration_ms),
    totalDurationMs: asInt(record.total_duration_ms),
    segmentCount: asInt(record.segment_count),
    stoppedAt: parseDate(record.stopped_at),
    player: record.player,
    product: record.product,
    isTranscode: record.is_transcode,
    videoDecision: record.video_decision,
    audioDecision: record.audio_decision,
    bitrate: asInt(record.bitrate),
    resolution: record.resolution,
    sourceVideoCodec: record.source_video_codec,
    sourceAudioCodec: record.source_audio_codec,
    streamVideoCodec: record.stream_video_codec,
    streamAudioCodec: record.stream_audio_codec,
    transcodeInfo: toJsonParam(record.transcode_info),
    subtitleInfo: toJsonParam(record.subtitle_info),
    streamQuality: toJsonParam(buildStreamQuality(record)),
  };
}

/**
 * The stream-quality bundle: the four source_/stream_ detail objects, the raw
 * source dimensions/channel count, and the five pre-formatted `*_display`
 * strings. Twenty-odd scalar columns would buy nothing — nothing filters on
 * them, they are read back whole for the stream detail view.
 *
 * Keys are camelCase to match Tracearr's own nested objects (its top-level
 * fields are snake_case, its nested ones are not).
 */
function buildStreamQuality(
  record: TracearrHistoryRecord,
): Record<string, unknown> | null {
  return compact({
    sourceVideoDetails: record.source_video_details,
    sourceAudioDetails: record.source_audio_details,
    streamVideoDetails: record.stream_video_details,
    streamAudioDetails: record.stream_audio_details,
    sourceAudioChannels: record.source_audio_channels,
    sourceVideoWidth: record.source_video_width,
    sourceVideoHeight: record.source_video_height,
    sourceVideoCodecDisplay: record.source_video_codec_display,
    sourceAudioCodecDisplay: record.source_audio_codec_display,
    audioChannelsDisplay: record.audio_channels_display,
    streamVideoCodecDisplay: record.stream_video_codec_display,
    streamAudioCodecDisplay: record.stream_audio_codec_display,
  });
}

/**
 * Drop null/undefined keys so the stored JSON stays small, and collapse an
 * all-empty object to null — a row with no stream detail should read as "we
 * have none", not as an empty object the UI has to special-case.
 */
function compact(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** JSON text for a `jsonb` bind param, or null. */
function toJsonParam(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "object" && Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

/**
 * Guard the `Int` columns. The spec types these as integers, but an upstream
 * change that started sending a fractional value would abort the whole INSERT —
 * and take the rest of the batch with it — so round rather than trust.
 */
function asInt(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function asFloat(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

/** A parsed timestamp, or null for a missing or unparseable one. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
