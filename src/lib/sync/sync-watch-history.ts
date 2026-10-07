import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { logger } from "@/lib/logger";
import { reconcileWatchStateFromHistory } from "@/lib/sync/watch-reconcile";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import {
  formatPlayCount,
  type WatchHistoryProgressReporter,
} from "@/lib/sync/watch-history-progress";
import type { MediaServerType } from "@/generated/prisma/client";
import { enqueueJob, isJobRetrying } from "@/lib/jobs/client";
import { TASK_TRACEARR_BACKFILL, MAIN_QUEUE } from "@/lib/jobs/constants";
import {
  markWatchHistoryEstablishedIfUnchanged,
  snapshotWatchEvidence,
  type WatchEvidenceSnapshot,
} from "@/lib/media/watch-evidence";
import { UNKNOWN_ACCOUNT_NAME } from "@/lib/plex/client";
import type { DetailedWatchHistoryEntry } from "@/lib/media-server/types";
import { emitWatchHistoryUpdated } from "./watch-history-events";

// 500 rows × 8 params = 4000 bind params per INSERT — well under Postgres's
// 65535 limit, but ~5× fewer round-trips than 100, which keeps the full-replace
// transaction comfortably inside its timeout on large histories.
const BATCH_SIZE = 500;

/**
 * How far behind the newest stored play an incremental refresh starts. A play
 * Plex recorded while the previous refresh's request was in flight must not
 * fall through the gap, so the overlap is re-delivered and deduplicated
 * against the stored rows instead.
 */
const INCREMENTAL_OVERLAP_MS = 60 * 60_000;

export interface WatchHistorySyncOptions {
  /**
   * Append only the plays newer than the stored history instead of running
   * the full replace.
   *
   * The realtime `watch-changed` job is what asks for this. Every Plex
   * playback that ends fires one, and the full replace it used to run
   * re-fetched the server's ENTIRE history and rewrote every row of it —
   * measured on a 141k-play server: ~38 s of Plex paging plus ~7 s of
   * DELETE + INSERT, twice within three minutes on a quiet evening, each run
   * parked on the serial `MAIN_QUEUE` ahead of every sync and lifecycle job.
   * With Plex's `viewedAt>=` filter it is one request for the last hour.
   *
   * Honoured only where it is safe: a client that asserts
   * `supportsHistorySince` (Plex — its history API filters server-side), a
   * server whose history is already established, and one that holds rows to
   * resume from. Everything else — Jellyfin/Emby (a
   * per-user "played" set, not dated events, so there is nothing to filter
   * by), a first import, a server whose history was wiped — falls back to the
   * full replace, which also remains the scheduled and manual path and is
   * what reconciles plays the server has since deleted.
   */
  incremental?: boolean;
}

export interface WatchHistorySyncResult {
  /** Plays written by this run. */
  count: number;
  /**
   * Set when the run could not do what was asked — the fetch failed, the
   * Tracearr instance could not be resolved, or the importer reported its own
   * failure — with the reason. Absent on success and on a deliberate skip (a
   * disabled server). Returned rather than thrown so the stored history is
   * left exactly as it was, but it must not read as a clean sync: before it,
   * every one of these exits returned `{ count: 0 }` and the History page's
   * Refresh reported a server it never reached as synced.
   */
  failed?: string;
}

// The full-replace runs as a single interactive transaction (DELETE + all
// INSERTs) so a mid-insert failure rolls back rather than leaving the table
// empty. A large history easily exceeds Prisma's 5s default, so give the
// transaction a generous window (and a longer connection wait under load).
//
// The budget must not be smaller than the request that drives it, or the slow
// case fails in the most confusing way possible. At 500 rows per statement a
// 160k-play history is ~320 sequential round-trips inside this one transaction;
// past roughly 375ms each, the old 120s cap expired *after* the progress bar
// had climbed to nearly 100% and rolled the entire rewrite back. The streaming
// route allows 30 minutes (`MAX_SYNC_LIFETIME_MS`), so sit just under it and
// let the request's own cap — which reports itself to the user — be the thing
// that stops a runaway sync.
const TX_OPTIONS = { timeout: 25 * 60_000, maxWait: 15_000 } as const;

