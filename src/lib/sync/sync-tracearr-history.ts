import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { reconcileWatchStateFromHistory } from "@/lib/sync/watch-reconcile";
import {
  buildTracearrJoinIndex,
  resolveMediaItemId,
  type TracearrJoinIndex,
  type TracearrJoinSkipReason,
} from "@/lib/sync/tracearr-join";
import {
  formatPlayCount,
  type WatchHistoryProgressReporter,
} from "@/lib/sync/watch-history-progress";
import {
  MAX_PAGE_SIZE,
  TracearrClient,
  type TracearrHistoryRecord,
} from "@/lib/tracearr/tracearr-client";
import {
  invalidateWatchHistoryEvidence,
  snapshotWatchEvidence,
  type WatchEvidenceSnapshot,
} from "@/lib/media/watch-evidence";
import { eventBus } from "@/lib/events/event-bus";
import { emitWatchHistoryUpdated } from "@/lib/sync/watch-history-events";
import {
  beginTracearrImport,
  endTracearrImport,
  recordTracearrImportPage,
  type TracearrImportHandle,
} from "@/lib/sync/tracearr-import-activity";
import { TracearrMappingChangedError } from "@/lib/sync/tracearr-mapping-changed";

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
 * Defensive bound on the paging loop — a runaway-cursor backstop, nothing else.
 *
 * It must sit far above any REAL first import, because tripping it silently
 * truncates history. The original 2,000 was sized on a guess and was badly
 * wrong: a real library with 160k plays is ~1,600 pages at `MAX_PAGE_SIZE`,
 * leaving 25% headroom before an ordinary install started losing data. At 20k
 * pages this is 2M plays, which no single media server plausibly reaches, while
 * still stopping a non-terminating cursor long before it runs forever.
 *
 * The cursor-repeat guard below is the real protection against a stuck keyset;
 * this is only the backstop for a cursor that keeps changing without advancing.
 */
const MAX_PAGES = 20_000;

/**
 * The insert column list, in order. Everything else (the VALUES tuples, the
 * conflict UPDATE set, the batch size) is derived from this array so the column
 * list and the parameter order cannot drift apart.
 */
