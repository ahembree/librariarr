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
  // `mediaItemId` — the join result, non-null by construction and re-resolved
  // every run, so the newest resolution wins outright.
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
   * How the backfill pass ended, when one ran. `"errored"` means the run could
   * not reach Tracearr — the caller must NOT immediately re-enqueue on it, or
   * an unreachable instance becomes a hot loop.
   */
  backfillOutcome?: WalkOutcome;
  /** Rows inserted plus rows updated across every pass this run made. */
  count: number;
  /**
   * Why the backfill pass was held back without walking, when it was. Such a
   * run reports `"exhausted"` with the backfill still pending (so the task
   * does not re-enqueue a slice that would only be held again), which on its
   * own reads as "Tracearr holds no plays for this mapping" — this says it is
   * not that:
   *  - `"awaiting-resync"`: the walk was restarted after items were deleted
   *    (`tracearrBackfillRestartedAt`) and waits for the full library sync
   *    that re-adds them, which queues the slice itself;
   *  - `"no-library-items"`: none of the server's enabled libraries holds an
   *    item, so no play could be attributed; the watch-history sync after a
   *    library sync that adds some queues the slice.
   */
  heldReason?: "awaiting-resync" | "no-library-items";
  /**
   * The backfill walk exhausted the archive and would have marked it complete,
   * but the completion write was refused — a concurrent restart
   * (`restartTracearrBackfill`) or mapping change moved the state it expected.
   * `backfillPending` is then still true with an `"exhausted"` outcome, which
   * otherwise means "Tracearr holds no plays for this mapping"; the backfill
   * task re-queues on this instead of treating it as empty.
   */
  completionLost?: boolean;
  /**
   * Older history remains un-walked, so a backfill run is still owed. Drives
   * both the job's self-re-enqueue and the UI's "still importing" state.
   */
  backfillPending: boolean;
  /**
   * Set — to a short, human reason — when the run could not do what the caller
   * asked: no enabled instance monitors the mapped server (or the one that
   * might could not be asked), or a forward walk the caller asked for could not
   * reach Tracearr. A caller reporting per-server outcomes (the History page's
   * Refresh) shows the server as failed rather than as a clean zero.
   *
   * Deliberately NOT set for a backfill refused for want of the account map on
   * a forward run, nor for a walk that stopped resumably (a cancel, a spent
   * slice, a write that raced a delete): none of those is the caller's request
   * failing.
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
      enabled: true,
      tracearrServerId: true,
      tracearrBackfillComplete: true,
      tracearrOldestPlayAt: true,
      tracearrBackfillCursorAt: true,
      tracearrForwardFloorAt: true,
      tracearrBackfillLastWalkAt: true,
      tracearrBackfillRestartedAt: true,
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
  //   FORWARD   `since = MAX(watchedAt) - overlap`  — new plays since last run
  //                                                   (or further back, to
  //                                                   `tracearrForwardFloorAt`,
  //                                                   when a forward walk was
  //                                                   interrupted).
  //   BACKFILL  `until = MIN(watchedAt)`            — keeps walking older until
  //                                                   the history is exhausted.
  //
  // `tracearrBackfillComplete` and the two cursors are the only things rows
  // cannot tell us. Everything else is derived from the rows themselves.
  const serverName = server.name;
  // Captured for the same reason as `serverName`: read inside the `walk`
  // closure, which TypeScript's control-flow analysis cannot see through.
  const ownerUserId = server.userId;
  // Bound once so the paging closure keeps the narrowed, non-null value.
  const mappedServerId = tracearrServerId;

  // What the evidence marker was when this run started, for every marker write
  // below — see `establishMarker`.
  const evidence = snapshotWatchEvidence(serverId, server.watchHistorySyncedAt);

  // The window comes first, before any network call: it decides whether this
  // run has anything to do at all, and it costs one aggregate query.
  const window = await resolveImportWindow(
    serverId,
    server.tracearrBackfillComplete,
    server.tracearrBackfillCursorAt,
    server.tracearrForwardFloorAt,
    server.tracearrBackfillLastWalkAt,
  );

  // The resume cursor as this run found it — compared against when the run
  // records how far it reached, and required to still be there when it writes
  // (see the backfill write below).
  const cursorAtStart = server.tracearrBackfillCursorAt;
  /**
   * Whether a forward pass is owed plays it never read — see
   * `tracearrForwardFloorAt`. While true the server holds a known gap, so this
   * run must not vouch for its history (the marker writes below).
   */
  let forwardFloorPending = server.tracearrForwardFloorAt != null;
  /** The floor as this run knows it — read at the start, or recorded below. */
  let knownForwardFloor = server.tracearrForwardFloorAt ?? null;

  // The stored walk state is taken at its word, rows or no rows. "Complete"
  // with nothing stored is a legitimate end state — every play the archive
  // holds can reference media that has left the library — and so is a resume
  // cursor with nothing stored above it (the newest slice held nothing
  // storable). Inferring "stale" from the absence of rows instead re-walked
  // such an archive from the top on every run, forever. The paths that DO
  // destroy the rows reset the state explicitly: a purge and disable-with-
  // delete (`restartTracearrBackfill`), a restore that did not bring the rows
  // back (`restoreBackup`), and a mapping change (the server PUT).
  let backfillComplete = server.tracearrBackfillComplete;
  // FORWARD is skipped on a first import, where there is no watermark and the
  // backfill covers everything.
  const forwardDue = wantsForward && window.since !== undefined;
  // A RESTARTED walk waits for the re-sync. `restartTracearrBackfill` runs right
  // after its callers deleted items (a purge, a restore, disable-with-delete, a
  // vanished library) whose plays the restarted walk exists to bring back — but
  // only once those items exist again. Walked before the next full library sync
  // (any playback queues a slice), their plays resolve to nothing and are
  // stepped over, and the walk can complete without them for good: the items
  // come back reading as never watched, which is what "not played in N months"
  // DELETE rules act on. The restart is recorded explicitly
  // (`tracearrBackfillRestartedAt`) and released only by a full, unscoped
  // library sync that began after it (`syncMediaServer`) — never by a
  // library-scoped one, which re-adds one library and leaves a purged other
  // one empty. Reported as `"exhausted"` with the backfill still pending and
  // `heldReason` set, so the task does not re-enqueue; the releasing sync
  // queues the slice once the items are back.
  const awaitingResync =
    wantsBackfill && !backfillComplete && server.tracearrBackfillRestartedAt != null;
  const backfillDue = wantsBackfill && !backfillComplete && !awaitingResync;
  if (awaitingResync) {
    logger.info(
      "WatchHistory",
      `Holding the Tracearr archive walk for "${server.name}" until the next full ` +
        `sync re-adds the items its restart was for`,
    );
  }

  // Nothing to do. The background backfill task is queued after EVERY forward
  // sync (it doubles as the recovery pass once the archive is walked), so on a
  // fully backfilled server this is its steady state — and it must cost one
  // query, not an instance probe, a live-import card, a progress event, a
  // whole-server join index and a `/users` walk, nor a marker withdrawal when
  // that walk happens to fail.
  if (!forwardDue && !backfillDue) {
    return {
      count: 0,
      backfillPending: !backfillComplete,
      ...(awaitingResync
        ? { backfillOutcome: "exhausted" as const, heldReason: "awaiting-resync" as const }
        : {}),
    };
  }

  // Nothing to import INTO. With no items in the server's enabled libraries —
  // a mapping saved before its libraries were enabled or first synced, or a
  // purge or restore followed by a watch-changed before the next library sync
  // — every record the walk fetches resolves to nothing, and a walk of nothing
  // but unresolvable records is indistinguishable, by the rows, from an archive
  // whose plays all reference media that has since left the library. So it
  // completed: the flag set, the resume cursor at the archive's far end and
  // `watchHistorySyncedAt` established over an empty history. Once the items
  // synced, the whole library read "nobody watched anything" — what negative
  // `watchedByUser` and `playCount = 0` DELETE rules act on — with nothing
  // left to walk the archive again.
  //
  // So the run makes no claim at all: no walk, no cursor, no completion, no
  // marker, no forward watermark (`tracearrBackfillLastWalkAt`) and no floor
  // paid. Reported like a mapping Tracearr holds no plays for — `"exhausted"`
  // with the backfill still pending — so the queued task does not re-enqueue
  // itself; the next watch-history sync, which the full library sync runs at
  // its end, queues another slice once the items are there.
  //
  // Only an EMPTY library, deliberately: a populated library whose items match
  // few or none of the records is the legitimate "the plays are of media since
  // deleted" archive, and second-guessing that would re-walk it forever. (Nor
  // does it wait for every enabled library's first full sync: a library whose
  // sync keeps failing would then hold the walk, and the server's play-activity
  // rules with it, indefinitely. In practice the walk is queued behind the
  // full sync on the serial MAIN_QUEUE, after its watch-history phase.)
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

  const resolution = await resolveTracearrInstance(
    ownerUserId,
    tracearrServerId,
    serverName,
  );
  if ("failed" in resolution) {
    return {
      count: 0,
      backfillPending: !backfillComplete,
      // A backfill that cannot even find its instance has made no progress, and
      // the queued task re-enqueues itself at once for any other outcome —
      // `"errored"` makes it back off instead of spinning.
      ...(backfillDue ? { backfillOutcome: "errored" as const } : {}),
      failed: resolution.failed,
    };
  }
  const instance = resolution.instance;

  // Report before anything slow starts. This import is run in the foreground by
  // the History page's Refresh button, and the join index — which loads every
  // candidate item on the server — is itself slow on a large library. Without
  // this the bar sits blank through it.
  onProgress?.({ imported: 0, pages: 0, detail: "Connecting to Tracearr…" });

  // From here the run is a real import, so Settings shows it as running. Forced
  // so the card appears now, not a page and a throttle window later.
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
  // An EMPTY map counts as "could not load", not as "this server has no users":
  // every history record carries a `server_user_id` belonging to *some*
  // account, so a server with plays can never legitimately have zero of them.
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
  // run. Rows commit per page, the forward window has no upper bound (after
  // downtime it can walk days of plays over minutes), and detection runs on its
  // own dispatcher — unserialised against a History-page Refresh. An end-of-run
  // withdrawal leaves the guard vouching for the server for the entire walk,
  // and a match formed in that window SURVIVES the later pause, because a
  // transient refusal preserves existing matches and pending actions and the
  // executor never re-checks evaluability before firing. Not at the START of
  // the run either: a run that writes nothing (a quiet forward window, or one
  // whose fetch failed too) has stored nothing under the wrong vocabulary, and
  // pausing every play-activity rule for it — until a later run happens to
  // release the marker — punished a transient `/users` failure for nothing.
  //
  // Conditioned on the map being UNUSABLE, not on any fallback name: a user
  // Tracearr has since removed is legitimately absent from a healthy map, and
  // that fallback is permanent and correct — pausing for it would never lift.
  //
  // Repeated before EVERY page this run writes, not only the first. A healthy
  // run overlapping this one (a scheduled job beside a Refresh) can walk the
  // floor, clear it and re-establish the marker between two of this run's
  // pages; the next page it writes is mislabelled all the same, so it has to
  // withdraw and record the floor again. Both writes are cheap, and a degraded
  // forward window is a handful of pages.
  let degradedWarned = false;
  async function withdrawBeforeDegradedWrite(since: Date | undefined): Promise<void> {
    if (accountMapUsable) return;
    await invalidateWatchHistoryEvidence([serverId]);
    // The degraded rows are re-labelled only when a later forward walk
    // re-delivers them with the map, and only a walk reaching back to this
    // one's `since` does: the next run's own window, derived from a MAX these
    // rows may have moved, can start above them. So the floor is recorded
    // whenever a degraded run writes anything — not only when a page moves the
    // watermark — and only a HEALTHY walk that exhausts may clear it.
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

  /**
   * Whether this run has already recorded the forward floor — see
   * `recordForwardFloorBeforeWrite`.
   */
  let forwardFloorRecorded = false;
  /**
   * Record, BEFORE the forward pass first moves the watermark, how far back the
   * next forward pass must reach should this one not finish.
   *
   * A forward walk goes newest → oldest, so its first committed page moves
   * `MAX(watchedAt)` to the newest play. Stopped after that (Stop, the stream's
   * lifetime cap, a 429 that outlasted the retries, an error, a crash), the
   * plays between the OLD watermark and the oldest play it reached were never
   * read — and the next run's `since`, derived from the new MAX, starts above
   * them. The backfill does not reach them either: it walks below `MIN`. Written
   * before the rows, not after the walk, so a process killed mid-walk still
   * leaves the floor behind. Only a page that carries a play newer than the
   * stored watermark can open that hole, so a steady-state run — whose window
   * is the overlap re-delivering plays already stored — writes nothing here.
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

  async function recordForwardFloor(since: Date): Promise<void> {
    forwardFloorPending = true;
    if (!knownForwardFloor || since < knownForwardFloor) knownForwardFloor = since;
    // `LEAST` (which ignores a NULL): the floor only ever moves earlier, so a
    // concurrent forward run with an older floor keeps it. Guarded on the
    // mapping like every other piece of per-archive state.
    await prisma.$executeRawUnsafe(
      `UPDATE "MediaServer"
          SET "tracearrForwardFloorAt" = LEAST("tracearrForwardFloorAt", $3)
        WHERE "id" = $1 AND "tracearrServerId" = $2`,
      serverId,
      mappedServerId,
      since,
    );
  }

  logger.info(
    "WatchHistory",
    `Importing Tracearr history for "${serverName}" from "${instance.name}" ` +
      `(${describeWindow(window, { forward: forwardDue, backfill: backfillDue })}, ` +
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

  /** Which half of a page the last `"errored"` walk failed in, for `failed`. */
  let lastWalkFailure: "fetch" | "write" | undefined;

  /**
   * Walk one window to its end, or until something stops us.
   *
   * Returns `"exhausted"` only when the keyset genuinely ran out
   * (`nextCursor === null`), and the distinction is load-bearing: it is what
   * decides whether a backfill may be marked complete (and a forward floor
   * cleared). Treating a cancelled walk as exhausted would permanently strand
   * the unread history.
   *
   * The other two outcomes decide whether the caller retries at once or backs
   * off. A fetch that throws returns `"errored"` — the instance is down or
   * refusing us, nothing about an immediate retry would differ, and the
   * backfill task backs off on it. A cancel, a spent slice, a yield, the page
   * cap, a stalled cursor and a moved mapping return `"stopped"`.
   *
   * A failed WRITE is `"stopped"` only when this walk committed a page before
   * it. The usual write failure is the FK race `rowsWithLiveMediaItems`
   * narrows but cannot close (an item deleted between its check and the
   * INSERT); the page's rows roll back with their batch, its position is not
   * kept, and the next run rebuilds the join index, skips the vanished item as
   * `unresolved` and continues — a resumable stop, and one that made progress.
   * But a write that fails on the walk's FIRST page made none, and a page that
   * cannot be stored at all (a value the column rejects, a transaction
   * timeout) fails the same way on every attempt: the next slice resumes at
   * the same position, fetches the same page and fails again. Read as
   * `"stopped"`, the backfill task re-queued that identical slice at once,
   * forever — re-building the join index and re-walking `/users` each time.
   * `"errored"` makes it back off and, after its attempts, park.
   */
  async function walk(
    pass: ImportPass,
    options: { since?: Date; until?: Date },
  ): Promise<WalkOutcome> {
    /** Which half of a page the walk is in, and how many pages it committed. */
    const progress: WalkProgress = { phase: "fetch", committedPages: 0 };
    return walkPages(pass, options, progress).catch((error: unknown) => {
      const phase = progress.phase;
      // The mapping moved under this run (the server PUT re-pointed or unlinked
      // it and wiped the rows). Nothing of this source may be written any more;
      // the next run reads the new mapping. A clean stop, not a failure to reach
      // Tracearr, so the backfill task re-queues instead of backing off.
      if (error instanceof TracearrMappingChangedError) {
        logger.info(
          "WatchHistory",
          `Tracearr history import for "${serverName}" stopped after ${pages} page(s) — ` +
            `the server's watch-history source changed while it ran`,
        );
        return "stopped" as const;
      }
      // Cancelled while a request was in flight: the HTTP call rejects with the
      // abort. Still the user's Stop, not Tracearr failing.
      if (signal?.aborted) return "stopped" as const;
      // Never thrown to the job runner as a failed sync: everything already
      // written is committed and correct, and the next run resumes from the
      // boundary those rows (and the cursors) establish.
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
    // Per-walk, NOT per-run. The two passes are independent walks whose windows
    // can overlap — `until = MIN(watchedAt)` sits inside `since = MAX - 1h`
    // whenever the stored history spans less than an hour, which is exactly the
    // state an import interrupted after a page or two leaves behind. A shared
    // set then lets the backfill collide with a cursor the forward pass already
    // recorded and bail as "the cursor stopped advancing" — failing safe (it is
    // never marked complete) but advancing only one page per run, which for a
    // large library is indistinguishable from being stuck.
    const seenCursors = new Set<string>();
    for (;;) {
      // Cancelled (client disconnected, user hit Stop, or the stream's lifetime
      // cap fired). Break rather than throw: everything written so far is
      // committed and correct, and the watermark it establishes is what makes
      // the next run resume from here.
      // Slice exhausted. Like a cancel this is a clean stop on a committed
      // page boundary, and like a cancel it must NOT count as "exhausted" —
      // the backfill is unfinished and another run is owed.
      if (
        deadlineMs !== undefined &&
        Date.now() >= deadlineMs &&
        // ...but never before this walk has fetched anything. The slice's
        // budget is also spent on the join index and the one-time oldest-play
        // measurement, so a deadline checked blindly could let a run finish
        // having fetched zero pages — and then re-enqueue, having made no
        // progress at all. Guaranteeing one page per walk makes termination
        // an argument rather than a hope. Per-WALK, because `pages` is shared
        // across the two passes.
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
        // "stopped", never "exhausted": a cancelled backfill has NOT seen the
        // whole history, and marking it complete here is exactly the bug this
        // two-pass design exists to prevent.
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
        // A bulk walk needs a larger 429 budget than a one-off call: the
        // limiter is a rolling 1-minute window and a first import is thousands
        // of sequential requests, so it WILL be throttled and should wait the
        // window out rather than abandon the run.
        bulk: true,
        signal,
      });
      pages++;
      pagesThisWalk++;
      // Recorded before any filtering: this only answers "did the mapping
      // return history at all", which is what separates a genuinely exhausted
      // archive from a mapping pointing at the wrong Tracearr server.
      if (page.records.length > 0) walked.sawAnyRecord = true;

      const rows: PendingRow[] = [];
      const now = new Date();
      /** Oldest instant on THIS page; folded in only once the page is written. */
      let pageOldest: Date | null = null;
      /** Newest instant on THIS page — whether writing it moves the watermark. */
      let pageNewest: Date | null = null;

      // Chain ids seen in THIS page. One INSERT statement may not touch the
      // same conflicting row twice ("ON CONFLICT DO UPDATE command cannot
      // affect row a second time" aborts the whole statement), and a page's
      // rows go out in one statement — so statement scope is all this needs.
      //
      // It used to be run-scoped, which quietly made memory grow with the size
      // of the history: a 160k-play first import held 160k uuid strings for the
      // whole walk. A chain re-delivered on a LATER page lands in a different
      // statement, where ON CONFLICT DO UPDATE handles it correctly anyway —
      // that is the merge path, not a duplicate.
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
        // Collected per page, not applied yet — see the commit below. Every
        // record's instant counts, storable or not (`tracearrBackfillCursorAt`
        // explains why advancing only on stored rows live-locks), but a page
        // whose write THROWS must not advance anything: those records were
        // never persisted, and moving the cursor past them would skip them
        // permanently on the next run.
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
        rows.push(
          buildRow(
            record,
            resolved.mediaItemId,
            serverId,
            watchedAt,
            now,
            accountNames,
          ),
        );
      }

      // Write this page's rows before fetching the next one. The model is
      // append/upsert-only, so a failure on a later page leaves these durably
      // imported rather than rolling back the run.
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
          mappedServerId,
          rows.slice(i, i + BATCH_SIZE),
        );
        counters.inserted += written.inserted;
        counters.updated += written.updated;
        counters.vanished += written.vanished;
      }

      // The page is committed, so its position is now safe to keep. Doing this
      // after the writes is what makes a mid-page failure re-walked rather
      // than silently skipped.
      progress.committedPages++;
      if (
        pageOldest &&
        (!walked.oldestSeenAt || pageOldest < walked.oldestSeenAt)
      ) {
        walked.oldestSeenAt = pageOldest;
      }

      // Tell any watching client the readout moved. Emitted AFTER the page
      // commits, so a listener that refetches can never read a figure this
      // run has not durably written — and after the live counters are
      // updated, for the same reason.
      recordTracearrImportPage(importRun, {
        pass,
        pages,
        imported: counters.inserted + counters.updated,
        oldestReached: walked.oldestSeenAt,
      });
      emitImportProgress(ownerUserId, serverId);

      // Report per page, as the rows land — this is the slow path the whole
      // progress feature exists for, and a first import runs for minutes.
      //
      // Deliberately NO `fraction`: `/api/v2/public/history` is keyset-
      // paginated and its `CursorMeta` carries only `nextCursor` and
      // `pageSize`, so there is no total to divide by and no count endpoint to
      // ask. Any percentage here would be invented, so the UI renders an honest
      // indeterminate bar plus this live count instead — see the determinacy
      // note on `WatchHistoryProgress`.
      onProgress?.({
        imported: counters.inserted + counters.updated,
        pages,
        detail: progressDetail(counters, pages, pass),
      });

      const next = page.nextCursor;
      // The keyset is exhausted: this pass has seen the whole window.
      // For a backfill that is precisely the signal that the history has
      // been walked to its oldest play.
      if (!next) return "exhausted";
      if (seenCursors.has(next)) {
        // A cursor we have already followed means the keyset is not advancing;
        // continuing would page forever over the same records.
        logger.warn(
          "WatchHistory",
          `Tracearr history import for "${serverName}" stopped after ${pages} page(s) — ` +
            `the cursor stopped advancing`,
        );
        return "stopped";
      }
      seenCursors.add(next);
      cursor = next;
    }
  }

  // FORWARD pass: new plays since the last run — reaching back to the forward
  // floor when an earlier forward walk was interrupted.
  //
  // Only with a usable account map does it reach past the ordinary window:
  // without it the walk writes identity labels, and the fewer of those the
  // better. Whatever it does write is re-labelled later — the degraded run
  // records its own `since` as the floor (`withdrawBeforeDegradedWrite`), and
  // the next healthy run walks back to it, where a bridged name overwrites the
  // fallback (`upsertAssignment`).
  let forwardOutcome: WalkOutcome | undefined;
  let failed: string | undefined;
  if (forwardDue) {
    const forwardStartedAt = new Date();
    const since = (accountMapUsable ? window.since : window.baseSince) as Date;
    forwardOutcome = await walk("forward", { since });

    // Only a HEALTHY walk pays anything off. A degraded one has read its
    // window, but what it stored there is mislabelled, and clearing the floor
    // it just recorded would leave those rows outside every later window.
    if (forwardOutcome === "exhausted" && accountMapUsable) {
      // The whole window down to `since` has been read, so any floor at or
      // after it is paid. Compare-and-set on that, so a floor an overlapping
      // run pushed further back is not erased by a walk that never reached it.
      if (forwardFloorPending && knownForwardFloor && since <= knownForwardFloor) {
        forwardFloorPending = !(await clearForwardFloor(
          serverId,
          mappedServerId,
          since,
        ));
      }
      // A walked archive with no stored rows has no `MAX(watchedAt)` to carry
      // the forward watermark, so `tracearrBackfillLastWalkAt` carries it (see
      // `resolveImportWindow`). Advanced to when THIS walk started, and only if
      // nothing reset it meanwhile — otherwise the forward window would grow
      // without bound for as long as nothing is storable.
      if (!window.hasRows && backfillComplete) {
        await persistMappedState(
          serverId,
          mappedServerId,
          serverName,
          { tracearrBackfillLastWalkAt: forwardStartedAt },
          {
            tracearrBackfillComplete: true,
            tracearrBackfillLastWalkAt: server.tracearrBackfillLastWalkAt,
          },
        );
      }
    } else if (forwardOutcome === "errored") {
      failed =
        lastWalkFailure === "write"
          ? "New plays from Tracearr could not be stored"
          : "Tracearr could not be reached while importing new plays";
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
  // An EMPTY map counts as "could not load" (`accountMapUsable`), not as "this
  // server has no users" — every history record carries a `server_user_id`
  // belonging to *some* account. A walk of `/users` cut short (its page cap, a
  // repeated cursor, a malformed page) throws in the client rather than handing
  // back the accounts it happened to reach: a PARTIAL map is non-empty, so it
  // passed this gate and stored every play of the accounts it missed under
  // identity labels for good.
  if (backfillDue && !accountMapUsable) {
    logger.warn(
      "WatchHistory",
      `Skipping the Tracearr archive walk for "${serverName}" — the account-name ` +
        `map could not be loaded, and importing older plays without it would ` +
        `permanently store them under Tracearr's identity names. The next run ` +
        `resumes the backfill from where it stands.`,
    );
    // Reported as a reach-Tracearr failure on purpose: the queued backfill task
    // re-enqueues itself immediately for any other outcome, and a run that
    // cannot load the map has made no progress — it would spin against an
    // instance that is already failing. `"errored"` is what makes the worker
    // back off instead.
    backfillOutcome = "errored";
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
            mappedServerId,
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

    const outcome = await walk("backfill", { until: window.until });
    backfillOutcome = outcome;

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

    // "Exhausted" alone is not enough to declare the archive imported: a walk
    // whose very first page comes back `{ records: [], nextCursor: null }` is
    // exhausted too, and that is what a freshly-installed Tracearr with no
    // retained history looks like — or, before the instance was verified to
    // monitor the mapping (`resolveTracearrInstance`), a mapping pointing at the
    // wrong instance. Writing completion there would mark history established
    // on a server whose native history the mapping change had already wiped,
    // handing the evaluability guard a clean bill of health for an empty
    // relation — `watchedByUser` negatives then match the entire library.
    //
    // Rows from ANY run count, not just this one, and this is deliberately NOT
    // tightened to "this walk saw a record". With the instance verified, an
    // empty answer to a RESUMED walk is the archive's end: `until` is inclusive
    // and is a play this mapping delivered before (the oldest stored row, or the
    // cursor the walk recorded), so a correctly-mapped instance re-delivers it
    // unless Tracearr has since pruned everything at and below it — in which
    // case there is genuinely nothing older to import. Refusing completion there
    // would re-walk an empty stretch every slice and keep the server's
    // play-activity rules paused forever. A resumed slice also legitimately
    // stores nothing when the remaining stretch is all unstorable.
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

    // Recorded for every walk that actually ran — exhausted or stopped, not
    // one that could not reach Tracearr — so the status readout can tell a
    // mapping never walked yet from one walked that found nothing to import.
    const walkRan = outcome !== "errored";

    if (cursorAdvanced || finished || walkRan) {
      // Only if nothing restarted the walk while this slice ran. A purge
      // restarts it by moving the cursor (`restartTracearrBackfill`), and this
      // slice's progress — or its "finished" — describes rows the purge has
      // since removed; written over the restart, the walk would resume deep in
      // the archive and never re-import the newer stretch.
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
      // Established: the archive has been walked to its oldest play, so
      // play-activity criteria can be answered faithfully again. The marker is
      // written with the completion flag in the SAME guarded statement, so it
      // can never land without it — unless a forward walk is still owed plays
      // (`tracearrForwardFloorAt`, a known gap; the release below writes it once
      // a forward walk pays the floor), or the marker was withdrawn while this
      // run walked (`establishMarker`). Then the flag is written on its own.
      if (finished && !forwardFloorPending) {
        const attempt = await establishMarker(
          evidence,
          mappedServerId,
          expect,
          state,
        );
        stored = attempt.written;
        markerWritten = attempt.established;
      }
      if (!stored) {
        stored = await persistMappedState(
          serverId,
          mappedServerId,
          serverName,
          state,
          expect,
        );
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
  // Never while a forward floor is pending: an interrupted forward walk left
  // plays between the floor and the newest stored ones unread — not a stale
  // view but a hole, which is exactly what "established" must not cover. The
  // write also requires the floor to be clear IN THE ROW, so a floor an
  // overlapping forward run recorded meanwhile holds it off too.
  //
  // And never over a withdrawal made while this run walked. A Refresh that
  // could not load the account map withdraws the marker before each page it
  // writes under identity labels; a healthy job finishing beside it must not
  // put the marker straight back over those rows — `establishMarker` is the
  // same compare-and-set the native path uses.
  if (
    !markerWritten &&
    backfillComplete &&
    accountMapUsable &&
    !forwardFloorPending
  ) {
    await establishMarker(evidence, mappedServerId, { tracearrBackfillComplete: true }, {});
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
    // Under the same mapping guard as every write, because by now the run may
    // be minutes old. A backfill slice that started before the admin unlinked
    // the server — and before a native Refresh refilled its history — would
    // otherwise delete that fresh native history the moment it finished: the
    // unlink's wipe already removed this run's own rows, so nothing of this
    // source is left to justify the DELETE.
    {
      const purged = await deleteNativeStratum(serverId, mappedServerId);
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
    ...(awaitingResync ? { heldReason: "awaiting-resync" as const } : {}),
    ...(completionLost ? { completionLost } : {}),
    ...(failed ? { failed } : {}),
  };
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
 * A SINGLE enabled instance is probed too. Taken on trust, an instance that
 * does not monitor the mapping (re-pointed at another Tracearr, or that
 * Tracearr's server was removed and re-added under a new id) answers every
 * history request with `{ records: [], nextCursor: null }` — an exhausted
 * keyset. The backfill then marked itself complete on a server that already
 * held rows from earlier, and every later run re-established
 * `watchHistorySyncedAt` over a history that had stopped advancing. One
 * `listServers()` per run is the price.
 *
 * An instance that cannot be reached is skipped rather than treated as "does
 * not own it" — so a transient outage on instance A cannot silently hand the
 * mapping to instance B — and when none answers for the mapping the result says
 * which of the two it was, for the caller's failure report.
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
 * `resolveTracearrInstance`, reduced to the instance or null. Exported for the
 * recovery pass in `tracearr-backfill-additions.ts`, which needs a client for
 * the same instance and must not re-derive "which Tracearr owns this server"
 * with its own, subtly different rule.
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
 * could not reach Tracearr would otherwise hot-loop.
 */
type WalkOutcome = "exhausted" | "stopped" | "errored";

/** A walk's position, shared with its error handler — see `walk`. */
interface WalkProgress {
  phase: "fetch" | "write";
  /** Pages this walk fetched AND wrote. */
  committedPages: number;
}

/**
 * The two independent boundaries a run may walk, derived from the rows we hold.
 *
 * `since` (forward) is absent on a first import — there is nothing to catch up
 * to. `until` (backfill) is absent on a first import too, meaning "start at the
 * newest play and walk back until the history runs out".
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
 * Whether any of the server's ENABLED libraries holds an item — the gate in
 * `runTracearrImport` against walking an archive into an empty library. One
 * indexed EXISTS. Enabled only: a disabled library is skipped by the full sync,
 * so items left there say nothing about whether the libraries it does sync
 * have been. Holding the walk back fails closed: nothing is stored or claimed,
 * and while the backfill is owed the server's play-activity rules stay paused.
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
 * The backfill boundary is `MIN(watchedAt)` over the server's TRACEARR rows —
 * the oldest play we have stored — and `until` is inclusive, so the boundary
 * play is re-delivered and merged by the upsert rather than skipped.
 *
 * Deriving it from the rows rather than persisting a cursor is deliberate: the
 * rows ARE the record of what was imported, so the two can never disagree. It
 * is conservative in the safe direction — a page whose records were all skipped
 * (unjoinable, wrong server, under Tracearr's 2-minute floor) leaves `MIN`
 * where it was, so the next run re-walks that stretch instead of stepping over
 * unimported history.
 */
async function resolveImportWindow(
  serverId: string,
  backfillComplete: boolean,
  cursorAt: Date | null,
  forwardFloorAt: Date | null,
  lastWalkAt: Date | null,
  now: number = Date.now(),
): Promise<ImportWindow> {
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
  // The stored walk state is trusted as it stands, rows or no rows — see the
  // caller. A walk can reach the end of an archive having stored nothing, and
  // a resume cursor can sit below a stretch that held nothing storable; both
  // are real states, and the paths that destroy rows reset the state
  // explicitly rather than leaving it for this function to guess at.
  //
  // With no rows there is no `MAX(watchedAt)` to put the forward watermark on,
  // and a walked archive with nothing stored still owes the forward pass every
  // play made since. `tracearrBackfillLastWalkAt` stands in: the last slice of
  // the walk (or the last forward walk of such an archive) read everything up
  // to then, and the open-chain lookback below it covers both a chain still
  // open at that instant and the slices the walk took before its last one.
  const baseSince = hasRows
    ? resolveSince(agg.maxWatchedAt, agg.oldestOpenChain, now)
    : backfillComplete && lastWalkAt
      ? new Date(Math.min(lastWalkAt.getTime() - OPEN_CHAIN_LOOKBACK_MS, now))
      : undefined;
  // The forward floor applies AFTER `resolveSince`'s clamps on purpose. The
  // 7-day `OPEN_CHAIN_LOOKBACK_MS` floor exists so an abandoned chain cannot pin
  // the window; a forward floor is a known hole of unread plays, and clamping
  // it would re-open exactly the gap it records whenever the walk that left it
  // stopped more than a week ago.
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
    until: backfillComplete ? undefined : (cursorAt ?? agg.minWatchedAt ?? undefined),
    hasRows,
  };
}

/** One-line description of the run's plan, for the log. */
function describeWindow(
  window: ImportWindow,
  due: { forward: boolean; backfill: boolean },
): string {
  const parts: string[] = [];
  if (due.forward && window.since) {
    parts.push(`new plays since ${window.since.toISOString()}`);
  }
  if (due.backfill) {
    parts.push(
      window.until
        ? `backfilling older than ${window.until.toISOString()}`
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
 * Every column here describes ONE Tracearr archive: where its history starts,
 * how far back this walk reached, and whether the walk ever hit the far end. A
 * slice reads `tracearrServerId` at the top and finishes minutes later, and in
 * between the admin can re-point the server at a different Tracearr (or unlink
 * it). The server PUT handles that correctly — it wipes the rows and resets
 * these three columns — so an unguarded write here lands AFTER the reset and
 * re-describes the NEW mapping with the OLD one's progress. The next import
 * then reads `tracearrBackfillComplete: true`, fetches only new plays, and the
 * new source's entire archive is never imported: a permanent, silent data loss
 * that no later run corrects, because the flag is the only thing rows cannot
 * re-derive.
 *
 * `updateMany` rather than `update` so the mapping can sit in the WHERE clause:
 * the check and the write are then one statement and there is no window between
 * them, and a mapping that moved simply matches no row.
 */
async function persistMappedState(
  serverId: string,
  tracearrServerId: string,
  serverName: string,
  data: MappedStateData,
  /** Further column values the row must still hold for the write to apply. */
  expect: MappedStateExpect = {},
): Promise<boolean> {
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: serverId, tracearrServerId, ...expect },
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


/**
 * Re-establish `watchHistorySyncedAt` for a Tracearr-sourced server, together
 * with `state` in the same statement.
 *
 * Every Tracearr marker write goes through here, and each is conditional on
 * all of:
 *
 *  - the mapping this run walked (`persistMappedState`'s reason);
 *  - no forward floor IN THE ROW — a known hole, possibly recorded by an
 *    overlapping run after this one read the row;
 *  - `expect` (the completion write's cursor compare-and-set, or "complete");
 *  - the marker still holding the value this run started with, and no
 *    withdrawal counted since — the same two checks as the native path's
 *    `markWatchHistoryEstablishedIfUnchanged`. Unconditional, a healthy job
 *    finishing beside a Refresh that could not load the account map put the
 *    marker straight back over the rows that Refresh had just written under
 *    identity labels, and play-activity rules went on matching against them.
 *
 * A withdrawal counted between the write and the re-check is undone by
 * putting the marker back to null, exactly as the native helper does; `state`
 * stays written, since it describes the walk, not the evidence.
 *
 * `written` says whether the row was updated at all (so a caller whose `state`
 * matters can fall back to writing it alone), `established` whether the marker
 * stands.
 */
async function establishMarker(
  evidence: WatchEvidenceSnapshot,
  tracearrServerId: string,
  expect: MappedStateExpect,
  state: MappedStateData,
): Promise<{ written: boolean; established: boolean }> {
  if (evidenceWithdrawnSince(evidence)) return { written: false, established: false };
  const now = new Date();
  const { count } = await prisma.mediaServer.updateMany({
    where: {
      id: evidence.serverId,
      tracearrServerId,
      tracearrForwardFloorAt: null,
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

/**
 * Whether a withdrawal has been counted for the server since `evidence` was
 * taken. The counters are private to `watch-evidence.ts`; a fresh snapshot
 * carries their current value.
 */
function evidenceWithdrawnSince(evidence: WatchEvidenceSnapshot): boolean {
  return (
    snapshotWatchEvidence(evidence.serverId, evidence.marker).generation !==
    evidence.generation
  );
}

/**
 * Clear the forward floor once a forward walk has read its whole window down
 * to `since`. Called only while a floor is known to be set. Compare-and-set on
 * the floor being at or after `since`: a floor an overlapping run pushed
 * further back than this walk reached is still owed, and so is everything when
 * the mapping moved. Returns whether this write cleared it.
 */
async function clearForwardFloor(
  serverId: string,
  tracearrServerId: string,
  since: Date,
): Promise<boolean> {
  const { count } = await prisma.mediaServer.updateMany({
    where: {
      id: serverId,
      tracearrServerId,
      tracearrForwardFloorAt: { gte: since },
    },
    data: { tracearrForwardFloorAt: null },
  });
  return count > 0;
}

/**
 * Delete the server's NATIVE rows, but only while it is still mapped to the
 * Tracearr server this run imported from — see the caller. `FOR SHARE` makes
 * the check and the DELETE one unit against the server PUT, exactly as in
 * `writeBatch`. Returns how many rows went.
 */
async function deleteNativeStratum(
  serverId: string,
  tracearrServerId: string,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const mapped = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "MediaServer"
        WHERE "id" = $1 AND "tracearrServerId" = $2
        FOR SHARE`,
      serverId,
      tracearrServerId,
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
 * that filter is not repeated here; everything else — the per-statement chain-id
 * de-dup, the timestamp guard, the join resolution and the batching — is shared.
 */
export async function importTracearrRecords(
  serverId: string,
  records: TracearrHistoryRecord[],
  joinIndex: TracearrJoinIndex,
  /** See `resolveUsername` — without this the pass stores the wrong vocabulary. */
  accountNames: Map<string, string> | undefined,
  /**
   * The Tracearr server the records were fetched from. Every write checks the
   * media server is still mapped to it — see `writeBatch`.
   */
  tracearrServerId: string,
): Promise<{ inserted: number; updated: number; skipped: number }> {
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
    rows.push(
      buildRow(record, resolved.mediaItemId, serverId, watchedAt, now, accountNames),
    );
  }

  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const written = await writeBatch(
      serverId,
      tracearrServerId,
      rows.slice(i, i + BATCH_SIZE),
    );
    inserted += written.inserted;
    updated += written.updated;
  }

  return { inserted, updated, skipped };
}

/**
 * Upsert one batch, reporting how many rows were new and how many were dropped
 * because their `MediaItem` had gone.
 *
 * The chain-id pre-check is what makes "N new, M updated" honest: an
 * `ON CONFLICT DO UPDATE` rowcount counts inserts and updates alike, and the
 * split is worth knowing — a run that is all updates means resume chains are
 * settling, not that nothing happened. `(mediaServerId, sourceEventId)` is
 * unique, so the lookup is a single index probe per batch.
 */
async function writeBatch(
  serverId: string,
  tracearrServerId: string,
  pending: PendingRow[],
): Promise<{ inserted: number; updated: number; vanished: number }> {
  if (pending.length === 0) return { inserted: 0, updated: 0, vanished: 0 };

  return prisma.$transaction(async (tx) => {
    // Still mapped to the Tracearr server these rows came from? A run reads
    // the mapping once and writes for minutes; the server PUT re-points or
    // unlinks it and then wipes the server's rows. `FOR SHARE` makes the check
    // and the insert one unit against that PUT: its UPDATE of this row waits
    // for this transaction, so either these rows land before the mapping moves
    // (and the PUT's wipe removes them), or the check sees the new mapping and
    // nothing is written. Checked any later and a stale source's plays outlive
    // the wipe.
    const mapped = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "MediaServer"
        WHERE "id" = $1 AND "tracearrServerId" = $2
        FOR SHARE`,
      serverId,
      tracearrServerId,
    );
    if (mapped.length === 0) throw new TracearrMappingChangedError(serverId);

    const batch = await rowsWithLiveMediaItems(tx, pending);
    const vanished = pending.length - batch.length;
    // Nothing survived the check. `INSERT … VALUES` with no tuples is a syntax
    // error, not a no-op, so there is no statement to send at all.
    if (batch.length === 0) return { inserted: 0, updated: 0, vanished };

    const eventIds = batch.map((entry) => entry.row.sourceEventId as string);
    const existing = await tx.$queryRawUnsafe<
      Array<{ sourceEventId: string }>
    >(
      `SELECT "sourceEventId" FROM "WatchHistory"
        WHERE "mediaServerId" = $1 AND "sourceEventId" = ANY($2)`,
      serverId,
      eventIds,
    );
    const updated = existing.length;

    // Split by username confidence: the merge rule for that one column differs
    // between the two classes and a statement carries a single `ON CONFLICT`
    // clause. One of the groups is normally empty — a run that loaded the map
    // bridges every account the server still has — so this stays one statement
    // in the ordinary case and becomes two only on a page that mixes a bridged
    // account with a departed one.
    const bridged = batch.filter((entry) => entry.usernameFromAccountMap);
    const fallback = batch.filter((entry) => !entry.usernameFromAccountMap);

    if (bridged.length > 0) {
      await insertRows(tx, bridged, WATCH_HISTORY_UPSERT_SUFFIX);
    }
    if (fallback.length > 0) {
      await insertRows(tx, fallback, WATCH_HISTORY_UPSERT_SUFFIX_FALLBACK_USERNAME);
    }

    return { inserted: batch.length - updated, updated, vanished };
  });
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
      // The JSON columns were cleaned structurally in `toJsonParam`; every other
      // string is a text column — see `stripNul`.
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
 * Drop the rows whose `MediaItem` has been deleted since this run's join index
 * was built.
 *
 * `WatchHistory.mediaItem` is a REQUIRED FK, and the index that resolved these
 * ids is built ONCE per run — on a backfill slice that is minutes before the
 * last page is written. Anything that deletes an item in between (a full sync's
 * stale purge, the incremental sync's removal path, the manual purge route)
 * leaves a batch pointing at a row that no longer exists, and a single such row
 * aborts the whole INSERT on a foreign-key violation. That is reachable in
 * practice rather than theoretical: the History page's Refresh runs inside a
 * request, outside the serial `MAIN_QUEUE` that otherwise keeps the heavy jobs
 * from overlapping a sync.
 *
 * **This narrows the race; it does not close it.** An item deleted in the
 * microseconds between this SELECT and the INSERT still violates the FK. What
 * changes is the size of the window — from "any moment in the whole run" down to
 * "one query" — and therefore how often the failure is hit at all. The residual
 * case stays self-healing exactly as it was: `walk()`'s catch keeps every page
 * already committed, returns `"stopped"`, and the next run rebuilds the index
 * and skips the now-absent item as `unresolved`. The cost that pre-checking
 * avoids is that recovery burning the rest of a five-minute backfill slice.
 *
 * Cheap enough to run per batch: the distinct ids of ~180 rows probed against
 * the primary key in one round-trip. The overwhelmingly common answer is "all of
 * them still exist", which hands back the caller's own array untouched.
 */
async function rowsWithLiveMediaItems(
  db: RawDb,
  pending: PendingRow[],
): Promise<PendingRow[]> {
  const ids = [
    ...new Set(pending.map((entry) => entry.row.mediaItemId as string)),
  ];

  const live = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "MediaItem" WHERE "id" = ANY($1)`,
    ids,
  );

  if (live.length === ids.length) return pending;

  const alive = new Set(live.map((row) => row.id));
  return pending.filter((entry) => alive.has(entry.row.mediaItemId as string));
}

/** One record → one row, in the shape `writeBatch` serializes. */
function buildRow(
  record: TracearrHistoryRecord,
  mediaItemId: string,
  serverId: string,
  watchedAt: Date,
  now: Date,
  /** `server_user_id` → the media server's own account name. See `resolveUsername`. */
  accountNames?: Map<string, string>,
): PendingRow {
  const username = resolveUsername(record, accountNames);
  return {
    usernameFromAccountMap: username.fromAccountMap,
    row: {
      id: randomUUID(),
      mediaItemId,
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
 * Postgres refuses U+0000 anywhere in text, and `jsonb` refuses its `\u0000`
 * escape too, so one NUL in a device name or a codec detail fails the whole
 * statement — on every attempt, since the record never changes. Media servers
 * pass through client-reported strings verbatim, so it is not hypothetical.
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
 * Guard the `Int` columns. Rounded, because the spec types these as integers
 * but a fractional value would abort the whole INSERT; and dropped to null
 * outside the column's range, for the same reason. The millisecond fields are
 * int64 on Tracearr's side (that is why they arrive as strings) and `integer`
 * here, which tops out at ~24.8 days — far beyond any real play, but one bogus
 * value from a media server would otherwise fail its page on every attempt, and
 * the walk can never step past a page it cannot write. A value no real play has
 * is not worth keeping either, and a null merges harmlessly (`GREATEST` ignores
 * it, `COALESCE` keeps the stored value).
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