/**
 * Record that this sync established what was played on the server — the write
 * that lets `checkWatchHistoryCompleteness` answer play-activity criteria for
 * it again.
 *
 * Shared by both native full-replace exits, the normal one and the
 * legitimately-empty one, because "the server reports no plays" is a complete
 * and faithful answer: the fetch throws on a hard failure, so reaching either
 * exit means the question was answered. Leaving the empty case unmarked paused
 * every play-activity rule on that server forever, with nothing in the system
 * able to release it — and a server nobody watches is a real steady state, not
 * an error.
 *
 * Never called on a failed fetch, which returns earlier: the history is still
 * unknown there, and the marker must keep saying so.
 */
async function markHistoryEstablished(
  snapshot: WatchEvidenceSnapshot,
  serverName: string,
): Promise<void> {
  // Compare-and-set against the marker this run started from: a purge, source
  // switch or disable-with-delete that withdrew it while the run was fetching
  // must not be overwritten by a run that never saw what it destroyed.
  const marked = await markWatchHistoryEstablishedIfUnchanged(snapshot);
  if (!marked) {
    logger.info(
      "WatchHistory",
      `Not marking "${serverName}"'s watch history established — it was withdrawn or ` +
        `re-established while this sync ran; the next sync settles it`,
    );
  }
}