const INSERT_COLUMNS = [
  "id",
  "mediaItemId",
  "fanOutOfItemId",
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
  // Null on a primary row; a copy's row names the primary row's item (`mirrorCopyRows`).
  "fanOutOfItemId",
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
 * Columns whose re-delivered value may be *smaller* than the one we already
 * stored, and which must therefore only ever move forward.
 *
 * The spec is explicit that `since` scopes the aggregation as well as the
 * selection: "the window also scopes the aggregation: duration_ms,
 * segment_count and percent_complete cover only in-window segments", and
 * `duration_ms` is "watch time summed across all **in-window** segments".
 *
 * So a chain that *started* before the window but has one segment inside it
 * comes back describing only that segment. A film watched end-to-end on Monday
 * and dipped into again on Thursday is re-delivered on Thursday as
 * `percent_complete ≈ 12, duration_ms ≈ 5min, segment_count 1` — and a blind
 * `= EXCLUDED` would overwrite the stored 100% with it. `watched` follows the
 * same truncated completion, so the row would flip back to `false` and
 * `watch-reconcile.ts` would stop counting a play that really happened.
 *
 * `OPEN_CHAIN_LOOKBACK_MS` guarantees this eventually happens to any long-lived
 * chain, so `GREATEST` here is not belt-and-braces — it is the correctness
 * boundary. It is also the same monotonic rule the reconcile already applies to
 * `playCount`/`lastPlayedAt`: never let a narrower view of history make an item
 * look less watched than we already know it to be.
 *
 * (`GREATEST` ignores NULLs in Postgres, so a null in either side keeps the
 * other value rather than erasing it.)
 */
const MONOTONIC_COLUMNS = new Set<InsertColumn>([
  "percentComplete",
  "progressMs",
  "durationMs",
  "segmentCount",
  "stoppedAt",
]);

/**
 * Columns describing the most recent segment. A truncated window still reports
 * these honestly, but it can report them as NULL where we already hold a real
 * value (a page that only saw a segment with no stream detail), so prefer the
 * new value and fall back to the stored one rather than erasing it.
 */
const PREFER_NEW_NON_NULL_COLUMNS = new Set<InsertColumn>([
  "deviceName",
  "platform",
  "state",
  "totalDurationMs",
  "player",
  "product",
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
]);

/**
 * How one column is merged when a chain is re-delivered. See the sets above.
 *
 * `trustIncomingUsername` says whether the rows this statement carries had their
 * `serverUsername` bridged through the account map or fell back to Tracearr's
 * identity label. `writeBatch` groups a batch by exactly that, because a
 * statement carries one `ON CONFLICT` clause and the two classes need different
 * merges for that one column.
 */
function upsertAssignment(
  column: InsertColumn,
  trustIncomingUsername: boolean,
): string {
  const col = `"${column}"`;
  const stored = `"WatchHistory".${col}`;
  const incoming = `EXCLUDED.${col}`;

  // `serverUsername` is the one column whose merge depends on where the incoming
  // value CAME FROM rather than on what it is.
  //
  // Two rows can carry the same identity-label fallback for very different
  // reasons: the account map could not be loaded at all, or that user is
  // genuinely gone from the server (Tracearr's `/users` drops a removed
  // account). Neither is worth as much as a name we already bridged through
  // `UserAccount.username`, and the blind `COALESCE(EXCLUDED, stored)` every
  // other descriptive column uses would let either overwrite one — silently
  // re-labelling already-correct history the moment a chain is re-delivered,
  // which the one-hour overlap window guarantees for every recent play.
  // `watchedByUser` rules match on this string, so that is a rule that quietly
  // stops matching (including a rule PROTECTING content from a delete), not a
  // cosmetic difference.
  //
  // So: a bridged name may overwrite anything — it is the best value there is,
  // and being able to correct an earlier fallback write is what makes a
  // degraded forward run self-healing. A fallback name may only fill a NULL.
  if (column === "serverUsername") {
    return trustIncomingUsername
      ? `${col} = COALESCE(${incoming}, ${stored})`
      : `${col} = COALESCE(${stored}, ${incoming})`;
  }

  if (MONOTONIC_COLUMNS.has(column)) {
    return `${col} = GREATEST(${stored}, ${incoming})`;
  }
  // `watched` is a latch: a play that once crossed the completion threshold
  // stays watched even if a later, window-truncated view of the same chain
  // reports a partial figure. Written as an explicit IS TRUE test so a NULL on
  // either side reads as "not watched" rather than poisoning the OR.
  if (column === "watched") {
    return `${col} = (${stored} IS TRUE OR ${incoming} IS TRUE)`;
  }
  // `isTranscode` is a latch for the same reason: any segment of the play that
  // transcoded makes the play a transcode, and a later direct-play segment must
  // not erase that.
  if (column === "isTranscode") {
    return `${col} = (${stored} IS TRUE OR ${incoming} IS TRUE)`;
  }
  if (PREFER_NEW_NON_NULL_COLUMNS.has(column)) {
    return `${col} = COALESCE(${incoming}, ${stored})`;
  }
  // `mediaItemId`/`fanOutOfItemId`: the join's newest resolution wins outright.
  return `${col} = ${incoming}`;
}

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
function buildUpsertSuffix(trustIncomingUsername: boolean): string {
  return `ON CONFLICT ("mediaServerId","sourceEventId") DO UPDATE SET ${MUTABLE_COLUMNS.map(
    (column) => upsertAssignment(column, trustIncomingUsername),
  ).join(",")}`;
}

/** For rows whose username came from the account map. */
const WATCH_HISTORY_UPSERT_SUFFIX = buildUpsertSuffix(true);
/** For rows carrying the identity-label fallback — see `upsertAssignment`. */
const WATCH_HISTORY_UPSERT_SUFFIX_FALLBACK_USERNAME = buildUpsertSuffix(false);

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

/**
 * A mapped row plus the one thing its columns cannot tell the SQL: whether
 * `serverUsername` was bridged through the account map or is Tracearr's
 * identity-label fallback. `writeBatch` groups on it so each statement gets the
 * right `ON CONFLICT` merge for that column — see `upsertAssignment`.
 */
interface PendingRow {
  row: WatchHistoryRow;
  usernameFromAccountMap: boolean;
  /** The play's other library copies, sorted after `row.mediaItemId` (see `writeBatch`). */
  copyItemIds: string[];
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
  /**
   * Rows dropped at write time because their `MediaItem` was deleted after this
   * run's join index was built.
   *
   * Kept apart from `skipped.unresolved` because it is a different event: the
   * item WAS there when the record resolved, and something removed it while the
   * run was still walking. The next run — which rebuilds the index — will count
   * the same play as `unresolved` instead, so seeing this counter move is the
   * only signal that a delete raced an in-flight import.
   */
  vanished: number;
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
  now: number = Date.now(),
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
  sinceMs = Math.max(sinceMs, maxMs - OPEN_CHAIN_LOOKBACK_MS);

  // Never ask for a window that starts in the future. `watchedAt` comes from
  // Tracearr's `started_at`, so a clock skewed ahead on the Tracearr host (or
  // one bogus record) puts `maxWatchedAt` past now — and since the watermark is
  // derived from the rows we store, a future `since` would match nothing, store
  // nothing, and leave the watermark exactly where it was. That is a permanent
  // stall, not a transient one, so clamp instead: re-fetching a little extra is
  // free (the upsert dedups), whereas importing nothing forever is not.
  return new Date(Math.min(sinceMs, now));
}

/** Which of the two boundaries a run should walk. */
export type TracearrImportPass = "forward" | "backfill" | "both";

export interface TracearrImportOptions {
  onProgress?: WatchHistoryProgressReporter;
  /**
   * Cancels the import between pages.
   *
   * Checked at the top of every page and passed into the HTTP call, so a cancel
   * takes effect within one page and interrupts a rate-limit backoff rather
   * than waiting it out. Stopping early is a normal outcome, not a failure: the
   * import only appends and upserts, and both boundaries are derived from the
   * rows already written, so the next run resumes exactly where this one
   * stopped.
   */
  signal?: AbortSignal;
  /**
   * Which boundaries to walk. Defaults to `"both"`.
   *
   * The split exists because the two passes have opposite cost profiles. The
   * FORWARD pass is small and bounded — an hour of overlap — and belongs in the
   * foreground, where a user pressing Refresh expects an answer in seconds. The
   * BACKFILL pass walks a server's entire retained history (160k plays is
   * ~1,600 pages) and belongs on the job queue, where it can outlive the
   * request, the tab, and the container.
   */
  passes?: TracearrImportPass;
  /**
   * Epoch-ms budget: no NEW page is started past this instant.
   *
   * How a background backfill stays a well-behaved queue citizen. `MAIN_QUEUE`
   * is serial, so a single job that ran for an hour would block every sync and
   * lifecycle run behind it. Instead each run takes a slice and re-enqueues.
   * Never interrupts a page mid-flight — the deadline gates starting the next
   * one, so a slice always ends on a committed page boundary.
   */
  deadlineMs?: number;
  /**
   * End the walk early, at the next page boundary, once this returns true.
   *
   * The background backfill passes one so a sync the user is waiting on does
   * not sit behind the rest of a 5-minute slice: `MAIN_QUEUE` is serial, and
   * the job cannot be pre-empted from outside. Checked exactly where
   * `deadlineMs` is — never mid-page, and never before this walk has fetched
   * one page — so a yield is the same clean, resumable stop as a spent slice
   * and cannot turn into a slice that makes no progress.
   */
  yieldTo?: () => boolean;
}

export interface TracearrImportResult {
  /**
   * How the backfill pass ended, when one ran. `"errored"` means the next attempt
   * would fail the same way (`backfillError` says why), so the caller must not
   * re-enqueue on it or the failure becomes a hot loop.
   */
  backfillOutcome?: WalkOutcome;
  /** Why the backfill pass errored; the task throws with it, so the job records the cause. */
  backfillError?: string;
  /** Rows inserted plus rows updated across every pass this run made. */
  count: number;
  /**
   * Why the backfill was held without walking (reported `"exhausted"` with the
   * backfill pending, so the task does not re-enqueue): `"awaiting-resync"` —
   * the library-resync hold; `"no-library-items"` — no enabled library has items.
   */
  heldReason?: "awaiting-resync" | "no-library-items";
  /**
   * The walk exhausted the archive but its completion write was refused (a
   * concurrent restart or mapping change); the backfill task re-queues on this
   * rather than read the `"exhausted"` outcome as an empty archive.
   */
  completionLost?: boolean;
  /**
   * Older history remains un-walked, so a backfill run is still owed. Drives
   * both the job's self-re-enqueue and the UI's "still importing" state.
   */
  backfillPending: boolean;
  /**
   * Why the run could not do what the caller asked (no enabled instance monitors
   * the mapping, or a requested forward walk failed). Not set for a resumable
   * stop, nor for a backfill refused for want of the account map.
   */
  failed?: string;
}

/**
 * Throttled `tracearr:import-progress` emitter.
 *
 * The importer commits a page roughly every second across thousands of pages,
 * and every event costs a listening client one status query — so an unthrottled
 * emit would turn a background archive walk into a steady query load for as
 * long as it runs. Two seconds is below the threshold at which a moving number
 * reads as stuttering, and bounds that load regardless of how fast the walk goes.
 *
 * Keyed per server so two servers importing at once cannot starve each other's
 * updates. Module-level rather than per-run because the backfill runs as a
 * series of separate five-minute slices, and a fresh map each slice would let
 * the first page of every slice through unthrottled.
 */
const lastImportProgressEmit = new Map<string, number>();
const IMPORT_PROGRESS_THROTTLE_MS = 2_000;

function emitImportProgress(userId: string, serverId: string, force = false): void {
  const now = Date.now();
  const last = lastImportProgressEmit.get(serverId) ?? 0;
  if (!force && now - last < IMPORT_PROGRESS_THROTTLE_MS) return;
  lastImportProgressEmit.set(serverId, now);
  eventBus.emit({ type: "tracearr:import-progress", userId, meta: { serverId } });
}

export async function syncTracearrHistory(
  serverId: string,
  options: TracearrImportOptions = {},
): Promise<TracearrImportResult> {
  const activity: { handle?: TracearrImportHandle } = {};
  try {
    return await runTracearrImport(serverId, options, activity);
  } finally {
    // A normal exit clears its activity entry itself, just before its final
    // progress event. One still registered here was left by a throw, and
    // Settings would otherwise report an import running that is not — until a
    // restart — so clear it and tell the page.
    const orphaned = activity.handle && endTracearrImport(activity.handle);
    if (orphaned) emitImportProgress(orphaned.userId, serverId, true);
  }
}

async function runTracearrImport(
  serverId: string,
  options: TracearrImportOptions,
  activity: { handle?: TracearrImportHandle },
): Promise<TracearrImportResult> {
  const { onProgress, signal, passes = "both", deadlineMs, yieldTo } = options;
  const server = await prisma.mediaServer.findFirst({
    where: { id: serverId },
    select: {
      id: true,
      name: true,
      type: true,
      enabled: true,
      tracearrServerId: true,
      tracearrMappingVersion: true,
      tracearrBackfillComplete: true,
      tracearrOldestPlayAt: true,
      tracearrBackfillCursorAt: true,
      tracearrForwardFloorAt: true,
      tracearrForwardWatermarkAt: true,
      tracearrBackfillLastWalkAt: true,
      libraryResyncRequiredAt: true,
      watchHistorySyncedAt: true,
      userId: true,
    },
  });

  if (!server) {
    logger.warn(
      "WatchHistory",
      `Tracearr history sync skipped — MediaServer not found: ${serverId}`,
    );
    return { count: 0, backfillPending: false };
  }

  if (!server.enabled) {
    logger.info(
      "WatchHistory",
      `Skipping Tracearr history sync for disabled server "${server.name}"`,
    );
    return { count: 0, backfillPending: false };
  }

  const tracearrServerId = server.tracearrServerId;
  if (!tracearrServerId) {
    logger.warn(
      "WatchHistory",
      `Tracearr history sync skipped for "${server.name}" — no Tracearr server mapped`,
    );
    return { count: 0, backfillPending: false };
  }

  const wantsForward = passes === "forward" || passes === "both";
  const wantsBackfill = passes === "backfill" || passes === "both";

  // Tracearr serves history NEWEST FIRST (the spec says so, and the cursor is a
  // keyset on `started_at` descending). That single fact dictates this whole
  // design, because it means the forward watermark cannot express resume:
  //
  //   A first import walks new → old. Interrupt it after one page and
  //   `MAX(watchedAt)` is the newest play in the library. Resuming from
  //   `MAX - overlap` then asks for the last hour, gets `nextCursor: null`
  //   immediately, and declares success — silently abandoning every older play.
  //   Verified against a live instance: the resume window returned 3 records
  //   and terminated, with years of history sitting below it.
  //
  // So the import runs up to two passes over two independent boundaries:
  //
  //   FORWARD   `since = MAX(watchedAt) - overlap`, or the forward floor after an
  //             interrupted forward walk;
  //   BACKFILL  `until = cursor ?? watermark ?? MIN(watchedAt)`, walking older
  //             until the history is exhausted (`resolveImportWindow`).
  //
  // The completion flag, cursor, forward watermark and floor are what the rows
  // cannot tell us; everything else is derived from them.
  const serverName = server.name;
  // Captured for the same reason as `serverName`: read inside the `walk`
  // closure, which TypeScript's control-flow analysis cannot see through.
  const ownerUserId = server.userId;
  // Bound once so the paging closure keeps the narrowed, non-null value.
  const mappedServerId = tracearrServerId;
  // Every per-archive write requires the row to still hold this (`TracearrMappingGuard`).
  const guard: TracearrMappingGuard = {
    tracearrServerId: mappedServerId,
    mappingVersion: server.tracearrMappingVersion,
  };

  // The evidence marker at run start, for every marker write (`establishMarker`).
  const evidence = snapshotWatchEvidence(serverId, server.watchHistorySyncedAt);

  // Before any network call: the window decides whether there is anything to do.
  const window = await resolveImportWindow(serverId, {
    backfillComplete: server.tracearrBackfillComplete,
    cursorAt: server.tracearrBackfillCursorAt,
    forwardFloorAt: server.tracearrForwardFloorAt,
    lastWalkAt: server.tracearrBackfillLastWalkAt,
    forwardWatermarkAt: server.tracearrForwardWatermarkAt,
  });

  // The resume cursor as this run found it — compared against when the run
  // records how far it reached, and required to still be there when it writes
  // (see the backfill write below).
  const cursorAtStart = server.tracearrBackfillCursorAt;
  /** A forward walk still owes unread plays (`tracearrForwardFloorAt`): no marker write. */
  let forwardFloorPending = server.tracearrForwardFloorAt != null;
  /** The floor as this run knows it — read at the start, or recorded below. */
  let knownForwardFloor = server.tracearrForwardFloorAt ?? null;

  // The stored walk state is taken at its word, rows or no rows: "complete", or a
  // cursor with nothing stored above it, is a legitimate state, and inferring
  // "stale" from missing rows re-walked such an archive forever. The paths that
  // destroy rows reset it explicitly (`restartTracearrBackfill`, the restore's
  // hold, the server PUT).
  let backfillComplete = server.tracearrBackfillComplete;
  // No forward pass on a first import (no watermark): the backfill covers it all.
  const forwardDue = wantsForward && window.since !== undefined;
  // The archive walk waits while items are KNOWN to be missing
  // (`libraryResyncRequiredAt`): walked before they exist, their plays are stepped
  // over for good and the items read as never watched. A held run reports
  // `"exhausted"` with `heldReason` (no re-enqueue); the releasing library sync
  // queues the slice. No pass may vouch for the history meanwhile.
  const awaitingResync =
    wantsBackfill && !backfillComplete && server.libraryResyncRequiredAt != null;
  const backfillDue = wantsBackfill && !backfillComplete && !awaitingResync;
  if (awaitingResync) {
    logger.info(
      "WatchHistory",
      `Holding the Tracearr archive walk for "${server.name}" until a library sync has ` +
        `brought back the items it is missing — a full sync after a purge or restore, or ` +
        `the sync of a library being populated for the first time`,
    );
  }

  // Nothing to do — the steady state of a fully backfilled server, whose backfill
  // task is queued after every forward sync. It must cost this one query: no
  // instance probe, import card, progress event, join index, `/users` walk or
  // marker withdrawal.
  if (!forwardDue && !backfillDue) {
    return {
      count: 0,
      backfillPending: !backfillComplete,
      ...(awaitingResync
        ? { backfillOutcome: "exhausted" as const, heldReason: "awaiting-resync" as const }
        : {}),
    };
  }

  // Nothing to import INTO: with no item in an enabled library every record
  // resolves to nothing, and such a walk would complete and establish the marker
  // over an empty history. So claim nothing (no walk, cursor, completion, marker,
  // watermark or floor payoff); report `"exhausted"` with the backfill pending.
  // Only an EMPTY library: a populated one matching few records is legitimate.
  if (!(await hasItemsInEnabledLibraries(serverId))) {
    logger.info(
      "WatchHistory",
      `Skipping the Tracearr import for "${server.name}" — none of its enabled ` +
        `libraries holds any items yet, so no play could be attributed. The next ` +
        `sync after its libraries are populated imports the history.`,
    );
    return {
      count: 0,
      backfillPending: !backfillComplete,
      ...(backfillDue
        ? { backfillOutcome: "exhausted" as const, heldReason: "no-library-items" as const }
        : awaitingResync
          ? { backfillOutcome: "exhausted" as const, heldReason: "awaiting-resync" as const }
          : {}),
    };
  }

  // Fix the stored plays' copy rows first: no write of an archived play ever
  // comes to do it. Database-only, so it also runs while Tracearr is down.
  if (server.type === "JELLYFIN" || server.type === "EMBY") {
    await applyLibraryCopyRepair(serverId, guard, serverName, { signal, deadlineMs, yieldTo });
  }

  const resolution = await resolveTracearrInstance(
    ownerUserId,
    tracearrServerId,
    serverName,
  );
  if ("failed" in resolution) {
    return {
      count: 0,
      backfillPending: !backfillComplete,
      // `"errored"` makes the queued task back off instead of re-enqueueing at once.
      ...(backfillDue
        ? { backfillOutcome: "errored" as const, backfillError: resolution.failed }
        : {}),
      failed: resolution.failed,
    };
  }
  const instance = resolution.instance;

  // Report before the slow join index, or a foreground Refresh's bar sits blank.
  onProgress?.({ imported: 0, pages: 0, detail: "Connecting to Tracearr…" });

  // A real import from here: Settings shows it at once (forced past the throttle).
  const importRun = beginTracearrImport(serverId, ownerUserId);
  activity.handle = importRun;
  emitImportProgress(ownerUserId, serverId, true);
  const client = new TracearrClient(instance.url, instance.apiKey);

  // One index for the whole run: a first import is tens of thousands of
  // records, so resolution must not cost a query per record.
  const joinIndex = await buildTracearrJoinIndex(serverId);

  // One map per run, for the same reason as the join index: it is small (users,
  // not plays) and the alternative is guessing at a username per record.
  //
  // Whether a failure here is survivable depends entirely on WHICH pass wants
  // to run, so it is recorded rather than shrugged off — see the backfill gate
  // below, which refuses to walk the archive without it.
  let accountNames: Map<string, string> | undefined;
  try {
    accountNames = await client.getServerAccountNames(mappedServerId, { signal });
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Could not load Tracearr account names for "${serverName}" — plays will be ` +
        `attributed by Tracearr's identity name, which may not match the ` +
        `server's own account names`,
      { error: String(error) },
    );
  }
  // An EMPTY map counts as unloaded: every record names some account, so a
  // server with plays cannot have none.
  const accountMapUsable = accountNames !== undefined && accountNames.size > 0;

  // ATTRIBUTION IS DEGRADED — say so BEFORE writing a single row.
  //
  // The forward pass deliberately keeps running without the map, because it
  // covers an hour of overlap whose rows the next successful run re-delivers
  // and re-labels. But those rows carry Tracearr's identity label ("Nick W")
  // where every other row on this server carries the media server's account
  // name ("weingart"), and `watchedByUser` matches on exactly that string. So
  // a rule "delete unless watched by weingart" matches an item weingart DID
  // watch in this window: the play is there, under a name the rule does not
  // recognise. Monotonic play state does not save this one — unlike playCount,
  // a missing username ARMS a negative rule rather than disarming it.
  //
  // Withdrawn right before the FIRST such row is written, not at the end of the
  // run: rows commit per page, detection runs unserialised against a Refresh,
  // and a match formed meanwhile SURVIVES the later pause (the executor never
  // re-checks evaluability). Not at the start either: a run that writes nothing
  // has stored nothing under the wrong vocabulary.
  //
  // Conditioned on the map being UNUSABLE, not on any fallback name: a user
  // Tracearr has since removed is legitimately absent from a healthy map, and
  // that fallback is permanent and correct — pausing for it would never lift.
  //
  // Repeated before EVERY page this run writes: an overlapping healthy run can
  // clear the floor and re-establish the marker between two of its pages.
  let degradedWarned = false;
  async function withdrawBeforeDegradedWrite(since: Date | undefined): Promise<void> {
    if (accountMapUsable) return;
    await invalidateWatchHistoryEvidence([serverId]);
    // Only a later healthy walk reaching back to this `since` re-labels these rows
    // (the next window, from a MAX they may have moved, can start above them), so
    // record the floor on every degraded write.
    if (since) await recordForwardFloor(since);
    if (!degradedWarned) {
      degradedWarned = true;
      logger.warn(
        "WatchHistory",
        `Importing plays for "${serverName}" without the account-name map, so they ` +
          `will carry Tracearr's identity names. Play-activity lifecycle rules are ` +
          `paused for this server until a sync with a usable map re-labels them.`,
      );
    }
  }

  /** Whether this run already recorded the forward floor. */
  let forwardFloorRecorded = false;
  /**
   * Record, BEFORE the forward walk first moves the watermark, how far back the
   * next one must reach should it not finish: walking newest → oldest, once its
   * first page moves `MAX(watchedAt)` the next `since` starts above every play it
   * left unread. Written before the rows, so a killed process still leaves it;
   * only a page newer than the stored watermark opens that hole.
   */
  async function recordForwardFloorBeforeWrite(
    since: Date,
    pageNewest: Date | null,
  ): Promise<void> {
    if (forwardFloorRecorded) return;
    if (
      window.maxWatchedAt &&
      (!pageNewest || pageNewest <= window.maxWatchedAt)
    ) {
      return;
    }
    forwardFloorRecorded = true;
    await recordForwardFloor(since);
  }

  /** This run began during the library-resync hold — see the forward pass. */
  const heldAtStart = server.libraryResyncRequiredAt != null;
  /**
   * A forward walk begun during the library-resync hold keeps its floor no lower
   * than an hour below the resume cursor: everything below belongs to the walk
   * the hold restarted. Unbounded with no cursor or a finished archive.
   */
  const heldFloorBound =
    server.libraryResyncRequiredAt && cursorAtStart && !server.tracearrBackfillComplete
      ? new Date(cursorAtStart.getTime() - OVERLAP_MS)
      : null;

  /**
   * Taken just before the forward walk's first fetch — no play it leaves unread
   * started later. Stamped on the floor it records (see `clearForwardFloor`).
   */
  let forwardWalkStartedAt: Date | null = null;

  async function recordForwardFloor(walkSince: Date): Promise<void> {
    const since = heldFloorBound && walkSince < heldFloorBound ? heldFloorBound : walkSince;
    forwardFloorPending = true;
    if (!knownForwardFloor || since < knownForwardFloor) knownForwardFloor = since;
    // `LEAST` (ignores NULL): the floor only moves earlier. The recorded-at keeps
    // the newest recording walk's start (`GREATEST`, stamped on EVERY record) —
    // see `clearForwardFloor`. Guarded on the mapping like all per-archive state.
    await prisma.$executeRawUnsafe(
      `UPDATE "MediaServer"
          SET "tracearrForwardFloorAt" = LEAST("tracearrForwardFloorAt", $3),
              "tracearrForwardFloorRecordedAt" = GREATEST("tracearrForwardFloorRecordedAt", $5)
        WHERE "id" = $1 AND "tracearrServerId" = $2 AND "tracearrMappingVersion" = $4`,
      serverId,
      guard.tracearrServerId,
      since,
      guard.mappingVersion,
      forwardWalkStartedAt ?? new Date(),
    );
  }

  // Only a HEALTHY walk not begun during the hold reaches back to the floor.
  const forwardSince = forwardDue
    ? accountMapUsable && !heldAtStart
      ? window.since
      : window.baseSince
    : undefined;

  logger.info(
    "WatchHistory",
    `Importing Tracearr history for "${serverName}" from "${instance.name}" ` +
      `(${describeWindow(forwardSince, window.until, backfillDue)}, ` +
      `${joinIndex.itemCount} candidate items)`,
  );

  const counters: ImportCounters = {
    inserted: 0,
    updated: 0,
    skipped: { unresolved: 0, ambiguous: 0, "unsupported-type": 0 },
    foreignServer: 0,
    invalidTimestamp: 0,
    duplicate: 0,
    vanished: 0,
  };

  // `pages` is shared across both passes on purpose: it is the run's page
  // counter, and the progress bar should keep climbing rather than restarting
  // when the forward pass hands over to the backfill.
  let pages = 0;
  /**
   * Oldest `started_at` this run walked past, stored or not. Held on an object
   * because it is written inside the `walk` closure, which TypeScript's
   * control-flow analysis cannot see — a bare `let` narrows to `null` at the
   * read below.
   */
  const walked: { oldestSeenAt: Date | null; sawAnyRecord: boolean } = {
    oldestSeenAt: null,
    // Whether Tracearr returned a single history record for this mapping, as
    // opposed to whether we managed to STORE one. The two differ constantly and
    // only the first answers "is this mapping pointing at a server that has
    // history": a large share of old plays reference media that has since left
    // the library and are deliberately skipped, so a walk can legitimately
    // exhaust having stored nothing at all.
    sawAnyRecord: false,
  };

  /** What the last `"errored"` walk failed at (`walkFailureReason`); reset per walk. */
  let lastWalkFailure: WalkFailure | undefined;

  /**
   * Walk one window to its end, or until something stops us.
   *
   * `"exhausted"` only when the keyset genuinely ran out (`nextCursor === null`):
   * only that may mark a backfill complete or clear a floor — a cancelled walk
   * read as exhausted strands the unread history. `"errored"` when the next
   * attempt would fail the same way (a failed fetch, a repeated cursor, a failed
   * write on the walk's FIRST page), so the task backs off instead of re-queueing
   * the same slice forever. Anything else is a resumable `"stopped"`.
   */
  async function walk(
    pass: ImportPass,
    options: { since?: Date; until?: Date },
  ): Promise<WalkOutcome> {
    /** Which half of a page the walk is in, and how many pages it committed. */
    const progress: WalkProgress = { phase: "fetch", committedPages: 0 };
    lastWalkFailure = undefined;
    return walkPages(pass, options, progress).catch((error: unknown) => {
      const phase = progress.phase;
      // The mapping moved under this run (the server PUT wiped its rows): a clean
      // stop, so the backfill task re-queues rather than backing off.
      if (error instanceof TracearrMappingChangedError) {
        logger.info(
          "WatchHistory",
          `Tracearr history import for "${serverName}" stopped after ${pages} page(s) — ` +
            `the server's watch-history source changed while it ran`,
        );
        return "stopped" as const;
      }
      // Cancelled mid-request: still the user's Stop, not Tracearr failing.
      if (signal?.aborted) return "stopped" as const;
      // Never thrown: what was written is committed, and the next run resumes from it.
      logger.warn(
        "WatchHistory",
        `Tracearr history import for "${serverName}" stopped early after ${pages} page(s) — ` +
          (phase === "write"
            ? `a page could not be written; it is fetched again next run. `
            : `Tracearr could not be reached. `) +
          `Keeping the ${counters.inserted + counters.updated} row(s) already imported`,
        { error: String(error) },
      );
      if (phase === "write" && progress.committedPages > 0) return "stopped" as const;
      lastWalkFailure = phase;
      return "errored" as const;
    });
  }

  async function walkPages(
    pass: ImportPass,
    options: { since?: Date; until?: Date },
    progress: WalkProgress,
  ): Promise<WalkOutcome> {
    let cursor: string | undefined;
    /** Pages fetched by THIS walk — see the deadline guard below. */
    let pagesThisWalk = 0;
    // Per WALK, like `seenCursors`: the passes travel in opposite directions,
    // and a backfill whose first fetch failed used to inherit the FORWARD pass's
    // oldest record (~`MAX - 1h`) as its resume cursor, so the next slice
    // re-walked the whole already-imported archive. `sawAnyRecord` stays
    // run-scoped — a forward page answers "does this mapping have history" too.
    walked.oldestSeenAt = null;
    // Per-walk, NOT per-run: the two passes' windows can overlap (the backfill's
    // `until` can sit inside `since = MAX - 1h`), and a shared set made the
    // backfill read the forward pass's cursor as a stalled one and error every run.
    const seenCursors = new Set<string>();
    for (;;) {
      // A spent slice is a clean stop on a committed page boundary, never
      // "exhausted": the backfill is unfinished and another run is owed.
      if (
        deadlineMs !== undefined &&
        Date.now() >= deadlineMs &&
        // ...but only once this walk has fetched a page (per WALK: `pages` spans both
        // passes), so a slice whose budget went on setup still makes progress.
        pagesThisWalk > 0
      ) {
        logger.info(
          "WatchHistory",
          `Tracearr ${pass} pass for "${serverName}" reached its time slice ` +
            `after ${pages} page(s) — ${counters.inserted + counters.updated} ` +
            `row(s) kept; the next run continues from here`,
        );
        return "stopped";
      }

      if (yieldTo !== undefined && pagesThisWalk > 0 && yieldTo()) {
        logger.info(
          "WatchHistory",
          `Tracearr ${pass} pass for "${serverName}" paused after ${pages} page(s) so a ` +
            `requested sync can run — ${counters.inserted + counters.updated} row(s) kept; ` +
            `the next run continues from here`,
        );
        return "stopped";
      }

      if (signal?.aborted) {
        logger.info(
          "WatchHistory",
          `Tracearr history import for "${serverName}" cancelled after ${pages} page(s) — ` +
            `${counters.inserted + counters.updated} row(s) kept; the next run resumes from where it stopped`,
        );
        // "stopped", never "exhausted": a cancelled backfill has not seen it all.
        return "stopped";
      }

      if (pages >= MAX_PAGES) {
        logger.warn(
          "WatchHistory",
          `Tracearr history import for "${serverName}" stopped at the ${MAX_PAGES}-page ` +
            `cap — the cursor is not terminating; the next run resumes from where it stopped`,
        );
        return "stopped";
      }

      progress.phase = "fetch";
      const page = await client.getHistoryPage(mappedServerId, {
        cursor,
        since: options.since,
        until: options.until,
        pageSize: MAX_PAGE_SIZE,
        // A bulk walk WILL be throttled (rolling 1-minute window), so it waits a 429
        // out rather than abandoning the run.
        bulk: true,
        signal,
      });
      pages++;
      pagesThisWalk++;
      // Before any filtering: tells an exhausted archive from a wrong mapping.
      if (page.records.length > 0) walked.sawAnyRecord = true;

      const rows: PendingRow[] = [];
      const now = new Date();
      /** Oldest instant on THIS page; folded in only once the page is written. */
      let pageOldest: Date | null = null;
      /** Newest instant on THIS page — whether writing it moves the watermark. */
      let pageNewest: Date | null = null;

      // Chain ids in THIS page: one INSERT may not touch a conflicting row twice.
      // Page-scoped on purpose — a later page's re-delivery is the ON CONFLICT
      // merge, and a run-scoped set would grow with the whole history.
      const seenEventIds = new Set<string>();

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
        // Folded in only once the page is written: every record's instant counts,
        // storable or not (see `tracearrBackfillCursorAt`), but a page whose write
        // throws must not advance anything.
        if (watchedAt && (!pageOldest || watchedAt < pageOldest)) {
          pageOldest = watchedAt;
        }
        if (watchedAt && (!pageNewest || watchedAt > pageNewest)) {
          pageNewest = watchedAt;
        }
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
        rows.push(buildRow(record, resolved, serverId, watchedAt, now, accountNames));
      }

      // Write this page before fetching the next; a later failure keeps it.
      progress.phase = "write";
      if (rows.length > 0) {
        if (!accountMapUsable) {
          await withdrawBeforeDegradedWrite(pass === "forward" ? options.since : undefined);
        } else if (pass === "forward" && options.since) {
          await recordForwardFloorBeforeWrite(options.since, pageNewest);
        }
      }
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const written = await writeBatch(
          serverId,
          guard,
          rows.slice(i, i + BATCH_SIZE),
          libraryCopiesPossible(joinIndex),
        );
        counters.inserted += written.inserted;
        counters.updated += written.updated;
        counters.vanished += written.vanished;
      }

      // Committed, so its position is safe to keep (a failed page is re-walked).
      progress.committedPages++;
      if (
        pageOldest &&
        (!walked.oldestSeenAt || pageOldest < walked.oldestSeenAt)
      ) {
        walked.oldestSeenAt = pageOldest;
      }

      // After the commit, so a listener's refetch never reads an unwritten figure.
      recordTracearrImportPage(importRun, {
        pass,
        pages,
        imported: counters.inserted + counters.updated,
        oldestReached: walked.oldestSeenAt,
      });
      emitImportProgress(ownerUserId, serverId);

      // No `fraction`: the keyset API exposes no total, so a percentage would be
      // invented — the UI shows an indeterminate bar and this count instead.
      onProgress?.({
        imported: counters.inserted + counters.updated,
        pages,
        detail: progressDetail(counters, pages, pass),
      });

      const next = page.nextCursor;
      // The keyset ran out: this pass saw its whole window.
      if (!next) return "exhausted";
      if (seenCursors.has(next)) {
        // A repeated cursor means the keyset is not advancing. `"errored"`, not a
        // resumable stop (which re-queued the same pages forever without parking);
        // committed pages stay, and how far they reached is still recorded.
        logger.warn(
          "WatchHistory",
          `Tracearr history import for "${serverName}" stopped after ${pages} page(s) — ` +
            `Tracearr's history cursor stopped advancing (it handed back a page ` +
            `position already followed). Keeping the ` +
            `${counters.inserted + counters.updated} row(s) already imported`,
        );
        lastWalkFailure = "stalled";
        return "errored";
      }
      seenCursors.add(next);
      cursor = next;
    }
  }

  // FORWARD pass: new plays since the last run, reaching back to the forward
  // floor only with a usable account map. A degraded walk records its own
  // `since` as the floor instead (`withdrawBeforeDegradedWrite`), and the next
  // healthy walk re-labels its rows (`upsertAssignment`).
  let forwardOutcome: WalkOutcome | undefined;
  let failed: string | undefined;
  if (forwardDue) {
    // During the library-resync hold this walk skips the missing items' plays
    // while moving MAX past them, and the restarted backfill walks only below its
    // cursor: the floor recorded before the watermark moves is what keeps them
    // owed. So a walk begun during the hold pays nothing off, even if the hold is
    // gone when it finishes, and keeps to the ordinary window (`forwardSince`).
    const since = forwardSince as Date;
    const forwardStartedAt = new Date();
    forwardWalkStartedAt = forwardStartedAt;
    forwardOutcome = await walk("forward", { since });

    // Only a HEALTHY walk pays anything off: clearing the floor over mislabelled
    // rows would leave them outside every later window.
    if (forwardOutcome === "exhausted" && accountMapUsable) {
      // Compare-and-set (`clearForwardFloor`): a floor pushed further back, or left
      // by a walk that started after this one, is not this walk's to clear.
      if (!heldAtStart && forwardFloorPending && knownForwardFloor && since <= knownForwardFloor) {
        forwardFloorPending = !(await clearForwardFloor(
          serverId,
          guard,
          since,
          forwardStartedAt,
        ));
      }
      // A no-rows archive's forward watermark (`resolveImportWindow`) moves up to this
      // walk's start (compare-and-set on the value read) — never by a walk begun
      // during the library-resync hold, nor while one is set: it skipped the missing
      // items' plays, and with nothing stored no floor keeps them owed.
      const watermarkRead = server.tracearrForwardWatermarkAt ?? null;
      if (
        !heldAtStart &&
        !window.hasRows &&
        (!watermarkRead || forwardStartedAt > watermarkRead)
      ) {
        await advanceForwardWatermark(serverId, guard, watermarkRead, forwardStartedAt);
      }
    } else if (forwardOutcome === "errored") {
      failed = walkFailureReason(lastWalkFailure, "forward");
    }
  }

  let backfillOutcome: WalkOutcome | undefined = awaitingResync ? "exhausted" : undefined;
  /**
   * Whether the completion write below already re-established the evidence
   * marker, so the release at the end of the run doesn't repeat it. That write
   * carries `watchHistorySyncedAt` in the SAME guarded statement as
   * `tracearrBackfillComplete` on purpose — one must never land without the
   * other — so it stays the writer on the run that finishes the archive.
   */
  let markerWritten = false;
  /** See `TracearrImportResult.completionLost`. */
  let completionLost = false;
  /** See `TracearrImportResult.backfillError`. */
  let backfillError: string | undefined;

  // The account map is a PRECONDITION of the archive walk, not a nicety.
  //
  // Rows this pass writes are effectively permanent: the upsert only revisits a
  // chain that is re-delivered, and the walk never returns to a page it has
  // passed — nothing brings a 2021 play back into a later window. So a single
  // transient failure of `/users` would attribute a whole slice of the archive
  // to Tracearr's identity labels ("Nick W") while the rest of the server's
  // history uses the media server's own account names ("weingart"), and a
  // `watchedByUser` rule would then see one person as two. Skipping costs a
  // slice and nothing else — the pass is resumable by design and every boundary
  // it needs is derived from stored rows.
  //
  // The FORWARD pass deliberately keeps running without it. Its trade-off is
  // the opposite one: it covers an hour of overlap, not an archive, so it
  // touches a handful of rows; those rows are re-delivered by the very next
  // successful run (whose overlap window still contains them), where a bridged
  // name overwrites the fallback — see `upsertAssignment` — so degraded
  // attribution there is self-healing rather than permanent. Refusing to run it
  // would instead leave the History page showing nothing new for as long as
  // Tracearr's user endpoint is unhappy, which is the worse outcome.
  //
  // An EMPTY map counts as unloaded (`accountMapUsable`), and the client throws
  // on a `/users` walk cut short: a PARTIAL map is non-empty and would pass.
  if (backfillDue && !accountMapUsable) {
    logger.warn(
      "WatchHistory",
      `Skipping the Tracearr archive walk for "${serverName}" — the account-name ` +
        `map could not be loaded, and importing older plays without it would ` +
        `permanently store them under Tracearr's identity names. The next run ` +
        `resumes the backfill from where it stands.`,
    );
    // Reported as a failed walk on purpose: the queued backfill task
    // re-enqueues itself immediately for any other outcome, and a run that
    // cannot load the map has made no progress — it would spin against an
    // instance that is already failing. `"errored"` is what makes the worker
    // back off instead.
    backfillOutcome = "errored";
    backfillError =
      "Tracearr's account list could not be loaded — older plays are not imported without it";
  }

  if (backfillDue && accountMapUsable) {
    // Measure the far end of the history once, so the UI can show how far
    // through the walk we are instead of an indeterminate spinner. Bisecting
    // `until` costs ~16 calls against the ~1,600 the walk itself takes, and the
    // answer only moves if Tracearr prunes, so it is measured once and stored.
    // Best-effort: a failure here must not stop the import that actually
    // matters — the bar just stays indeterminate for this run.
    if (server.tracearrOldestPlayAt === null) {
      try {
        const oldest = await client.findOldestPlayAt(mappedServerId, { signal });
        if (oldest) {
          const stored = await persistMappedState(
            serverId,
            guard,
            serverName,
            { tracearrOldestPlayAt: oldest },
          );
          if (stored) {
            logger.info(
              "WatchHistory",
              `Tracearr history for "${serverName}" starts at ${oldest.toISOString()}`,
            );
          }
        }
      } catch (error) {
        logger.warn(
          "WatchHistory",
          `Could not determine where "${serverName}"'s Tracearr history starts — ` +
            `backfill progress will be indeterminate this run`,
          { error: String(error) },
        );
      }
    }

    // A walk from the newest play (no cursor, no rows) reads every play that
    // started before its first fetch, so that instant becomes the no-rows archive's
    // forward watermark (`resolveImportWindow`). Compare-and-set on null: one
    // already set accounts for the plays below it.
    if (window.until === undefined && !server.tracearrForwardWatermarkAt) {
      await recordBackfillWatermark(serverId, guard, new Date());
    }

    const outcome = await walk("backfill", { until: window.until });
    backfillOutcome = outcome;
    if (outcome === "errored") backfillError = walkFailureReason(lastWalkFailure, "backfill");

    // Persist how far the walk actually reached, and whether it finished, in ONE
    // write. The cursor matters because the next slice would otherwise resume
    // from the oldest STORED row, which a stretch of unstorable history leaves
    // untouched — re-walking the same pages indefinitely. Monotonic: the cursor
    // only ever moves backwards in time.
    const reached = walked.oldestSeenAt;
    // Null-ish rather than `=== null`: an unmeasured cursor is the common case
    // and must count as "anything is further back than nothing".
    const cursorAdvanced =
      reached !== null && (!cursorAtStart || reached < cursorAtStart);

    // "Exhausted" alone is not enough to declare the archive imported: a first page
    // of `{ records: [], nextCursor: null }` is also what an empty Tracearr or a
    // wrong mapping looks like, and completing there marks an empty history
    // established. Rows from ANY run count, deliberately: an empty answer to a
    // RESUMED walk is the archive's end (`until` is inclusive and names a play this
    // mapping delivered), and refusing it would keep rules paused forever.
    const hasAnyRows = window.hasRows || walked.sawAnyRecord;
    const finished = outcome === "exhausted" && hasAnyRows;

    if (outcome === "exhausted" && !hasAnyRows) {
      logger.warn(
        "WatchHistory",
        `Tracearr reported no history at all for "${serverName}" — not marking the ` +
          `backfill complete, because "complete with zero plays" is indistinguishable ` +
          `from a mapping that points at the wrong server. Check that the mapped ` +
          `Tracearr server is the right one.`,
      );
    }

    if (finished) backfillComplete = true;

    // Every walk that ran (not an errored one) stamps `tracearrBackfillLastWalkAt`,
    // so the status readout tells "never walked" from "walked, found nothing".
    const walkRan = outcome !== "errored";

    if (cursorAdvanced || finished || walkRan) {
      // Only if nothing restarted the walk while this slice ran: a purge moves the
      // cursor (`restartTracearrBackfill`), and written over that the walk would
      // resume deep in the archive and never re-import the newer stretch. A mapping
      // change, re-link included, is refused by the version (`TracearrMappingGuard`).
      const expect = {
        tracearrBackfillCursorAt: cursorAtStart,
        tracearrBackfillComplete: false,
      };
      const state = {
        ...(cursorAdvanced ? { tracearrBackfillCursorAt: reached } : {}),
        ...(finished ? { tracearrBackfillComplete: true } : {}),
        ...(walkRan ? { tracearrBackfillLastWalkAt: new Date() } : {}),
      };

      let stored = false;
      // The marker is written with the completion flag in ONE guarded statement —
      // unless a forward floor is owed, the library-resync hold is set or the marker
      // was withdrawn mid-run (`establishMarker`). Then the flag is written alone:
      // the walk did reach the end, so that is no lost completion; only the
      // vouching waits.
      if (finished && !forwardFloorPending) {
        const attempt = await establishMarker(evidence, guard, expect, state);
        stored = attempt.written;
        markerWritten = attempt.established;
      }
      if (!stored) {
        stored = await persistMappedState(serverId, guard, serverName, state, expect);
      }
      if (finished && !stored) {
        backfillComplete = false;
        completionLost = true;
      }
    }

    if (markerWritten) {
      logger.info(
        "WatchHistory",
        `Tracearr history for "${serverName}" is fully backfilled — later runs ` +
          `only fetch new plays`,
      );
    }
  }

  // RELEASE the evidence marker — the counterpart to the withdrawal at the top
  // of this function, and the half that was missing.
  //
  // The two were not symmetric, and the asymmetry was an outage. The ONLY place
  // the Tracearr path ever wrote `watchHistorySyncedAt` is the `finished`
  // branch above, which fires exactly once in a server's life: the run that
  // walks the archive to its far end. Every run after that is forward-only
  // (`backfillDue` is false once the flag is set), so a single forward pass
  // that could not load the account map withdrew the marker with nothing left
  // in the system able to put it back. `checkWatchHistoryCompleteness` then
  // refused every play-activity rule set, preview, test-item and query action
  // scoped to that server — permanently — while Settings → Servers went on
  // reporting the import as complete, because it reads
  // `tracearrBackfillComplete`, which is still true. The user is told to wait
  // for an import that has already finished. A guard that never releases is its
  // own outage.
  //
  // Conditioned on exactly what the withdrawal is conditioned on — a USABLE
  // account map, so the rows carry the media server's own account names and
  // `watchedByUser` matches the vocabulary it was written against — plus the
  // archive having been walked, which is the other half of what "established"
  // means for a Tracearr-sourced server. A forward pass that stopped early does
  // not block it: the marker describes the stored archive, not this run's page
  // fetches, and a partial forward pass leaves that archive exactly as complete
  // as it was.
  //
  // Written on every healthy run rather than only when currently withdrawn, so
  // the timestamp keeps meaning what the column says: when a sync last
  // established what was played here.
  //
  // Never while a forward floor is pending (a hole, not a stale view; the write
  // also requires the floor clear IN THE ROW), over a withdrawal made while this
  // run walked (a degraded Refresh beside it — `establishMarker`), or while the
  // library-resync hold is set in the row.
  if (
    !markerWritten &&
    backfillComplete &&
    accountMapUsable &&
    !forwardFloorPending
  ) {
    await establishMarker(evidence, guard, { tracearrBackfillComplete: true }, {});
  }

  const total = counters.inserted + counters.updated;

  if (total > 0) {
    // A server's history is single-source by construction, and this is where
    // that invariant is enforced rather than merely assumed.
    //
    // The server PUT already wipes a server's rows when the mapping changes, so
    // in the normal flow there is nothing here to delete. This exists for the
    // paths that bypass it — a mapping written directly, a restored backup, or
    // a fallback that ran before this branch was tightened — because a leftover
    // NATIVE stratum describes the SAME plays as the rows we just imported, and
    // `reconcileWatchStateFromHistory` counts both. `MediaItem.playCount` is
    // monotonic and arms destructive lifecycle rules, so a double count is not
    // self-correcting: once inflated it never comes back down.
    //
    // Runs after rows landed, so a failed run can never leave the server with
    // neither source. Unconditional rather than first-run-only: a mixed stratum
    // can also arrive with a non-null watermark (a restored backup), and the
    // DELETE is an indexed no-op on every healthy sync.
    //
    // Under the mapping guard: a slice that started before an unlink would
    // otherwise delete the native history a Refresh refilled since.
    {
      const purged = await deleteNativeStratum(serverId, guard);
      if (purged > 0) {
        logger.info(
          "WatchHistory",
          `Removed ${purged} native watch-history row(s) for "${server.name}" — ` +
            `superseded by the Tracearr import`,
        );
      }
    }

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

  // Unthrottled: the last page's emit may have been swallowed by the throttle,
  // and this is the one that carries the terminal state — the final count, and
  // whether the backfill just finished. A readout stuck one page short of done
  // is exactly the "it never updates" complaint, arriving at the end instead of
  // throughout. The activity entry is cleared first, so the refetch this
  // triggers no longer reports the run as live.
  endTracearrImport(importRun);
  emitImportProgress(ownerUserId, serverId, true);

  logger.info(
    "WatchHistory",
    `Tracearr history for "${server.name}": ${counters.inserted} new, ` +
      `${counters.updated} updated over ${pages} page(s) — skipped ` +
      `${counters.skipped.unresolved} unresolved, ${counters.skipped.ambiguous} ambiguous, ` +
      `${counters.skipped["unsupported-type"]} unsupported type, ` +
      `${counters.foreignServer} other-server, ${counters.invalidTimestamp} bad timestamp, ` +
      `${counters.duplicate} repeated chain(s), ` +
      // Distinct from every other skip reason above: those describe a record we
      // could not use, this describes an item that disappeared underneath one we
      // could. It is logged even at zero so its absence is an observation rather
      // than an omission — a non-zero value here is the only way to tell a
      // delete raced this run.
      `${counters.vanished} deleted mid-run`,
  );

  // Derived from the flag, not from this run's outcome: a forward-only run
  // never touches the backfill and must still report that one is owed, so the
  // caller can queue it.
  return {
    count: total,
    backfillPending: !backfillComplete,
    backfillOutcome,
    ...(backfillError ? { backfillError } : {}),
    ...(awaitingResync ? { heldReason: "awaiting-resync" as const } : {}),
    ...(completionLost ? { completionLost } : {}),
    ...(failed ? { failed } : {}),
  };
}

