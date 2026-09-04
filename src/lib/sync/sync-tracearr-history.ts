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
   * Older history remains un-walked, so a backfill run is still owed. Drives
   * both the job's self-re-enqueue and the UI's "still importing" state.
   */
  backfillPending: boolean;
}

export async function syncTracearrHistory(
  serverId: string,
  options: TracearrImportOptions = {},
): Promise<TracearrImportResult> {
  const { onProgress, signal, passes = "both", deadlineMs } = options;
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

  const instance = await resolveInstanceForServer(
    server.userId,
    tracearrServerId,
    server.name,
  );

  if (!instance) return { count: 0, backfillPending: false };

  // Report before anything slow starts. This import is run in the foreground by
  // the History page's Refresh button, and two things happen before the first
  // page is even requested: the watermark aggregate, and the join index — which
  // loads every candidate item on the server and is itself slow on a large
  // library. Without this the bar sits blank through both.
  onProgress?.({ imported: 0, pages: 0, detail: "Connecting to Tracearr…" });

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
  //   FORWARD   `since = MAX(watchedAt) - overlap`  — new plays since last run.
  //   BACKFILL  `until = MIN(watchedAt)`            — keeps walking older until
  //                                                   the history is exhausted.
  //
  // `tracearrBackfillComplete` is the only thing rows cannot tell us: whether a
  // previous walk ever reached the end. Everything else is derived from the
  // rows themselves.
  const serverName = server.name;
  // Bound once so the paging closure keeps the narrowed, non-null value.
  const mappedServerId = tracearrServerId;
  const window = await resolveImportWindow(
    serverId,
    server.tracearrBackfillComplete,
    server.tracearrBackfillCursorAt,
  );
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

  logger.info(
    "WatchHistory",
    `Importing Tracearr history for "${server.name}" from "${instance.name}" ` +
      `(${describeWindow(window)}, ${joinIndex.itemCount} candidate items)`,
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

  /**
   * Walk one window to its end, or until something stops us.
   *
   * Returns `"exhausted"` only when the keyset genuinely ran out
   * (`nextCursor === null`). Every other exit — cancelled, page cap, a stalled
   * cursor, or a fetch/write error — returns `"stopped"`, and the distinction
   * is load-bearing: it is what decides whether a backfill may be marked
   * complete. Treating a cancelled walk as exhausted would permanently strand
   * the unread older history.
   */
  async function walk(
    pass: ImportPass,
    options: { since?: Date; until?: Date },
  ): Promise<WalkOutcome> {
    let cursor: string | undefined;
    /** Pages fetched by THIS walk — see the deadline guard below. */
    let pagesThisWalk = 0;
    // Per-walk, NOT per-run. The two passes are independent walks whose windows
    // can overlap — `until = MIN(watchedAt)` sits inside `since = MAX - 1h`
    // whenever the stored history spans less than an hour, which is exactly the
    // state an import interrupted after a page or two leaves behind. A shared
    // set then lets the backfill collide with a cursor the forward pass already
    // recorded and bail as "the cursor stopped advancing" — failing safe (it is
    // never marked complete) but advancing only one page per run, which for a
    // large library is indistinguishable from being stuck.
    const seenCursors = new Set<string>();
    try {
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
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const written = await writeBatch(serverId, rows.slice(i, i + BATCH_SIZE));
          counters.inserted += written.inserted;
          counters.updated += written.updated;
          counters.vanished += written.vanished;
        }

        // The page is committed, so its position is now safe to keep. Doing this
        // after the writes is what makes a mid-page failure re-walked rather
        // than silently skipped.
        if (
          pageOldest &&
          (!walked.oldestSeenAt || pageOldest < walked.oldestSeenAt)
        ) {
          walked.oldestSeenAt = pageOldest;
        }

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
    } catch (error) {
      // A fetch or write failure must never reach the job runner as a failed
      // sync: everything already written is committed and correct, and the next
      // run resumes from the boundary those rows establish.
      logger.warn(
        "WatchHistory",
        `Tracearr history import for "${serverName}" stopped early after ${pages} page(s) — ` +
          `keeping the ${counters.inserted + counters.updated} row(s) already imported`,
        { error: String(error) },
      );
      return "errored";
    }
  }

  // FORWARD pass: new plays since the last run. Skipped on a first import,
  // where there is no watermark and the backfill below covers everything.
  const wantsForward = passes === "forward" || passes === "both";
  const wantsBackfill = passes === "backfill" || passes === "both";

  if (wantsForward && window.since) {
    await walk("forward", { since: window.since });
  }

  // BACKFILL pass: keep walking older until the history is exhausted. This is
  // the one that survives an interruption — `until` is derived from the OLDEST
  // row we hold, so a run that died halfway through 2021 picks up there instead
  // of resuming at "now" and calling it done.
  // `complete` with no stored rows is a contradiction — the rows are what the
  // flag describes. It means something removed them out from under the flag (a
  // manual delete, a partial restore), so treat it as never-backfilled and let
  // the pass below rebuild from scratch rather than importing nothing forever.
  let backfillComplete = server.tracearrBackfillComplete && window.hasRows;
  let backfillOutcome: WalkOutcome | undefined;
  const backfillDue = !backfillComplete && wantsBackfill;

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
  // An EMPTY map counts as "could not load", not as "this server has no users".
  // `getServerAccountNames` returns `new Map()` rather than throwing when the
  // response shape doesn't match what it expects, and when its own page cap or
  // a repeated cursor cuts the user walk short — and every history record
  // carries a `server_user_id` belonging to *some* account, so a server with
  // plays can never legitimately have zero of them. Testing truthiness alone
  // let exactly the outcome this gate exists to prevent through: an empty map
  // is truthy, so the whole archive would land under identity labels.
  if (backfillDue && (!accountNames || accountNames.size === 0)) {
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

  if (backfillDue && accountNames && accountNames.size > 0) {
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
      reached !== null &&
      (!server.tracearrBackfillCursorAt ||
        reached < server.tracearrBackfillCursorAt);

    // "Exhausted" alone is not enough to declare the archive imported: a walk
    // whose very first page comes back `{ records: [], nextCursor: null }` is
    // exhausted too, and that is exactly what a MISMATCHED mapping looks like —
    // a `tracearrServerId` this instance doesn't monitor (`resolveInstanceForServer`
    // short-circuits on a single enabled instance without probing), or a
    // freshly-installed Tracearr with no retained history. Writing completion
    // there would clear `watchHistoryClearedAt` on a server whose native history
    // the mapping change had already wiped, handing the evaluability guard a
    // clean bill of health for an empty relation — `watchedByUser` negatives
    // then match the entire library, which is the precise failure both flags
    // exist to prevent, reached by declaring victory instead of by omission.
    //
    // Rows from ANY run count, not just this one: a resumed slice legitimately
    // imports nothing new when the remaining stretch is all unstorable.
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

    if (cursorAdvanced || finished) {
      await persistMappedState(serverId, mappedServerId, serverName, {
        ...(cursorAdvanced ? { tracearrBackfillCursorAt: reached } : {}),
        ...(finished
          ? {
              tracearrBackfillComplete: true,
              // Evidenced again: the archive has been walked to its oldest
              // play, so `watchedByUser` can be answered faithfully. Written
              // with the completion flag — same guarded statement, so it can
              // never be missed or land without it.
              watchHistoryClearedAt: null,
            }
          : {}),
      });
    }

    if (finished) {
      logger.info(
        "WatchHistory",
        `Tracearr history for "${serverName}" is fully backfilled — later runs ` +
          `only fetch new plays`,
      );
    }
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
    {
      const purged = await prisma.$executeRawUnsafe(
        `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1 AND "source"='NATIVE'`,
        serverId,
      );
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
  return { count: total, backfillPending: !backfillComplete, backfillOutcome };
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
 * With a single enabled instance — the overwhelmingly common case — the answer
 * is settled without any network call. Only a genuine multi-instance setup pays
 * for a `listServers()` probe, and an instance that cannot be reached is
 * skipped rather than treated as "does not own it", so a transient outage on
 * instance A cannot silently hand the mapping to instance B.
 */
// Exported for the recovery pass in `tracearr-backfill-additions.ts`, which
// needs a client for the same instance and must not re-derive "which Tracearr
// owns this server" with its own, subtly different rule.
export async function resolveInstanceForServer(
  userId: string,
  tracearrServerId: string,
  serverName: string,
): Promise<{ id: string; name: string; url: string; apiKey: string } | null> {
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
    return null;
  }

  if (instances.length === 1) return instances[0];

  for (const candidate of instances) {
    try {
      const servers = await new TracearrClient(
        candidate.url,
        candidate.apiKey,
      ).listServers();
      if (servers.some((s) => s.id === tracearrServerId)) return candidate;
    } catch (error) {
      logger.warn(
        "WatchHistory",
        `Could not list servers on Tracearr instance "${candidate.name}" while ` +
          `resolving the mapping for "${serverName}" — skipping this instance`,
        { error: String(error) },
      );
    }
  }

  logger.warn(
    "WatchHistory",
    `Tracearr history sync skipped for "${serverName}" — none of the ` +
      `${instances.length} enabled Tracearr instances monitor server ` +
      `${tracearrServerId}. Re-pick the watch-history source in settings.`,
  );
  return null;
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

/**
 * The two independent boundaries a run may walk, derived from the rows we hold.
 *
 * `since` (forward) is absent on a first import — there is nothing to catch up
 * to. `until` (backfill) is absent on a first import too, meaning "start at the
 * newest play and walk back until the history runs out".
 */
interface ImportWindow {
  since?: Date;
  until?: Date;
  /** Whether this server has any stored Tracearr rows at all. */
  hasRows: boolean;
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

  return {
    since: resolveSince(agg.maxWatchedAt, agg.oldestOpenChain),
    // Only meaningful while the backfill is unfinished; when it is finished the
    // caller never runs that pass.
    // Prefer where the walk actually REACHED over where it last managed to
    // store something. They diverge exactly when a stretch of history is
    // unstorable (media since deleted), which is the live-lock case.
    until: backfillComplete
      ? undefined
      : (cursorAt ?? agg.minWatchedAt ?? undefined),
    hasRows: agg.maxWatchedAt !== null,
  };
}

/** One-line description of the run's plan, for the log. */
function describeWindow(window: ImportWindow): string {
  const parts: string[] = [];
  if (window.since) parts.push(`new plays since ${window.since.toISOString()}`);
  if (window.until) {
    parts.push(`backfilling older than ${window.until.toISOString()}`);
  } else if (!window.since) {
    parts.push("full history — first run");
  }
  return parts.join(", ") || "nothing to do";
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
  data: {
    tracearrOldestPlayAt?: Date;
    watchHistoryClearedAt?: Date | null;
    tracearrBackfillCursorAt?: Date | null;
    tracearrBackfillComplete?: boolean;
  },
): Promise<boolean> {
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: serverId, tracearrServerId },
    data,
  });

  if (count === 0) {
    logger.info(
      "WatchHistory",
      `Discarded Tracearr backfill state for "${serverName}" — its watch-history ` +
        `source changed while this run was walking, so the progress belongs to a ` +
        `mapping the server no longer has`,
    );
    return false;
  }
  return true;
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
  accountNames?: Map<string, string>,
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
    const written = await writeBatch(serverId, rows.slice(i, i + BATCH_SIZE));
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
  pending: PendingRow[],
): Promise<{ inserted: number; updated: number; vanished: number }> {
  if (pending.length === 0) return { inserted: 0, updated: 0, vanished: 0 };

  const batch = await rowsWithLiveMediaItems(pending);
  const vanished = pending.length - batch.length;
  // Nothing survived the check. `INSERT … VALUES` with no tuples is a syntax
  // error, not a no-op, so there is no statement to send at all.
  if (batch.length === 0) return { inserted: 0, updated: 0, vanished };

  const eventIds = batch.map((entry) => entry.row.sourceEventId as string);
  const existing = await prisma.$queryRawUnsafe<
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
  // bridges every account the server still has — so this stays one statement in
  // the ordinary case and becomes two only on a page that mixes a bridged
  // account with a departed one.
  const bridged = batch.filter((entry) => entry.usernameFromAccountMap);
  const fallback = batch.filter((entry) => !entry.usernameFromAccountMap);

  if (bridged.length > 0) {
    await insertRows(bridged, WATCH_HISTORY_UPSERT_SUFFIX);
  }
  if (fallback.length > 0) {
    await insertRows(fallback, WATCH_HISTORY_UPSERT_SUFFIX_FALLBACK_USERNAME);
  }

  return { inserted: batch.length - updated, updated, vanished };
}

/** One `INSERT … VALUES … ON CONFLICT` statement for a set of mapped rows. */
async function insertRows(
  entries: PendingRow[],
  upsertSuffix: string,
): Promise<void> {
  const params: unknown[] = [];
  const tuples: string[] = [];
  let paramIndex = 1;

  for (const { row } of entries) {
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
  pending: PendingRow[],
): Promise<PendingRow[]> {
  const ids = [
    ...new Set(pending.map((entry) => entry.row.mediaItemId as string)),
  ];

  const live = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
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