export async function syncWatchHistory(
  serverId: string,
  // Optional by contract: the scheduled dispatcher and the realtime
  // `watch-changed` job both call this with no client to report to, so progress
  // must stay pure observation. Only the foreground Refresh on the History page
  // passes a reporter.
  onProgress?: WatchHistoryProgressReporter,
  /**
   * Cancels the sync. Threaded straight into the Tracearr importer (which stops
   * between pages) and checked between the native path's write batches.
   */
  signal?: AbortSignal,
  options: WatchHistorySyncOptions = {}
): Promise<WatchHistorySyncResult> {
  // Load server record
  const serverRows = await prisma.$queryRawUnsafe<
    {
      id: string;
      name: string;
      url: string;
      accessToken: string;
      type: string;
      tlsSkipVerify: boolean;
      enabled: boolean;
      userId: string;
      tracearrServerId: string | null;
      watchHistorySyncedAt?: Date | null;
    }[]
  >(
    `SELECT "id","name","url","accessToken","type","tlsSkipVerify","enabled","userId","tracearrServerId","watchHistorySyncedAt" FROM "MediaServer" WHERE "id"=$1`,
    serverId
  );

  if (serverRows.length === 0) {
    throw new Error(`MediaServer not found: ${serverId}`);
  }
  const server = serverRows[0];

  // A deliberate state, not a failure: nothing syncs a disabled server, and
  // the History page's Refresh refuses one before it gets here.
  if (!server.enabled) {
    logger.info(
      "WatchHistory",
      `Skipping watch history sync for disabled server "${server.name}"`
    );
    return { count: 0 };
  }

  // Read in the same statement as everything else the run starts from.
  const evidence = snapshotWatchEvidence(serverId, server.watchHistorySyncedAt);

  // Watch history has two possible provenances per server, and they are
  // mutually exclusive: mapping this server to a Tracearr `server_id` replaces
  // the native full-replace below with an incremental, append/upsert import
  // from Tracearr's durable log (`sync-tracearr-history.ts`). Running both
  // would be actively destructive — the native path DELETEs every row for the
  // server before re-inserting, so it would wipe the imported Tracearr rows on
  // each run and then the importer's watermark would re-pull them.
  //
  // The mapping alone is not enough: an admin can map a server and later
  // disable (or delete) the instance. When that happens we must SKIP, not fall
  // back to the native path, because falling back is doubly destructive:
  //
  //  1. The native full-replace below DELETEs every row for the server —
  //     including the imported Tracearr rows — so a temporarily disabled
  //     instance would silently destroy the richer history it was mapped for.
  //  2. Worse, it is not self-correcting. Once those rows are gone the
  //     importer's watermark (MAX(watchedAt) WHERE source='TRACEARR') is null
  //     again, so re-enabling the instance triggers a full re-pull that APPENDS
  //     every play back alongside the NATIVE rows the fallback just wrote. The
  //     same play then exists twice, `reconcileWatchStateFromHistory` counts
  //     both, and `MediaItem.playCount` — which is monotonic and drives
  //     destructive lifecycle rules — is permanently doubled.
  //
  // Leaving the existing rows untouched is strictly better than either: the
  // history simply stops advancing until the admin re-enables the instance or
  // clears the mapping (which wipes the rows deliberately, via the server PUT).
  if (server.tracearrServerId) {
    const instance = await prisma.tracearrInstance.findFirst({
      where: { userId: server.userId, enabled: true },
      select: { id: true },
    });

    if (!instance) {
      logger.warn(
        "WatchHistory",
        `"${server.name}" is mapped to a Tracearr server but no enabled Tracearr ` +
          `instance is configured — skipping this sync and leaving the stored ` +
          `history intact. Re-enable the instance, or clear the server's ` +
          `watch-history source to go back to the server's own history.`
      );
      return { count: 0, failed: "no enabled Tracearr instance" };
    }

    logger.info(
      "WatchHistory",
      `Using Tracearr as the watch-history source for "${server.name}"`
    );
    // FORWARD pass only. Every caller of `syncWatchHistory` is either a user
    // waiting on a foreground request (the History page's Refresh) or a
    // scheduled/realtime job that should stay short — and the forward pass is
    // bounded to an hour of overlap, so it answers in seconds regardless of how
    // much history the server holds.
    //
    // The backfill is the opposite shape: a server's entire retained history,
    // ~1,600 pages at 160k plays. Running it here would put a multi-hour archive
    // walk inside a request that dies with the tab. It goes on the durable queue
    // instead, where it survives restarts and re-enqueues itself until done.
    const result = await syncTracearrHistory(serverId, {
      onProgress,
      signal,
      passes: "forward",
    });

    // Queued on EVERY Tracearr run, not only while the archive walk is pending.
    //
    // The task does double duty: while the walk is unfinished it takes another
    // slice, and once it is finished it runs the re-added-item recovery pass.
    // Gating this on `backfillPending` made that second job unreachable —
    // `backfillPending` latches false forever once the walk completes, so no
    // backfill job was ever enqueued again and the recovery pass ran exactly
    // once per server, in the very slice that finished the walk, before any
    // re-add it exists to repair could have happened.
    //
    // jobKey-deduped, so repeated Refreshes collapse onto one queued run rather
    // than stacking one per click, and a completed-backfill run is cheap: it
    // walks nothing and the recovery pass costs one indexed query when there
    // are no recent additions.
    //
    // Except while that job is backing off after a failure: a keyed enqueue
    // resets graphile-worker's attempts and run_at, so enqueueing on every
    // forward sync re-ran a failing slice (and its join-index build) on every
    // play instead of letting the backoff and `maxAttempts` apply.
    const backfillKey = `tracearr-backfill:${serverId}`;
    if (!(await isJobRetrying(backfillKey))) {
      await enqueueJob(
        TASK_TRACEARR_BACKFILL,
        { serverId },
        {
          jobKey: backfillKey,
          queueName: MAIN_QUEUE,
          maxAttempts: 3,
        },
      );
    }

    // Reconcile even when nothing was imported. `syncMediaServer` calls this at
    // the end of a full sync having just overwritten `playCount`/`lastPlayedAt`
    // from ACCOUNT-SCOPED server metadata (the admin's own views), and relies on
    // the watch-history sync to put the all-users values back. The importer only
    // reconciles when it wrote rows — which a steady-state forward pass usually
    // does not — so returning here without one leaves every item the full sync
    // touched reporting the connected account's play state until something else
    // happens to import a row. Non-fatal, as everywhere else: the rows are
    // already committed.
    try {
      await reconcileWatchStateFromHistory(serverId);
    } catch (error) {
      logger.warn(
        "WatchHistory",
        `Failed to reconcile play state after the Tracearr sync for "${server.name}"`,
        { error: String(error) }
      );
    }

    // Tell open pages the stored plays changed. Emitted from here, not from the
    // callers, so every entry point is covered: the scheduled/realtime job, the
    // History page's foreground Refresh (whose NDJSON progress reaches only the
    // tab that started it), and the full sync's inline pass. Only when rows
    // actually landed — a no-op sync should not cost every open tab a refetch.
    if (result.count > 0) {
      await emitWatchHistoryUpdated(serverId, { imported: result.count });
    }

    // The importer's own failure (instance unresolvable, the forward walk
    // errored) is passed on, after the bookkeeping above: what it did import
    // is committed and still has to be reconciled and announced.
    return result.failed
      ? { count: result.count, failed: result.failed }
      : { count: result.count };
  }

  logger.debug(
    "WatchHistory",
    `Using native watch history for "${server.name}"`
  );

  const client = createMediaServerClient(
    server.type as MediaServerType,
    server.url,
    server.accessToken,
    { skipTlsVerify: server.tlsSkipVerify }
  );

  logger.info(
    "WatchHistory",
    `Fetching detailed watch history from "${server.name}"...`
  );

  // Indeterminate on purpose: the fetch is a single server-wide scan with no
  // observable sub-steps, so the honest report is which server is being waited
  // on, not how far through it we are. The total only exists once it returns.
  onProgress?.({
    imported: 0,
    detail: `Fetching watch history from ${server.name}…`,
  });

  // A fetch failure must NOT reach the destructive full-replace below: the
  // client throws on a hard failure so we can skip the wipe (an empty array
  // here therefore means the server genuinely reported no plays).
  // Null means "do the full replace" — see `WatchHistorySyncOptions`.
  const incrementalSince =
    options.incremental && client.supportsHistorySince
      ? await resolveIncrementalSince(serverId)
      : null;

  let entries: Awaited<ReturnType<typeof client.getDetailedWatchHistory>>;
  try {
    entries = await client.getDetailedWatchHistory(
      incrementalSince ? { since: incrementalSince } : undefined
    );
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Skipping watch history sync for "${server.name}" — fetch failed; leaving existing history intact`,
      { error: String(error) }
    );
    return { count: 0, failed: `fetch failed: ${String(error)}` };
  }
  logger.info(
    "WatchHistory",
    incrementalSince
      ? `Got ${entries.length} play events from "${server.name}" since ${incrementalSince.toISOString()}`
      : `Got ${entries.length} play events from "${server.name}"`
  );

  if (incrementalSince) {
    const count = await appendNewEntries(
      serverId,
      server.name,
      entries,
      incrementalSince,
      server.type === "PLEX",
    );
    await markHistoryEstablished(evidence, server.name);
    logger.info(
      "WatchHistory",
      `Appended ${count} new watch history entries for "${server.name}"`
    );
    // Nothing appended means nothing to reconcile or announce: this runs per
    // finished playback, and the reconcile is a server-wide aggregate.
    if (count > 0) {
      await reconcileAfterNativeWrite(serverId, server.name);
      await emitWatchHistoryUpdated(serverId, { imported: count });
    }
    return { count };
  }

  if (entries.length === 0) {
    // Still clear old records in case items were removed
    await prisma.$transaction(async (tx) => {
      await lockServerHistory(tx, serverId);
      await tx.$executeRawUnsafe(
        `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1`,
        serverId
      );
    }, TX_OPTIONS);
    // ...and release the marker here too. This is a SUCCESSFUL full replace —
    // the fetch threw on a hard failure above, so reaching here means the
    // server genuinely reports no plays, which is a complete and faithful
    // record of its history. Returning early without clearing left a server
    // switched Tracearr → native whose native history is legitimately empty
    // (a fresh Plex, or Jellyfin degrading to a per-user response) marked
    // un-evidenced FOREVER, silently pausing every `watchedByUser` rule set
    // scoped to it with nothing that could ever release it.
    await markHistoryEstablished(evidence, server.name);
    return { count: 0 };
  }

  // Build a lookup from ratingKey -> mediaItemId for this server's items
  const mediaItems = await prisma.$queryRawUnsafe<ItemKeyRow[]>(
    `SELECT mi."id", mi."ratingKey", l."key" AS "libraryKey" FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l."id"
     WHERE l."mediaServerId"=$1`,
    serverId
  );
  const resolveItem = ratingKeyResolver(mediaItems, server.type === "PLEX");

  // Dedupe entries in memory before inserting. There is no DB unique constraint
  // on WatchHistory (intentional), so identical play events from the source
  // (same item, user, and watchedAt) would otherwise become duplicate rows.
  //
  // Only TIMESTAMPED entries are deduped. An entry with no `watchedAt` is not a
  // repeat of another one — it is how a server that reports a play COUNT
  // without per-play timestamps represents one of those plays. Jellyfin and
  // Emby do exactly that: `getDetailedWatchHistory` emits `UserData.PlayCount`
  // entries per item/user and only the first carries `LastPlayedDate`, so a
  // key of `ratingKey|username|(watchedAt ?? "")` collapsed all the undated
  // ones into a single row and an item played five times stored two — capping
  // `playCount` at 2 per user everywhere it is read (the Play Count column,
  // the hover card, and `playCount` lifecycle rules), while the per-item
  // history panel, which queries the server live, still showed five.
  const seen = new Set<string>();
  const dedupedEntries: typeof entries = [];
  for (const entry of entries) {
    if (entry.watchedAt) {
      const key = `${entry.ratingKey}|${entry.username}|${entry.watchedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    dedupedEntries.push(entry);
  }

  // Batch insert new records
  let insertedCount = 0;
  let unmatchedCount = 0;
  let storedPlays = 0;

  // Wrap the full-replace DELETE and all batch INSERTs in a single transaction
  // so a mid-insert failure rolls back instead of leaving the table empty
  // (the previous out-of-transaction version permanently wiped history on any
  // insert error until the next successful sync).
  await prisma.$transaction(async (tx) => {
    await lockServerHistory(tx, serverId);
    // Full replace: delete existing watch history for this server
    await tx.$executeRawUnsafe(
      `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1`,
      serverId
    );

    for (let i = 0; i < dedupedEntries.length; i += BATCH_SIZE) {
      // Cancelled mid-write. Throwing (rather than breaking) is deliberate
      // here and the opposite of the Tracearr path's break: this loop runs
      // inside the full-replace transaction, which has ALREADY deleted the
      // server's rows. Breaking would commit a partially-rewritten history and
      // silently lose plays; throwing rolls the whole transaction back, so a
      // cancelled native sync leaves the previous history exactly as it was.
      if (signal?.aborted) {
        throw new Error("Watch history sync cancelled");
      }

      const batch = dedupedEntries.slice(i, i + BATCH_SIZE);
      const rows: NativeRow[] = [];
      for (const entry of batch) {
        const mediaItemIds = resolveItem.resolve(entry);
        if (mediaItemIds.length === 0) unmatchedCount++;
        else storedPlays++;
        // One row per copy: a play that resolves to the same item stored in
        // two libraries is a play of each (see `ratingKeyResolver`).
        for (const mediaItemId of mediaItemIds) rows.push({ mediaItemId, entry });
      }

      // No setImmediate yield between batches: the awaited DB round-trip
      // already yields the event loop, and an extra macrotask only burns the
      // interactive-transaction timeout budget.
      insertedCount += await insertNativeRows(tx, serverId, rows);

      // The one place in a watch-history sync where a real percentage is
      // honest: `getDetailedWatchHistory()` has already returned, so the
      // denominator is a counted set of play events rather than a guess at how
      // much history a server holds.
      //
      // Measured over entries CONSUMED, not rows written: an entry whose
      // ratingKey matches no MediaItem is still work done, so counting rows
      // would stall the bar on a server with unmatched plays and never reach 1.
      const processed = Math.min(i + BATCH_SIZE, dedupedEntries.length);
      onProgress?.({
        imported: insertedCount,
        fraction: processed / dedupedEntries.length,
        // Plays, not rows: a play filed against two copies of one item is
        // two rows, and counting those could read "stored 102 of 100".
        detail: `Stored ${storedPlays.toLocaleString()} of ${formatPlayCount(
          dedupedEntries.length
        )}`,
      });
    }
  }, TX_OPTIONS);

  await markHistoryEstablished(evidence, server.name);
  resolveItem.logAmbiguous(server.name);

  logger.info(
    "WatchHistory",
    `Synced ${insertedCount} watch history entries for "${server.name}" ` +
      `(${unmatchedCount} unmatched, ` +
      `${entries.length - dedupedEntries.length} duplicates removed)`
  );

  // Push the freshly stored history into `MediaItem.playCount`/`lastPlayedAt`.
  // Those columns are what the rule and query engines read (`lastPlayedAt`, and
  // the `seriesLastPlayedAt` aggregate rolled up from it), but the item sync
  // derives them from account-scoped server metadata — so a play by any other
  // user on the server landed in `WatchHistory` and nowhere else. Non-fatal:
  // the history rows are already committed, so a failure here is corrected by
  // the next sync rather than being worth failing the whole run over.
  await reconcileAfterNativeWrite(serverId, server.name);

  // Tell open pages the stored plays changed. Emitted from here, not from the
  // callers, so every entry point is covered: the scheduled/realtime job, the
  // History page's foreground Refresh (whose NDJSON progress reaches only the
  // tab that started it), and the full sync's inline pass. Only when rows
  // actually landed — a no-op sync should not cost every open tab a refetch.
  if (insertedCount > 0) {
    await emitWatchHistoryUpdated(serverId, { imported: insertedCount });
  }

  return { count: insertedCount };
}

async function reconcileAfterNativeWrite(serverId: string, serverName: string): Promise<void> {
  try {
    await reconcileWatchStateFromHistory(serverId);
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Failed to reconcile play state from watch history for "${serverName}"`,
      { error: String(error) }
    );
  }
}

/**
 * Where an incremental refresh should start, or `null` for a full replace.
 *
 * Derived from the rows rather than a persisted cursor, like the Tracearr
 * importer's boundaries: the record of what was imported and the point that
 * resumes it cannot then disagree. `watchHistorySyncedAt` is checked too —
 * rows can exist on a server whose evidence has been withdrawn, and an
 * append on top of a history nobody vouches for would leave it that way.
 */
async function resolveIncrementalSince(serverId: string): Promise<Date | null> {
  const rows = await prisma.$queryRawUnsafe<
    { establishedAt: Date | null; newest: Date | null }[]
  >(
    `SELECT ms."watchHistorySyncedAt" AS "establishedAt",
            (SELECT MAX(wh."watchedAt") FROM "WatchHistory" wh WHERE wh."mediaServerId" = ms."id") AS "newest"
       FROM "MediaServer" ms
      WHERE ms."id" = $1`,
    serverId
  );
  const row = rows[0];
  if (!row?.establishedAt || !row.newest) return null;
  return new Date(new Date(row.newest).getTime() - INCREMENTAL_OVERLAP_MS);
}

/**
 * Store the entries not already present.
 *
 * A play's identity is item + watchedAt (to the second) + account, checked
 * against the rows stored at or after `since` (the overlap window, so the set
 * is small). Undated entries are skipped: they cannot be told apart from a
 * stored one, and Plex — the only server this path runs for — always dates a
 * play.
 *
 * The account half is where an exact `item|user|watchedAt` key went wrong.
 * Plex names a play by looking its account up in `/accounts`, and a play whose
 * account could not be named is stored as "Unknown". When the same play came
 * back through the overlap with its real name (or the other way round), the
 * exact key saw two different plays and appended it again — permanently, since
 * `playCount` is monotonic. So "Unknown" is matched as a wildcard: at the same
 * item and second, it pairs with one otherwise-unmatched play of any name.
 * Two DIFFERENT real names at the same item and second stay two plays — Plex
 * history is per account, and two accounts finishing the same item in the
 * same second is rare but real, while one account cannot do it twice. Exact
 * names pair first, so a wildcard never takes a row an exact match needed.
 *
 * A stored "Unknown" that pairs with a now-named play is relabelled to the
 * name, so a `watchedByUser` rule sees whose play it was.
 */
async function appendNewEntries(
  serverId: string,
  serverName: string,
  entries: DetailedWatchHistoryEntry[],
  since: Date,
  /** See `ratingKeyResolver`. */
  keysServerUnique: boolean
): Promise<number> {
  // Fail closed on the server's filter: a play older than `since` in the
  // response means the `viewedAt>=` parameter was not honoured (a proxy that
  // re-encodes the query, a build without the filter), and appending the
  // whole history it returned would duplicate every stored play. Undated
  // entries are dropped for the same reason — they cannot be deduplicated.
  const sinceMs = since.getTime();
  const dated = entries.filter(
    (e) => e.watchedAt && new Date(e.watchedAt).getTime() >= sinceMs
  );
  if (dated.length === 0) return 0;

  const ratingKeys = [...new Set(dated.map((e) => e.ratingKey))];
  const mediaItems = await prisma.$queryRawUnsafe<ItemKeyRow[]>(
    `SELECT mi."id", mi."ratingKey", l."key" AS "libraryKey" FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l."id"
     WHERE l."mediaServerId" = $1 AND mi."ratingKey" = ANY($2::text[])`,
    serverId,
    ratingKeys
  );
  const resolveItem = ratingKeyResolver(mediaItems, keysServerUnique);

  // The read-then-append runs under the same per-server lock as the full
  // replace. That one runs in a request (the History page's Refresh), outside
  // the serial job queue, so without the lock it could DELETE + re-INSERT the
  // history between this read and this append and the same play would land
  // twice — inflating `playCount`, which is monotonic and never walked back.
  const inserted = await prisma.$transaction(async (tx) => {
    await lockServerHistory(tx, serverId);

    const existing = await tx.$queryRawUnsafe<
      { id: string; mediaItemId: string; serverUsername: string; watchedAt: Date }[]
    >(
      `SELECT "id", "mediaItemId", "serverUsername", "watchedAt" FROM "WatchHistory"
       WHERE "mediaServerId" = $1 AND "watchedAt" >= $2`,
      serverId,
      since
    );
    const stored = new Map<string, { id: string; username: string; claimed: boolean }[]>();
    for (const row of existing) {
      const key = playInstantKey(row.mediaItemId, row.watchedAt);
      const list = stored.get(key) ?? [];
      list.push({ id: row.id, username: row.serverUsername, claimed: false });
      stored.set(key, list);
    }

    // Collapse plays the response repeats (same item, instant and name), as
    // the full replace does. Keyed per ITEM, so a play filed against two
    // copies of one item (see `ratingKeyResolver`) is matched and appended
    // for each copy on its own.
    const incoming: Array<{ key: string; row: NativeRow; matched: boolean }> = [];
    const repeated = new Set<string>();
    for (const entry of dated) {
      for (const mediaItemId of resolveItem.resolve(entry)) {
        const key = playInstantKey(mediaItemId, entry.watchedAt!);
        const exact = `${key}|${entry.username}`;
        if (repeated.has(exact)) continue;
        repeated.add(exact);
        incoming.push({ key, row: { mediaItemId, entry }, matched: false });
      }
    }

    // Exact names first…
    for (const play of incoming) {
      const match = stored
        .get(play.key)
        ?.find((r) => !r.claimed && r.username === play.row.entry.username);
      if (match) {
        match.claimed = true;
        play.matched = true;
      }
    }
    // …then "Unknown" on either side pairs with one unmatched play.
    const relabels: Array<{ id: string; username: string }> = [];
    for (const play of incoming) {
      if (play.matched) continue;
      const incomingUnknown = play.row.entry.username === UNKNOWN_ACCOUNT_NAME;
      const match = stored
        .get(play.key)
        ?.find(
          (r) => !r.claimed && (incomingUnknown || r.username === UNKNOWN_ACCOUNT_NAME),
        );
      if (!match) continue;
      match.claimed = true;
      play.matched = true;
      if (!incomingUnknown) relabels.push({ id: match.id, username: play.row.entry.username });
    }

    if (relabels.length > 0) {
      await tx.$executeRawUnsafe(
        `UPDATE "WatchHistory" wh SET "serverUsername" = v."username"
           FROM unnest($1::text[], $2::text[]) AS v("id", "username")
          WHERE wh."id" = v."id"`,
        relabels.map((r) => r.id),
        relabels.map((r) => r.username),
      );
    }

    const fresh = incoming.filter((p) => !p.matched).map((p) => p.row);
    let count = 0;
    for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
      count += await insertNativeRows(tx, serverId, fresh.slice(i, i + BATCH_SIZE));
    }
    return count;
  }, TX_OPTIONS);
  resolveItem.logAmbiguous(serverName);
  return inserted;
}

/** Item + instant, to the second Plex records `viewedAt` in. */
function playInstantKey(mediaItemId: string, watchedAt: Date | string): string {
  return `${mediaItemId}|${Math.floor(new Date(watchedAt).getTime() / 1000)}`;
}

interface ItemKeyRow {
  id: string;
  ratingKey: string;
  libraryKey?: string | null;
}

/**
 * Rating key → the MediaItem id(s) a play is filed against, for one server.
 *
 * `@@unique([libraryId, ratingKey])` makes a rating key unique only WITHIN a
 * library, so one server can hold the same key in two libraries. What that
 * means depends on the server, which is why the resolver is told
 * (`keysServerUnique`):
 *
 * - **Plex** numbers items server-wide, so a key in two libraries is a stale
 *   row an item left behind when it moved (or a reused rowid), until the next
 *   full sync purges it. Only the play's own `librarySectionID` can say which
 *   row is live; without it — or when it names neither library — the play is
 *   skipped. A dropped play beats a play on the wrong item, whose `playCount`
 *   can never be walked back.
 * - **Jellyfin/Emby** item ids are server-wide too, but two libraries may
 *   cover the same folder and then legitimately list the SAME item, which we
 *   store once per library. They never report a section, and the play is the
 *   same play of the same media in both — so it is filed against every copy.
 *   Skipping it (which an earlier version did) let the full replace delete
 *   both copies' plays, so both read as unwatched and a negative
 *   `watchedByUser` or `playCount = 0` DELETE rule matched them.
 *
 * A section key that is given narrows the candidates on either server.
 */
function ratingKeyResolver(rows: ItemKeyRow[], keysServerUnique: boolean) {
  const byKey = new Map<string, ItemKeyRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.ratingKey);
    if (list) list.push(row);
    else byKey.set(row.ratingKey, [row]);
  }
  let ambiguous = 0;
  return {
    resolve(entry: Pick<DetailedWatchHistoryEntry, "ratingKey" | "librarySectionKey">): string[] {
      const candidates = byKey.get(entry.ratingKey);
      if (!candidates) return [];
      if (candidates.length === 1) return [candidates[0].id];
      if (entry.librarySectionKey) {
        const inSection = candidates.filter((c) => c.libraryKey === entry.librarySectionKey);
        // `@@unique([libraryId, ratingKey])`: at most one row per library.
        if (inSection.length > 0) return inSection.map((c) => c.id);
        // The play names a library none of the rows are in. On Plex every
        // row is then stale (the item lives in a library we have not synced
        // yet); on Jellyfin/Emby a section is never sent. Skip either way.
        ambiguous++;
        return [];
      }
      if (keysServerUnique) {
        ambiguous++;
        return [];
      }
      return candidates.map((c) => c.id);
    },
    logAmbiguous(serverName: string): void {
      if (ambiguous === 0) return;
      logger.warn(
        "WatchHistory",
        `Skipped ${ambiguous} play(s) on "${serverName}" whose rating key matches items in ` +
          `more than one library and whose own library does not say which one was played — ` +
          `the extra rows are stale, and the next full sync's stale-item purge resolves them`,
      );
    },
  };
}