/** An errored walk's cause in words: what a parked import's job error shows. */
function walkFailureReason(failure: WalkFailure | undefined, pass: ImportPass): string {
  const which = pass === "forward" ? "new" : "older";
  switch (failure) {
    case "write":
      return `${pass === "forward" ? "New" : "Older"} plays from Tracearr could not be stored`;
    case "stalled":
      return `Tracearr's history cursor stopped advancing while importing ${which} plays`;
    default:
      return `Tracearr could not be reached while importing ${which} plays`;
  }
}

/**
 * The per-page sub-status shown under the server's phase label.
 *
 * A first run pulls the server's ENTIRE history, and that is the case a user
 * most needs told apart from an ordinary incremental sync — it is the one that
 * runs for minutes rather than seconds, and without saying so a bar that has
 * been counting for two minutes looks stuck rather than busy. `since` being
 * undefined is exactly that condition (see `resolveSince`), so the run already
 * knows it without any extra bookkeeping.
 *
 * Dropped records are folded in live rather than left to the summary log line:
 * an import that silently discards a chunk of its plays (a join index that
 * cannot resolve them, say) should be visible to the person watching it happen,
 * not something discovered afterwards in System Logs.
 */
function progressDetail(
  counters: ImportCounters,
  pages: number,
  pass: ImportPass,
): string {
  const imported = counters.inserted + counters.updated;
  const skipped = droppedRecordCount(counters);

  return (
    `Imported ${formatPlayCount(imported)} · page ${pages}` +
    // Naming the pass matters on a large library: a backfill legitimately runs
    // for a very long time, and "importing older history" tells the user the
    // run is making progress through the archive rather than stuck on recent
    // plays.
    (pass === "backfill" ? " · importing older history" : "") +
    (skipped > 0 ? ` · ${skipped.toLocaleString()} skipped` : "")
  );
}

/**
 * Records this server genuinely lost: the three join-resolution failures plus an
 * unparseable `started_at`.
 *
 * Deliberately excludes `foreignServer` (another media server's plays, which
 * were never ours to import — one Tracearr instance aggregates many servers)
 * and `duplicate` (the overlap window re-delivering a chain we already wrote,
 * which is the design working, not data being lost).
 */
function droppedRecordCount(counters: ImportCounters): number {
  return (
    counters.skipped.unresolved +
    counters.skipped.ambiguous +
    counters.skipped["unsupported-type"] +
    counters.invalidTimestamp
  );
}

/**
 * Find the enabled Tracearr instance that actually monitors `tracearrServerId`.
 *
 * The mapping stored on `MediaServer` is a Tracearr-side server UUID, not a
 * reference to a Librariarr instance row — one instance aggregates many media
 * servers, and an install may configure more than one instance. Picking "the
 * oldest enabled instance" would therefore point a correctly-mapped server at
 * the wrong Tracearr whenever two exist, and the import would quietly return
 * nothing (the `server_id` filter matches no rows there) while the settings UI
 * still showed the mapping as valid.
 *
 * A SINGLE instance is probed too: one that does not monitor the mapping
 * answers with an exhausted, empty keyset, which would mark the backfill
 * complete. An unreachable instance is skipped, never read as "not the owner",
 * and the failure says which of the two it was.
 */