type RawWriter = Pick<typeof prisma, "$executeRawUnsafe">;

interface NativeRow {
  mediaItemId: string;
  entry: {
    username: string;
    watchedAt: string | null;
    deviceName: string | null;
    platform: string | null;
  };
}

/**
 * Serialises every writer of one server's native history. Transaction-scoped
 * (released on commit or rollback), keyed per server so two servers never
 * wait on each other. Both the full replace and the incremental append take
 * it; see `appendNewEntries` for the race it closes.
 */
async function lockServerHistory(db: RawWriter, serverId: string): Promise<void> {
  await db.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext('watch-history:' || $1))`,
    serverId
  );
}

/**
 * One multi-row INSERT of native play rows. The single column list both the
 * full replace and the incremental append write through, so a column added
 * to one path cannot go missing from the other.
 */
async function insertNativeRows(db: RawWriter, serverId: string, rows: NativeRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { randomUUID } = await import("crypto");
  const values: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;
  for (const { mediaItemId, entry } of rows) {
    values.push(
      `($${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++})`
    );
    params.push(
      randomUUID(),
      mediaItemId,
      serverId,
      entry.username,
      entry.watchedAt ? new Date(entry.watchedAt) : null,
      entry.deviceName,
      entry.platform,
      new Date()
    );
  }
  await db.$executeRawUnsafe(
    `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","deviceName","platform","createdAt")
     VALUES ${values.join(",")}`,
    ...params
  );
  return rows.length;
}