export async function resolveTracearrInstance(
  userId: string,
  tracearrServerId: string,
  serverName: string,
): Promise<
  | { instance: { id: string; name: string; url: string; apiKey: string } }
  | { failed: string }
> {
  const instances = await prisma.tracearrInstance.findMany({
    where: { userId, enabled: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, url: true, apiKey: true },
  });

  if (instances.length === 0) {
    logger.warn(
      "WatchHistory",
      `Tracearr history sync skipped for "${serverName}" — no enabled Tracearr instance configured`,
    );
    return { failed: "No enabled Tracearr instance is configured" };
  }

  let unreachable = 0;
  for (const candidate of instances) {
    try {
      const servers = await new TracearrClient(
        candidate.url,
        candidate.apiKey,
      ).listServers();
      if (servers.some((s) => s.id === tracearrServerId)) {
        return { instance: candidate };
      }
    } catch (error) {
      unreachable++;
      logger.warn(
        "WatchHistory",
        `Could not list servers on Tracearr instance "${candidate.name}" while ` +
          `resolving the mapping for "${serverName}" — skipping this instance`,
        { error: String(error) },
      );
    }
  }

  if (unreachable > 0) {
    logger.warn(
      "WatchHistory",
      `Tracearr history sync skipped for "${serverName}" — no reachable Tracearr ` +
        `instance monitors server ${tracearrServerId}; trying again next run`,
    );
    return { failed: "Tracearr could not be reached" };
  }

  logger.warn(
    "WatchHistory",
    `Tracearr history sync skipped for "${serverName}" — ` +
      (instances.length === 1
        ? `the enabled Tracearr instance does not monitor`
        : `none of the ${instances.length} enabled Tracearr instances monitor`) +
      ` server ${tracearrServerId}. Re-pick the watch-history source in settings.`,
  );
  return {
    failed:
      "The mapped Tracearr server is not monitored by any enabled Tracearr instance — " +
      "re-pick the watch-history source",
  };
}

/**
 * `resolveTracearrInstance`, reduced to the instance or null — for the recovery
 * pass, which must not re-derive "which Tracearr owns this server" its own way.
 */
export async function resolveInstanceForServer(
  userId: string,
  tracearrServerId: string,
  serverName: string,
): Promise<{ id: string; name: string; url: string; apiKey: string } | null> {
  const resolution = await resolveTracearrInstance(
    userId,
    tracearrServerId,
    serverName,
  );
  return "instance" in resolution ? resolution.instance : null;
}

/** Which boundary a walk is following. Only affects logging and progress copy. */
type ImportPass = "forward" | "backfill";

/**
 * How a walk ended. Only `"exhausted"` may mark a backfill complete, and only
 * `"errored"` should stop the job re-enqueueing — a slice that merely ran out of
 * time has made progress and should continue immediately, whereas one that
 * could not reach Tracearr, or whose cursor Tracearr keeps handing back, would
 * otherwise hot-loop: the next attempt asks the same question.
 */
type WalkOutcome = "exhausted" | "stopped" | "errored";

/** Why a walk errored — see `walkFailureReason`. */
type WalkFailure = "fetch" | "write" | "stalled";

/**
 * The mapping a run read when it started. Every write that describes the
 * archive requires the row to still hold it, in the same statement. The
 * version is what sees an unlink and re-link to the same Tracearr server: the
 * value is unchanged while the PUT has reset the walk state, and a slice started
 * before the two would write its old walk's cursor or completion over the
 * reset, so the new mapping's archive would never be walked.
 */
export interface TracearrMappingGuard {
  tracearrServerId: string;
  mappingVersion: number;
}

/** The `where` fields of `TracearrMappingGuard`, for a Prisma filter. */
function mappingWhere(guard: TracearrMappingGuard) {
  return {
    tracearrServerId: guard.tracearrServerId,
    tracearrMappingVersion: guard.mappingVersion,
  };
}

/** A walk's position, shared with its error handler — see `walk`. */
interface WalkProgress {
  phase: "fetch" | "write";
  /** Pages this walk fetched AND wrote. */
  committedPages: number;
}

/**
 * The two independent boundaries a run may walk, derived from the rows we hold
 * (and, with none stored, from the forward watermark). Both are absent on a
 * first import: nothing to catch up to, and a backfill from the newest play.
 */
interface ImportWindow {
  /** The forward pass's `since`, reaching back to the forward floor if one is set. */
  since?: Date;
  /** The forward `since` from the rows alone, ignoring the floor. */
  baseSince?: Date;
  until?: Date;
  /** The newest stored Tracearr play — the forward watermark. */
  maxWatchedAt: Date | null;
  /** Whether this server has any stored Tracearr rows at all. */
  hasRows: boolean;
}

/**
 * Whether any ENABLED library of the server holds an item — the gate against
 * walking an archive into an empty library (a disabled library is not synced,
 * so its items prove nothing). Holding the walk back fails closed.
 */
async function hasItemsInEnabledLibraries(serverId: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ populated: boolean }[]>(
    `SELECT EXISTS (
       SELECT 1 FROM "Library" l
         JOIN "MediaItem" mi ON mi."libraryId" = l."id"
        WHERE l."mediaServerId" = $1 AND l."enabled" = true
     ) AS "populated"`,
    serverId,
  );
  return rows[0]?.populated === true;
}

/**
 * Derive both boundaries for this server.
 *
 * The backfill resumes at how far the walk reached (`tracearrBackfillCursorAt`),
 * else the forward watermark, else `MIN(watchedAt)` of the TRACEARR rows;
 * `until` is inclusive, so the boundary play is re-delivered and merged rather
 * than skipped. A page of only skipped records leaves `MIN` where it was (safe:
 * the stretch is re-walked), which is why the reach is recorded separately.
 */
async function resolveImportWindow(
  serverId: string,
  /** The walk state as the run read it from the server row. */
  stored: {
    backfillComplete: boolean;
    cursorAt: Date | null;
    forwardFloorAt: Date | null;
    lastWalkAt: Date | null;
    forwardWatermarkAt: Date | null;
  },
  now: number = Date.now(),
): Promise<ImportWindow> {
  const { backfillComplete, cursorAt, forwardFloorAt, lastWalkAt, forwardWatermarkAt } = stored;
  const rows = await prisma.$queryRawUnsafe<
    {
      maxWatchedAt: Date | null;
      minWatchedAt: Date | null;
      oldestOpenChain: Date | null;
    }[]
  >(
    `SELECT MAX("watchedAt") AS "maxWatchedAt",
            MIN("watchedAt") AS "minWatchedAt",
            MIN("watchedAt") FILTER (
              WHERE "watched" IS NOT TRUE OR "state" <> 'stopped'
            ) AS "oldestOpenChain"
       FROM "WatchHistory"
      WHERE "mediaServerId"=$1 AND "source"='TRACEARR'`,
    serverId,
  );

  const agg = rows[0] ?? {
    maxWatchedAt: null,
    minWatchedAt: null,
    oldestOpenChain: null,
  };

  const hasRows = agg.maxWatchedAt !== null;
  // The stored walk state is trusted as it stands — see the caller. With no rows,
  // `tracearrForwardWatermarkAt` is the forward watermark, during the walk as well
  // as after; only a finished archive whose watermark predates the column falls
  // back to `tracearrBackfillLastWalkAt` minus the lookback. Neither: no forward
  // pass (a first import, which the backfill covers).
  const baseSince = hasRows
    ? resolveSince(agg.maxWatchedAt, agg.oldestOpenChain, now)
    : forwardWatermarkAt
      ? new Date(Math.min(forwardWatermarkAt.getTime() - OVERLAP_MS, now))
      : backfillComplete && lastWalkAt
        ? new Date(Math.min(lastWalkAt.getTime() - OPEN_CHAIN_LOOKBACK_MS, now))
        : undefined;
  // The floor applies AFTER `resolveSince`'s 7-day clamp on purpose: it is a
  // known hole of unread plays, and clamping it would re-open the gap.
  const since =
    baseSince && forwardFloorAt && forwardFloorAt < baseSince
      ? forwardFloorAt
      : baseSince;

  return {
    since,
    baseSince,
    maxWatchedAt: agg.maxWatchedAt,
    // Only meaningful while the backfill is unfinished; when it is finished the
    // caller never runs that pass.
    // Prefer where the walk actually REACHED over where it last managed to
    // store something. They diverge exactly when a stretch of history is
    // unstorable (media since deleted), which is the live-lock case.
    //
    // With no reach recorded, the forward watermark comes before the oldest row:
    // Tracearr's `since` admits a resumed chain filed under an earlier first
    // session, which can put MIN below the forward window, and a backfill resuming
    // below MIN would leave the plays between them unread by either pass.
    until: backfillComplete
      ? undefined
      : (cursorAt ?? forwardWatermarkAt ?? agg.minWatchedAt ?? undefined),
    hasRows,
  };
}

/**
 * The newest start instant at which a pass other than the forward walk (the
 * recovery pass) may store a play; later plays are the forward walk's. Storing
 * one moves the next forward window past every play in between that no walk
 * has read. With rows: `MAX(watchedAt)`; without: the forward window's start
 * plus its hour of overlap; with no forward window: an hour before now.
 */
export async function forwardPassBoundary(
  serverId: string,
  /** The walk state as read from the server row — see `resolveImportWindow`. */
  stored: {
    backfillComplete: boolean;
    cursorAt: Date | null;
    forwardFloorAt: Date | null;
    lastWalkAt: Date | null;
    forwardWatermarkAt: Date | null;
  },
  now: number = Date.now(),
): Promise<Date> {
  const window = await resolveImportWindow(serverId, stored, now);
  if (window.hasRows && window.maxWatchedAt) return window.maxWatchedAt;
  if (window.baseSince) return new Date(window.baseSince.getTime() + OVERLAP_MS);
  return new Date(now - OVERLAP_MS);
}

/**
 * The run's plan, for the log: the bounds the walks will actually use (a held
 * or degraded forward walk's ordinary window, not the floor).
 */
function describeWindow(
  forwardSince: Date | undefined,
  until: Date | undefined,
  backfillDue: boolean,
): string {
  const parts: string[] = [];
  if (forwardSince) {
    parts.push(`new plays since ${forwardSince.toISOString()}`);
  }
  if (backfillDue) {
    parts.push(
      until
        ? `backfilling older than ${until.toISOString()}`
        : "full history from the newest play",
    );
  }
  return parts.join(", ") || "nothing to do";
}

/** Per-archive columns a run may write — see `persistMappedState`. */
interface MappedStateData {
  tracearrOldestPlayAt?: Date;
  tracearrBackfillCursorAt?: Date | null;
  tracearrBackfillComplete?: boolean;
  tracearrForwardFloorAt?: Date | null;
  tracearrBackfillLastWalkAt?: Date | null;
}

/** Values a compare-and-set write requires the row to still hold. */
interface MappedStateExpect {
  tracearrBackfillCursorAt?: Date | null;
  tracearrBackfillComplete?: boolean;
  tracearrForwardFloorAt?: Date | null;
  tracearrBackfillLastWalkAt?: Date | null;
}

/**
 * Write state that only means anything relative to the Tracearr server this run
 * walked — but only while that is still the server's mapping.
 *
 * Every column here describes ONE Tracearr archive. When the mapping changes
 * mid-slice the server PUT wipes the rows and resets these columns, and an
 * unguarded write would then describe the NEW mapping with the OLD one's
 * progress — `tracearrBackfillComplete: true`, the new archive never imported.
 * Hence the mapping AND its version (`TracearrMappingGuard`).
 *
 * `updateMany` rather than `update` so the mapping can sit in the WHERE clause:
 * the check and the write are then one statement and there is no window between
 * them, and a mapping that moved simply matches no row.
 */
async function persistMappedState(
  serverId: string,
  guard: TracearrMappingGuard,
  serverName: string,
  data: MappedStateData,
  /** Further column values the row must still hold for the write to apply. */
  expect: MappedStateExpect = {},
): Promise<boolean> {
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: serverId, ...mappingWhere(guard), ...expect },
    data,
  });

  if (count === 0) {
    logger.info(
      "WatchHistory",
      `Discarded Tracearr backfill state for "${serverName}" — its watch-history ` +
        `source changed, or its archive walk was restarted, while this run was ` +
        `walking, so the progress no longer describes the server's history`,
    );
    return false;
  }
  return true;
}

/** Set the forward watermark where none is set — see `resolveImportWindow`. */
async function recordBackfillWatermark(
  serverId: string,
  guard: TracearrMappingGuard,
  at: Date,
): Promise<boolean> {
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: serverId, ...mappingWhere(guard), tracearrForwardWatermarkAt: null },
    data: { tracearrForwardWatermarkAt: at },
  });
  return count > 0;
}

/**
 * Move a no-rows archive's forward watermark up to `to` (see the call site):
 * compare-and-set on the value read, so a restart meanwhile stands, and never
 * while the library-resync hold is set.
 */
async function advanceForwardWatermark(
  serverId: string,
  guard: TracearrMappingGuard,
  read: Date | null,
  to: Date,
): Promise<boolean> {
  const { count } = await prisma.mediaServer.updateMany({
    where: {
      id: serverId,
      ...mappingWhere(guard),
      tracearrForwardWatermarkAt: read,
      libraryResyncRequiredAt: null,
    },
    data: { tracearrForwardWatermarkAt: to },
  });
  return count > 0;
}

/**
 * Re-establish `watchHistorySyncedAt`, with `state` in the same statement — the
 * one path for every Tracearr marker write. Requires this run's mapping and
 * version, no forward floor and no library-resync hold IN THE ROW, `expect`,
 * and the marker unchanged with no withdrawal since the run began (the native
 * path's checks), so a healthy job cannot vouch over a degraded Refresh's rows.
 * A withdrawal counted after the write puts the marker back to null; `state`
 * stays. Returns whether the row was written and whether the marker stands.
 */
async function establishMarker(
  evidence: WatchEvidenceSnapshot,
  guard: TracearrMappingGuard,
  expect: MappedStateExpect,
  state: MappedStateData,
): Promise<{ written: boolean; established: boolean }> {
  if (evidenceWithdrawnSince(evidence)) return { written: false, established: false };
  const now = new Date();
  const { count } = await prisma.mediaServer.updateMany({
    where: {
      id: evidence.serverId,
      ...mappingWhere(guard),
      tracearrForwardFloorAt: null,
      libraryResyncRequiredAt: null,
      watchHistorySyncedAt: evidence.marker,
      ...expect,
    },
    data: { ...state, watchHistorySyncedAt: now },
  });
  if (count === 0) return { written: false, established: false };
  if (evidenceWithdrawnSince(evidence)) {
    await prisma.mediaServer.updateMany({
      where: { id: evidence.serverId, watchHistorySyncedAt: now },
      data: { watchHistorySyncedAt: null },
    });
    return { written: true, established: false };
  }
  return { written: true, established: true };
}

/** Whether a withdrawal was counted since `evidence` (a fresh snapshot reads the counter). */
function evidenceWithdrawnSince(evidence: WatchEvidenceSnapshot): boolean {
  return (
    snapshotWatchEvidence(evidence.serverId, evidence.marker).generation !==
    evidence.generation
  );
}

/**
 * Clear the forward floor once a forward walk read its whole window down to
 * `since`. Compare-and-set: the floor at or after `since`; every recorder
 * started no later than this walk (`tracearrForwardFloorRecordedAt` — a later
 * walk can have left plays newer than this one's start unread; a null stamp is
 * paid); this run's mapping and version; no library-resync hold in the row.
 */
async function clearForwardFloor(
  serverId: string,
  guard: TracearrMappingGuard,
  since: Date,
  walkStartedAt: Date,
): Promise<boolean> {
  const { count } = await prisma.mediaServer.updateMany({
    where: {
      id: serverId,
      ...mappingWhere(guard),
      tracearrForwardFloorAt: { gte: since },
      libraryResyncRequiredAt: null,
      OR: [
        { tracearrForwardFloorRecordedAt: null },
        { tracearrForwardFloorRecordedAt: { lte: walkStartedAt } },
      ],
    },
    data: { tracearrForwardFloorAt: null, tracearrForwardFloorRecordedAt: null },
  });
  return count > 0;
}

/**
 * Delete the server's NATIVE rows while it is still mapped as this run read it;
 * `FOR SHARE` makes the check and the DELETE one unit against the server PUT.
 */
async function deleteNativeStratum(
  serverId: string,
  guard: TracearrMappingGuard,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const mapped = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "MediaServer"
        WHERE "id" = $1 AND "tracearrServerId" = $2 AND "tracearrMappingVersion" = $3
        FOR SHARE`,
      serverId,
      guard.tracearrServerId,
      guard.mappingVersion,
    );
    if (mapped.length === 0) return 0;
    return tx.$executeRawUnsafe(
      `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1 AND "source"='NATIVE'`,
      serverId,
    );
  });
}

/**
 * Map and upsert an already-fetched set of this server's records.
 *
 * Exported for `tracearr-backfill-additions.ts` — the targeted recovery pass
 * that re-imports a re-added item's plays — and it is deliberately the ONLY
 * writing helper this module exposes. The two things a second writer must never
 * re-implement are the row mapping (`buildRow`) and `WATCH_HISTORY_UPSERT_SUFFIX`:
 * the merge rules encoded there (monotonic progress columns, the `watched` and
 * `isTranscode` latches) are the difference between a re-delivered chain merging
 * correctly and a fully-watched play being overwritten as 12% watched, which
 * `watch-reconcile.ts` would then stop counting. A copy of them would drift, and
 * the drift would be silent.
 *
 * The caller has already scoped the records to this server (`server_id`), so
 * that filter is not repeated here. `inserted`/`updated` count plays;
 * `rowsInserted` counts every new row, a copy's included.
 */
export async function importTracearrRecords(
  serverId: string,
  records: TracearrHistoryRecord[],
  joinIndex: TracearrJoinIndex,
  /** See `resolveUsername` — without this the pass stores the wrong vocabulary. */
  accountNames: Map<string, string> | undefined,
  /** The mapping the records were fetched under — see `TracearrMappingGuard`. */
  guard: TracearrMappingGuard,
): Promise<{ inserted: number; updated: number; skipped: number; rowsInserted: number }> {
  const now = new Date();
  const rows: PendingRow[] = [];
  // Statement scope, exactly as in the walk: one INSERT may not touch the same
  // conflicting row twice ("ON CONFLICT DO UPDATE command cannot affect row a
  // second time" aborts the whole statement).
  const seenEventIds = new Set<string>();
  let skipped = 0;

  for (const record of records) {
    if (seenEventIds.has(record.id)) continue;

    const watchedAt = parseDate(record.started_at);
    if (!watchedAt) {
      skipped++;
      continue;
    }

    const resolved = resolveMediaItemId(joinIndex, record);
    if ("skipped" in resolved) {
      skipped++;
      continue;
    }

    seenEventIds.add(record.id);
    rows.push(buildRow(record, resolved, serverId, watchedAt, now, accountNames));
  }

  let inserted = 0;
  let updated = 0;
  let rowsInserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const written = await writeBatch(
      serverId,
      guard,
      rows.slice(i, i + BATCH_SIZE),
      libraryCopiesPossible(joinIndex),
    );
    inserted += written.inserted;
    updated += written.updated;
    rowsInserted += written.rowsInserted;
  }

  return { inserted, updated, skipped, rowsInserted };
}

/** Jellyfin/Emby: a play can be filed against several library copies of one item. */
function libraryCopiesPossible(index: TracearrJoinIndex): boolean {
  return index.serverType === "JELLYFIN" || index.serverType === "EMBY";
}

/**
 * Upsert one batch of PLAYS: how many were new, already stored, or dropped
 * because every item they resolved to had gone, plus every newly inserted row,
 * copies included (`rowsInserted`). Counted per play, not per row.
 *
 * The chain-id pre-check is what makes "N new, M updated" honest: an
 * `ON CONFLICT DO UPDATE` rowcount counts inserts and updates alike, and the
 * split is worth knowing — a run that is all updates means resume chains are
 * settling, not that nothing happened.
 *
 * `copiesPossible` (Jellyfin/Emby) turns on `settleLibraryCopyRows`; a play's
 * other copies get their rows from the merged primary (`mirrorCopyRows`).
 */
async function writeBatch(
  serverId: string,
  guard: TracearrMappingGuard,
  pending: PendingRow[],
  copiesPossible = false,
): Promise<{ inserted: number; updated: number; vanished: number; rowsInserted: number }> {
  if (pending.length === 0) return { inserted: 0, updated: 0, vanished: 0, rowsInserted: 0 };

  return prisma.$transaction(async (tx) => {
    // Still mapped as the run read it (`TracearrMappingGuard`)? `FOR SHARE` makes
    // the check and the insert one unit against the server PUT, whose UPDATE of
    // this row waits for this transaction: these rows land before the mapping
    // moves (and its wipe removes them), or nothing is written.
    const mapped = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "MediaServer"
        WHERE "id" = $1 AND "tracearrServerId" = $2 AND "tracearrMappingVersion" = $3
        FOR SHARE`,
      serverId,
      guard.tracearrServerId,
      guard.mappingVersion,
    );
    if (mapped.length === 0) throw new TracearrMappingChangedError(serverId);

    const plays = await playsWithLiveMediaItems(tx, pending);
    const vanished = pending.length - plays.length;
    // Nothing survived the check. `INSERT … VALUES` with no tuples is a syntax
    // error, not a no-op, so there is no statement to send at all.
    if (plays.length === 0) return { inserted: 0, updated: 0, vanished, rowsInserted: 0 };

    const chains = plays.map((play) => play.pending.row.sourceEventId as string);
    if (copiesPossible) await settleLibraryCopyRows(tx, serverId, plays, chains);

    // Each play's primary row goes on its lowest live copy...
    const primaries = plays.map((play) => ({
      ...play.pending,
      row: { ...play.pending.row, mediaItemId: play.itemIds[0], fanOutOfItemId: null },
    }));
    // ...and every other live copy a row of its own, from the merged primary.
    const copies: CopyRow[] = plays.flatMap((play, i) =>
      play.itemIds.slice(1).map((mediaItemId) => ({
        id: randomUUID(),
        chain: chains[i],
        sourceEventId: copyEventId(chains[i], mediaItemId),
        mediaItemId,
      })),
    );

    const keys = [...chains, ...copies.map((copy) => copy.sourceEventId)];
    const existing = await tx.$queryRawUnsafe<
      Array<{ sourceEventId: string }>
    >(
      `SELECT "sourceEventId" FROM "WatchHistory"
        WHERE "mediaServerId" = $1 AND "sourceEventId" = ANY($2)`,
      serverId,
      keys,
    );
    const stored = new Set(existing.map((row) => row.sourceEventId));
    const updated = chains.filter((chain) => stored.has(chain)).length;

    // Split by username confidence: the merge rule for that one column differs
    // between the two classes and a statement carries a single `ON CONFLICT`
    // clause. One of the groups is normally empty — a run that loaded the map
    // bridges every account the server still has — so this stays one statement
    // in the ordinary case and becomes two only on a page that mixes a bridged
    // account with a departed one.
    const bridged = primaries.filter((entry) => entry.usernameFromAccountMap);
    const fallback = primaries.filter((entry) => !entry.usernameFromAccountMap);

    if (bridged.length > 0) {
      await insertRows(tx, bridged, WATCH_HISTORY_UPSERT_SUFFIX);
    }
    if (fallback.length > 0) {
      await insertRows(tx, fallback, WATCH_HISTORY_UPSERT_SUFFIX_FALLBACK_USERNAME);
    }
    if (copies.length > 0) await mirrorCopyRows(tx, serverId, copies);

    return {
      inserted: plays.length - updated,
      updated,
      vanished,
      rowsInserted: keys.length - existing.length,
    };
  });
}

/** The `sourceEventId` of a play's row on a library copy other than its primary. */
function copyEventId(chainId: string, mediaItemId: string): string {
  return `${chainId}:copy:${mediaItemId}`;
}

/** One library copy's row of a play, before `mirrorCopyRows` fills it in. */
interface CopyRow {
  /** A fresh row id, used only if the row does not exist yet. */
  id: string;
  /** The play's chain id — the `sourceEventId` of its primary row. */
  chain: string;
  /** `copyEventId(chain, mediaItemId)`. */
  sourceEventId: string;
  mediaItemId: string;
}

/**
 * Before a batch is written on a Jellyfin/Emby server, keep each play's state
 * on its primary row: one row (chain id) on its lowest live copy, plus a row
 * per other copy pointing at it via `fanOutOfItemId`, all carrying the state
 * merged on the primary. A re-delivered chain can be window-truncated, so when
 * the lowest copy changes: with no primary row left, the lowest live copy's
 * row BECOMES it (keeping its progress, latch and username); with one, the
 * copy it moves onto loses its copy row, or that item would hold the play
 * twice. Plays nothing writes again are fixed by `repairLibraryCopyRows`.
 */
async function settleLibraryCopyRows(
  db: RawDb,
  serverId: string,
  plays: Array<{ itemIds: string[] }>,
  chains: string[],
): Promise<void> {
  const candidates: CopyRowCandidate[] = [];
  plays.forEach((play, i) => {
    play.itemIds.forEach((mediaItemId, rank) => {
      candidates.push({ chain: chains[i], sourceEventId: copyEventId(chains[i], mediaItemId), rank });
    });
  });

  await promoteLowestCopyRows(db, serverId, candidates);
  await deleteCopyRows(
    db,
    serverId,
    plays.map((play, i) => copyEventId(chains[i], play.itemIds[0])),
  );
}

/** A play's copy row that may become its primary row — see `promoteLowestCopyRows`. */
interface CopyRowCandidate {
  chain: string;
  sourceEventId: string;
  /** Lower wins: the copy's place among the play's copies, by item id. */
  rank: number;
}

/**
 * For each play with no primary row, turn the lowest-ranked of its listed copy
 * rows that exists into it (renamed, pointer cleared, state kept). Shared by
 * `writeBatch` and the repair so both promote the same row; returns the count.
 *
 * One read, then an update by id, so no statement scans the server's plays per
 * candidate whatever the statistics. Under the repair's row lock rows can only
 * vanish in between with their item (skipped). Page writes promoting one play
 * pick the same row, the second waiting — unless their join indexes disagree:
 * then the second fails on the unique key and its page merges next run.
 */
async function promoteLowestCopyRows(
  db: RawDb,
  serverId: string,
  candidates: CopyRowCandidate[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  const keys = new Set<string>();
  for (const candidate of candidates) keys.add(candidate.chain).add(candidate.sourceEventId);
  const rows = await db.$queryRawUnsafe<Array<{ id: string; sourceEventId: string }>>(
    `SELECT "id", "sourceEventId" FROM "WatchHistory"
      WHERE "mediaServerId" = $1 AND "sourceEventId" = ANY($2)`,
    serverId,
    [...keys],
  );
  const stored = new Map(rows.map((row) => [row.sourceEventId, row.id]));
  const picked = new Map<string, CopyRowCandidate>();
  for (const candidate of candidates) {
    if (stored.has(candidate.chain) || !stored.has(candidate.sourceEventId)) continue;
    const best = picked.get(candidate.chain);
    if (!best || candidate.rank < best.rank) picked.set(candidate.chain, candidate);
  }
  if (picked.size === 0) return 0;
  return db.$executeRawUnsafe(
    `UPDATE "WatchHistory" AS wh
        SET "sourceEventId" = v."chain", "fanOutOfItemId" = NULL
       FROM unnest($1::text[], $2::text[]) AS v("id", "chain")
      WHERE wh."id" = v."id"`,
    [...picked.values()].map((candidate) => stored.get(candidate.sourceEventId)),
    [...picked.keys()],
  );
}

/** Delete this server's rows with these `sourceEventId`s. */
async function deleteCopyRows(db: RawDb, serverId: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  return db.$executeRawUnsafe(
    `DELETE FROM "WatchHistory" WHERE "mediaServerId" = $1 AND "sourceEventId" = ANY($2)`,
    serverId,
    keys,
  );
}

/** A copy row's columns off its merged primary row `p` (its own id, item and key). */
const MIRROR_SELECT_LIST = INSERT_COLUMNS.map((column) => {
  switch (column) {
    case "id":
      return `v."id"`;
    case "mediaItemId":
      return `v."mediaItemId"`;
    case "fanOutOfItemId":
      return `p."mediaItemId"`;
    case "sourceEventId":
      return `v."sourceEventId"`;
    case "createdAt":
      return `CAST($6 AS TIMESTAMP(3))`;
    default:
      return `p."${column}"`;
  }
}).join(",");

/**
 * Write each library copy's row of a play from the play's primary row, after
 * the primary has merged the incoming record (which may be window-truncated),
 * so a copy row never reads less watched than the play. Returns rows written.
 */
async function mirrorCopyRows(db: RawDb, serverId: string, copies: CopyRow[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < copies.length; i += BATCH_SIZE) {
    const chunk = copies.slice(i, i + BATCH_SIZE);
    // Only onto a copy that still exists and is not the item holding the
    // primary row: a copy row there would count the play twice for that item.
    written += await db.$executeRawUnsafe(
      `INSERT INTO "WatchHistory" (${INSERT_COLUMN_LIST})
       SELECT ${MIRROR_SELECT_LIST}
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
              AS v("id", "chain", "sourceEventId", "mediaItemId")
         JOIN "WatchHistory" p ON p."mediaServerId" = $1 AND p."sourceEventId" = v."chain"
         JOIN "MediaItem" ci ON ci."id" = v."mediaItemId"
        WHERE p."mediaItemId" <> v."mediaItemId"
       ${WATCH_HISTORY_UPSERT_SUFFIX}`,
      serverId,
      chunk.map((copy) => copy.id),
      chunk.map((copy) => copy.chain),
      chunk.map((copy) => copy.sourceEventId),
      chunk.map((copy) => copy.mediaItemId),
      new Date(),
    );
  }
  return written;
}

/** Whether the server lists any item in two of its libraries. */
const HAS_COPY_GROUPS_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM "MediaItem" mi
      JOIN "Library" l ON l."id" = mi."libraryId"
     WHERE l."mediaServerId" = $1
     GROUP BY mi."ratingKey"
    HAVING COUNT(*) > 1
  ) AS "found"`;

/**
 * Copy rows whose primary's item was deleted (`SetNull`), including one that
 * outlived every other copy, which promotion only renames.
 */
const ORPHAN_COPY_ROWS_SQL = `
  SELECT "sourceEventId", "mediaItemId"
    FROM "WatchHistory"
   WHERE "mediaServerId" = $1
     AND "source" = 'TRACEARR'
     AND "fanOutOfItemId" IS NULL
     AND "sourceEventId" LIKE '%:copy:%'`;

/**
 * Each primary row of an item listed in two libraries, paired with every other
 * copy holding no row of its play — where the join would file the play
 * (`libraryCopies`): same rating key in another library, same type, and no
 * contradicting identity (show rating key for an episode, TMDB/IMDB otherwise).
 *
 * Read only through `readMissingCopyRows`, and shaped so no plan can multiply
 * rows (statistics are missing exactly when it has the most to do): no nested
 * loop, LATERAL join or correlated subquery; no level inner-joins more than two
 * relations; every join is on an identifier. The fenced `pair_ids` keeps any
 * plan from joining the two id lists on `source` alone.
 */
const MISSING_COPY_ROWS_SQL = `
  WITH copies AS MATERIALIZED (
    SELECT c."id", c."ratingKey", c."type", c."grandparentRatingKey"
      FROM (
        SELECT mi."id", mi."ratingKey", mi."type", mi."grandparentRatingKey",
               COUNT(*) OVER (PARTITION BY mi."ratingKey") AS "listed"
          FROM "MediaItem" mi
          JOIN "Library" l ON l."id" = mi."libraryId"
         WHERE l."mediaServerId" = $1
      ) c
     WHERE c."listed" > 1
  ),
  pairs AS MATERIALIZED (
    SELECT a."id" AS "primaryId", b."id" AS "copyId"
      FROM copies a
      JOIN copies b ON b."ratingKey" = a."ratingKey" AND b."id" <> a."id"
     WHERE b."type" = a."type"
       AND NOT (
         a."type" = 'SERIES'
         AND a."grandparentRatingKey" IS NOT NULL
         AND b."grandparentRatingKey" IS NOT NULL
         AND a."grandparentRatingKey" <> b."grandparentRatingKey"
       )
  ),
  ids AS MATERIALIZED (
    SELECT e."mediaItemId" AS "itemId",
           UPPER(e."source") AS "source",
           TRIM(e."externalId") AS "value"
      FROM "MediaItemExternalId" e
      JOIN copies c ON c."id" = e."mediaItemId"
     WHERE c."type" <> 'SERIES'
       AND UPPER(e."source") IN ('TMDB', 'IMDB')
  ),
  -- Each pair with its primary item's ids, joined by item and fenced before
  -- the copy's are, so no plan can join the two id lists on source alone.
  pair_ids AS MATERIALIZED (
    SELECT x."primaryId", x."copyId", ia."source", ia."value"
      FROM pairs x
      JOIN ids ia ON ia."itemId" = x."primaryId"
  ),
  -- A copy holding an id of a source the primary's item holds one of too, and
  -- none of them equal to it.
  contradicted AS MATERIALIZED (
    SELECT pi."primaryId", pi."copyId"
      FROM pair_ids pi
      JOIN ids ib ON ib."itemId" = pi."copyId" AND ib."source" = pi."source"
     GROUP BY pi."primaryId", pi."copyId", pi."source", pi."value"
    HAVING bool_and(ib."value" <> pi."value")
  )
  SELECT p."sourceEventId" AS "chain", x."copyId"
    FROM pairs x
    JOIN "WatchHistory" p ON p."mediaItemId" = x."primaryId"
   WHERE p."mediaServerId" = $1
     AND p."source" = 'TRACEARR'
     AND p."fanOutOfItemId" IS NULL
     AND p."sourceEventId" NOT LIKE '%:copy:%'
     AND NOT EXISTS (
       SELECT 1 FROM contradicted k
        WHERE k."primaryId" = x."primaryId" AND k."copyId" = x."copyId"
     )
     AND NOT EXISTS (
       SELECT 1 FROM "WatchHistory" w
        WHERE w."mediaServerId" = $1
          AND w."sourceEventId" = p."sourceEventId" || ':copy:' || x."copyId"
     )`;

/**
 * A backstop, not a budget (the search takes a third of a second at 20,000 items
 * listed twice): it runs on every import run, mostly on the serial MAIN_QUEUE,
 * and nothing else stops a running statement. Cancelled, the repair WARNs.
 */
const REPAIR_SEARCH_TIMEOUT_MS = 60_000;

/**
 * `MISSING_COPY_ROWS_SQL` with nested loops off and its timeout — `SET LOCAL`,
 * and put back before returning: a later write in the transaction is not this
 * search's to time out, and reaches its rows by index only through a nested
 * loop. A cancelled search aborts the transaction, dropping both settings.
 */
async function readMissingCopyRows(
  db: RawDb,
  serverId: string,
): Promise<Array<{ chain: string; copyId: string }>> {
  await db.$executeRawUnsafe(`SET LOCAL enable_nestloop = off`);
  await db.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REPAIR_SEARCH_TIMEOUT_MS}`);
  const rows = await db.$queryRawUnsafe<Array<{ chain: string; copyId: string }>>(
    MISSING_COPY_ROWS_SQL,
    serverId,
  );
  await db.$executeRawUnsafe(`SET LOCAL statement_timeout = DEFAULT`);
  await db.$executeRawUnsafe(`SET LOCAL enable_nestloop = DEFAULT`);
  return rows;
}

/** What `repairLibraryCopyRows` changed, counted as each transaction commits. */
interface LibraryCopyRepair {
  /** Plays whose primary row had gone, given one from a surviving copy's row. */
  promoted: number;
  /** Copy rows pointed at their play's primary row again. */
  repointed: number;
  /** Copy rows added on copies that held none of a play's rows. */
  filled: number;
  /** Stopped between transactions with work left — the next import run finishes it. */
  stopped: boolean;
}

/** When a repair stops between transactions — the import run's own limits. */
interface LibraryCopyRepairLimits {
  signal?: AbortSignal;
  deadlineMs?: number;
  yieldTo?: () => boolean;
}

/**
 * Rows per repair transaction: each holds the server row against page writes,
 * and one huge transaction could outlive its timeout and fail every run.
 */
const REPAIR_ROWS_PER_TRANSACTION = 10_000;

/**
 * Rows a repair phase must be about to write before WatchHistory is analysed
 * first (once a run). Stale or missing statistics make the planner take the
 * server's plays for a handful, and every `mirrorCopyRows` statement then hashes
 * all of them; below this a phase is a few passes whatever the statistics.
 */
const REPAIR_ANALYZE_MIN_ROWS = 1_000;

/**
 * How long `analyseWatchHistory` waits for its lock before the repair writes
 * without it: Postgres does not interrupt an anti-wraparound autovacuum, which
 * can hold a large table for hours.
 */
const REPAIR_ANALYZE_LOCK_TIMEOUT_MS = 5_000;

/**
 * `ANALYZE "WatchHistory"` in a transaction of its own — never one holding the
 * server row — bounded by `SET LOCAL`. Stale statistics make writes slower, not
 * wrong, so a failure is a WARN (and a role without the privilege only gets a
 * Postgres warning).
 */
async function analyseWatchHistory(serverName: string, rows: number): Promise<void> {
  const started = Date.now();
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${REPAIR_ANALYZE_LOCK_TIMEOUT_MS}`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REPAIR_SEARCH_TIMEOUT_MS}`);
        await tx.$executeRawUnsafe(`ANALYZE "WatchHistory"`);
      },
      { timeout: REPAIR_SEARCH_TIMEOUT_MS + 15_000, maxWait: 15_000 },
    );
    logger.debug(
      "WatchHistory",
      `Analysed WatchHistory in ${Date.now() - started} ms before writing ` +
        `${rows} library-copy row(s) of "${serverName}"'s Tracearr plays`,
    );
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Could not refresh WatchHistory's statistics before writing ${rows} library-copy row(s) ` +
        `of "${serverName}"'s Tracearr plays — writing them anyway, which can take much longer`,
      { error: String(error) },
    );
  }
}

/**
 * `repairLibraryCopyRows`, then reconcile, drop caches and notify for whatever
 * committed, even if a later transaction failed. Never fails the import run.
 */
async function applyLibraryCopyRepair(
  serverId: string,
  guard: TracearrMappingGuard,
  serverName: string,
  limits: LibraryCopyRepairLimits,
): Promise<void> {
  const repair: LibraryCopyRepair = { promoted: 0, repointed: 0, filled: 0, stopped: false };
  try {
    await repairLibraryCopyRows(serverId, guard, serverName, limits, repair);
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Could not repair the library-copy rows of "${serverName}"'s Tracearr plays — ` +
        `the next import tries again`,
      { error: String(error) },
    );
  }
  if (repair.promoted + repair.repointed + repair.filled === 0) return;

  logger.info(
    "WatchHistory",
    `Repaired the library-copy rows of "${serverName}"'s Tracearr plays: ` +
      `${repair.filled} copy row(s) added for copies listed since their plays were imported, ` +
      `${repair.promoted} play(s) whose primary copy was deleted given a new primary row, ` +
      `${repair.repointed} copy row(s) pointed at it` +
      (repair.stopped ? ` — stopped early, the next import does the rest` : ""),
  );
  // An added copy reads as unwatched until its play state is reconciled.
  if (repair.filled > 0) {
    try {
      await reconcileWatchStateFromHistory(serverId);
    } catch (error) {
      logger.warn(
        "WatchHistory",
        `Failed to reconcile play state after repairing library-copy rows for "${serverName}"`,
        { error: String(error) },
      );
    }
  }
  invalidateMediaCaches();
  await emitWatchHistoryUpdated(serverId, { repaired: true });
}

/** The chain id a copy row's `sourceEventId` carries — see `copyEventId`. */
function chainOfCopyRow(sourceEventId: string): string {
  return sourceEventId.slice(0, sourceEventId.indexOf(":copy:"));
}

/**
 * Bring the copy rows of plays ALREADY stored on a Jellyfin/Emby server in line
 * with the copies that exist now — nothing writes an archived play again:
 *  - a copy listed after the play was imported reads as never watched until it
 *    gets a copy row from the primary, wherever the join would file the play
 *    (`MISSING_COPY_ROWS_SQL`);
 *  - deleting the copy holding a play's primary row clears the others'
 *    pointers (`SetNull`): the lowest survivor is promoted, the rest re-pointed.
 * Neither moves a play's time or state, so the import's boundaries stay put.
 *
 * Writes go `REPAIR_ROWS_PER_TRANSACTION` at a time with the server row
 * `FOR NO KEY UPDATE` — not `FOR SHARE`, or a page write could move a primary
 * row onto an item this repair is giving a copy row, counting the play twice.
 * Each statement acts on the rows as they are when it runs. Between
 * transactions a cancel stops at once; the deadline or a waiting sync only
 * after one has committed.
 */
async function repairLibraryCopyRows(
  serverId: string,
  guard: TracearrMappingGuard,
  serverName: string,
  limits: LibraryCopyRepairLimits,
  repair: LibraryCopyRepair,
): Promise<void> {
  const [gate] = await prisma.$queryRawUnsafe<Array<{ found: boolean }>>(
    HAS_COPY_GROUPS_SQL,
    serverId,
  );
  if (!gate?.found) return;

  let committed = 0;
  const stopNow = (): boolean => {
    if (limits.signal?.aborted) return true;
    if (committed === 0) return false;
    if (limits.deadlineMs !== undefined && Date.now() >= limits.deadlineMs) return true;
    return limits.yieldTo?.() ?? false;
  };
  /** One transaction under the mapping guard; false when the mapping has moved. */
  const underGuard = (write: (tx: RawDb) => Promise<void>): Promise<boolean> =>
    prisma.$transaction(
      async (tx) => {
        const mapped = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "MediaServer"
            WHERE "id" = $1 AND "tracearrServerId" = $2 AND "tracearrMappingVersion" = $3
            FOR NO KEY UPDATE`,
          serverId,
          guard.tracearrServerId,
          guard.mappingVersion,
        );
        // The mapping moved: these rows are being, or have been, wiped.
        if (mapped.length === 0) return false;
        await write(tx);
        return true;
      },
      { timeout: 60_000, maxWait: 15_000 },
    );

  /** WatchHistory's statistics, refreshed at most once a run (`REPAIR_ANALYZE_MIN_ROWS`). */
  let analysed = false;
  const analyseOnce = async (rows: number): Promise<void> => {
    if (analysed) return;
    analysed = true;
    await analyseWatchHistory(serverName, rows);
  };

  // Orphans first, so the primary rows they become get their copies below.
  const orphans = await prisma.$queryRawUnsafe<Array<{ sourceEventId: string; mediaItemId: string }>>(
    ORPHAN_COPY_ROWS_SQL,
    serverId,
  );
  const byChain = new Map<string, Array<{ sourceEventId: string; mediaItemId: string }>>();
  for (const row of orphans) {
    const chain = chainOfCopyRow(row.sourceEventId);
    const rows = byChain.get(chain);
    if (rows) rows.push(row);
    else byChain.set(chain, [row]);
  }
  const orphanChains = [...byChain.keys()];
  for (let start = 0; start < orphanChains.length; ) {
    if (stopNow()) {
      repair.stopped = true;
      return;
    }
    if (orphans.length >= REPAIR_ANALYZE_MIN_ROWS) await analyseOnce(orphans.length);
    const chains: string[] = [];
    let rowCount = 0;
    while (start < orphanChains.length && (chains.length === 0 || rowCount < REPAIR_ROWS_PER_TRANSACTION)) {
      const chain = orphanChains[start++];
      chains.push(chain);
      rowCount += byChain.get(chain)!.length;
    }
    let promoted = 0;
    let repointed = 0;
    const mapped = await underGuard(async (tx) => {
      // Lowest item id first, the order `writeBatch` ranks a play's copies in
      // (plain string order), so both promote the same row.
      const candidates: CopyRowCandidate[] = [];
      for (const chain of chains) {
        const rows = byChain.get(chain)!;
        rows.sort((x, y) => (x.mediaItemId < y.mediaItemId ? -1 : x.mediaItemId > y.mediaItemId ? 1 : 0));
        rows.forEach((row, rank) => candidates.push({ chain, sourceEventId: row.sourceEventId, rank }));
      }
      promoted = await promoteLowestCopyRows(tx, serverId, candidates);

      const primaries = await tx.$queryRawUnsafe<Array<{ sourceEventId: string; mediaItemId: string }>>(
        `SELECT "sourceEventId", "mediaItemId" FROM "WatchHistory"
          WHERE "mediaServerId" = $1 AND "sourceEventId" = ANY($2)`,
        serverId,
        chains,
      );
      const primaryItem = new Map(primaries.map((row) => [row.sourceEventId, row.mediaItemId]));
      // A pointer-less copy row on the very item that holds its play's
      // primary row would count the play twice there.
      await deleteCopyRows(
        tx,
        serverId,
        chains.flatMap((chain) => {
          const item = primaryItem.get(chain);
          return item ? [copyEventId(chain, item)] : [];
        }),
      );
      const repoint: CopyRow[] = [];
      for (const chain of chains) {
        const item = primaryItem.get(chain);
        if (!item) continue;
        for (const row of byChain.get(chain)!) {
          if (row.mediaItemId === item) continue;
          repoint.push({
            id: randomUUID(),
            chain,
            sourceEventId: row.sourceEventId,
            mediaItemId: row.mediaItemId,
          });
        }
      }
      repointed = await mirrorCopyRows(tx, serverId, repoint);
    });
    if (!mapped) return;
    committed++;
    repair.promoted += promoted;
    repair.repointed += repointed;
  }

  const missing = await prisma.$transaction((tx) => readMissingCopyRows(tx, serverId), {
    timeout: 5 * 60_000,
    maxWait: 15_000,
  });
  for (let start = 0; start < missing.length; start += REPAIR_ROWS_PER_TRANSACTION) {
    if (stopNow()) {
      repair.stopped = true;
      return;
    }
    if (missing.length >= REPAIR_ANALYZE_MIN_ROWS) await analyseOnce(missing.length);
    let filled = 0;
    const mapped = await underGuard(async (tx) => {
      filled = await mirrorCopyRows(
        tx,
        serverId,
        missing.slice(start, start + REPAIR_ROWS_PER_TRANSACTION).map(({ chain, copyId }) => ({
          id: randomUUID(),
          chain,
          sourceEventId: copyEventId(chain, copyId),
          mediaItemId: copyId,
        })),
      );
    });
    if (!mapped) return;
    committed++;
    repair.filled += filled;
  }
}

/** The two raw-query methods the write path uses — the global client or a transaction's. */
type RawDb = Pick<typeof prisma, "$queryRawUnsafe" | "$executeRawUnsafe">;

/** One `INSERT … VALUES … ON CONFLICT` statement for a set of mapped rows. */
async function insertRows(
  db: RawDb,
  entries: PendingRow[],
  upsertSuffix: string,
): Promise<void> {
  const params: unknown[] = [];
  const tuples: string[] = [];
  let paramIndex = 1;

  for (const { row } of entries) {
    const placeholders = INSERT_COLUMNS.map((column) => {
      const placeholder = `$${paramIndex++}`;
      const value = row[column];
      // JSON columns were cleaned by `toJsonParam`; any other string is text (`stripNul`).
      params.push(typeof value === "string" && !JSON_COLUMNS.has(column) ? stripNul(value) : value);
      // A `Json?` column is fed JSON text (or null); Postgres needs the cast to
      // accept it, and being explicit documents the column's type at the call.
      return JSON_COLUMNS.has(column) ? `${placeholder}::jsonb` : placeholder;
    });
    tuples.push(`(${placeholders.join(",")})`);
  }

  await db.$executeRawUnsafe(
    `INSERT INTO "WatchHistory" (${INSERT_COLUMN_LIST})
     VALUES ${tuples.join(",")}
     ${upsertSuffix}`,
    ...params,
  );
}

/**
 * Drop the plays whose `MediaItem` was deleted since the run's join index was
 * built (for a library-copied play, just the deleted copies). The FK is
 * REQUIRED and the index is built once per run, so a delete meanwhile (a purge;
 * a Refresh runs outside `MAIN_QUEUE`) would abort the whole INSERT. This
 * narrows the race, not closes it: `walk()`'s catch stays the backstop.
 */
async function playsWithLiveMediaItems(
  db: RawDb,
  pending: PendingRow[],
): Promise<Array<{ pending: PendingRow; itemIds: string[] }>> {
  const itemIdsOf = (entry: PendingRow) => [entry.row.mediaItemId as string, ...entry.copyItemIds];
  const ids = [...new Set(pending.flatMap(itemIdsOf))];

  const live = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "MediaItem" WHERE "id" = ANY($1)`,
    ids,
  );
  const alive = new Set(live.map((row) => row.id));

  const plays: Array<{ pending: PendingRow; itemIds: string[] }> = [];
  for (const entry of pending) {
    // Still sorted: the resolver hands the copies over in order.
    const itemIds = itemIdsOf(entry).filter((id) => alive.has(id));
    if (itemIds.length > 0) plays.push({ pending: entry, itemIds });
  }
  return plays;
}

/** One record → its primary row, as `writeBatch` writes it, plus the copies it fans out to. */
function buildRow(
  record: TracearrHistoryRecord,
  resolved: { mediaItemId: string; copies?: string[] },
  serverId: string,
  watchedAt: Date,
  now: Date,
  /** `server_user_id` → the media server's own account name. See `resolveUsername`. */
  accountNames?: Map<string, string>,
): PendingRow {
  const username = resolveUsername(record, accountNames);
  return {
    usernameFromAccountMap: username.fromAccountMap,
    copyItemIds: resolved.copies ?? [],
    row: {
      id: randomUUID(),
      mediaItemId: resolved.mediaItemId,
      fanOutOfItemId: null,
      mediaServerId: serverId,
      serverUsername: username.name,
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
    },
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
  return JSON.stringify(withoutNul(value));
}

/**
 * Postgres refuses U+0000 in text (and `jsonb` its `\u0000` escape), so one NUL
 * in a client-reported string would fail its page on every attempt.
 */
function stripNul(text: string): string {
  return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
}

/** `stripNul` over every string, key included, of a JSON-shaped value. */
function withoutNul(value: unknown): unknown {
  if (typeof value === "string") return stripNul(value);
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [stripNul(key), withoutNul(inner)]),
    );
  }
  return value;
}

/**
 * Coerce one of Tracearr's numeric fields, which arrive in TWO JSON shapes.
 *
 * Most are JSON numbers, but the int64 ones — `progress_ms` and
 * `total_duration_ms` — are serialized as JSON **strings** (`"110500"`), the
 * usual way to keep a 64-bit integer safe from a float64 parser. Accepting only
 * numbers silently discarded both, on 2,998 of 3,000 sampled records: every row
 * in a 106,133-row import had `progressMs` and `totalDurationMs` NULL while the
 * source carried a value for essentially all of them, which left the History
 * page's "3m 40s of 42m" line permanently unrenderable.
 *
 * Nothing about the failure was visible from inside: `Number.isFinite("110500")`
 * is false so the value was dropped rather than erroring, the client's types
 * declared these `number` so TypeScript was satisfied, and every test fixture
 * passed numbers — the exact shape the API never sends for these two fields.
 */
function toNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  // A string is the int64 encoding, not a mistake. `Number("")` is 0, so an
  // empty string has to be refused explicitly or it would read as a real zero.
  const n = typeof value === "string" ? (value.trim() === "" ? NaN : Number(value)) : value;
  return Number.isFinite(n) ? n : null;
}

/** The range of a Postgres `integer`, which every `Int` column here is. */
const PG_INT_MIN = -2_147_483_648;
const PG_INT_MAX = 2_147_483_647;

/**
 * Guard the `Int` columns: round, and drop to null outside `integer`'s range —
 * one bogus value would otherwise fail its page on every attempt. A null merges
 * harmlessly (`GREATEST` ignores it, `COALESCE` keeps the stored value).
 */
function asInt(value: number | string | null | undefined): number | null {
  const n = toNumber(value);
  if (n === null) return null;
  const rounded = Math.round(n);
  return rounded < PG_INT_MIN || rounded > PG_INT_MAX ? null : rounded;
}

function asFloat(value: number | string | null | undefined): number | null {
  return toNumber(value);
}

/** A parsed timestamp, or null for a missing or unparseable one. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The username to store for a play — the media server's OWN account name, not
 * Tracearr's friendly label.
 *
 * A history record's `user.username` is Tracearr's cross-server identity name.
 * On a real Plex server it disagrees with the server's account name for most
 * users: the same person is "Nick W" in a record and "weingart" in Plex's
 * `/accounts`, and `/accounts` is exactly what the NATIVE watch-history path
 * stores. Keeping the identity name would make one human two different people
 * depending on which source a server uses, which is not cosmetic:
 *
 *  - `watchedByUser` lifecycle rules match on this string. Switch a server's
 *    source and every rule naming a user silently stops matching — no error,
 *    just a rule that quietly does nothing, including a rule that was
 *    PROTECTING content from a DELETE.
 *  - On a mixed setup (one server native, one Tracearr) the same person appears
 *    twice in the History page's user filter and splits the watch leaderboards.
 *
 * `UserAccount.username` is the server's own name for the account, bridged by
 * the `server_user_id` every record carries. Falls back to the identity name
 * when the account is unknown (a user removed from the server since the play),
 * and finally to "Unknown" — which is what the native Plex path stores for a
 * nameless account, so the two still group together.
 *
 * Returns HOW the name was resolved as well as the name itself, because a
 * fallback and a bridged name are worth different amounts on a re-delivered
 * chain and only the caller-side flag can tell them apart — the two strings can
 * be identical for accounts whose identity label matches their account name.
 * See `upsertAssignment`.
 */
function resolveUsername(
  record: TracearrHistoryRecord,
  accountNames?: Map<string, string>,
): { name: string; fromAccountMap: boolean } {
  const serverUserId = record.user?.server_user_id;
  const mapped = serverUserId ? accountNames?.get(serverUserId) : undefined;
  if (mapped) return { name: mapped, fromAccountMap: true };
  return {
    name: record.user?.username ?? "Unknown",
    fromAccountMap: false,
  };
}
