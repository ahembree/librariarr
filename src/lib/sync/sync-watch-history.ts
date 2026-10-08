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
import type {
  DetailedWatchHistoryEntry,
  DetailedWatchHistoryReport,
} from "@/lib/media-server/types";
import { emitWatchHistoryUpdated } from "./watch-history-events";

// 500 rows × 9 params = 4500 bind params per INSERT — well under Postgres's
// 65535 limit, but ~5× fewer round-trips than 100, which keeps the full-replace
// transaction comfortably inside its timeout on large histories. Plays per
// write batch and rows per INSERT are bounded separately (`insertNativeRows`).
const BATCH_SIZE = 500;

/** Reported when a native write finds the server remapped or gone (`assertStillNative`). */
const SOURCE_CHANGED_FAILURE =
  "the server's watch-history source changed while this sync ran — nothing was written";

class WatchHistorySourceChangedError extends Error {
  constructor(readonly serverGone: boolean) {
    super(SOURCE_CHANGED_FAILURE);
    this.name = "WatchHistorySourceChangedError";
  }
}

// Retried once by `withWriteConflictRetry`.
const FOREIGN_KEY_VIOLATION = "23503";
const DEADLOCK_DETECTED = "40P01";

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
   * server whose history is already established (or withdrawn only by a
   * library-resync hold — see `resolveIncrementalSince`), and one that holds
   * rows to resume from. Everything else — Jellyfin/Emby (a
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
   * Why the run could not do what was asked; absent on success and on a
   * disabled server. Returned, not thrown, so the stored history stays as it
   * was — but callers must not read it as a clean sync.
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
 * Record that this sync established what was played on the server (what lets
 * `checkWatchHistoryCompleteness` answer play-activity criteria again). Also
 * after a replace that stored nothing: "no plays" is a real answer, and a
 * server nobody watches must not stay paused forever. Never after a failed
 * fetch, nor where the call site's set-aside rule refuses.
 */
async function markHistoryEstablished(
  snapshot: WatchEvidenceSnapshot,
  serverName: string,
): Promise<void> {
  // Compare-and-set on the marker the run started from, so a withdrawal made
  // mid-run is not overwritten; it also refuses under a library-resync hold.
  const marked = await markWatchHistoryEstablishedIfUnchanged(snapshot);
  if (marked) return;
  // Which of the two refused it decides what settles it, so the log says.
  logger.info(
    "WatchHistory",
    (await heldForLibraryResync(snapshot.serverId))
      ? `Not marking "${serverName}"'s watch history established — some of its media ` +
          `is known to be missing (a purge, a restore, or a library being populated), ` +
          `and play history waits for a complete library sync of the server, whose own ` +
          `watch-history pass settles it`
      : `Not marking "${serverName}"'s watch history established — it was withdrawn or ` +
          `re-established while this sync ran; the next sync settles it`,
  );
}

/** For the log line above only: a failed read reads as "no hold". */
async function heldForLibraryResync(serverId: string): Promise<boolean> {
  try {
    const row = await prisma.mediaServer.findUnique({
      where: { id: serverId },
      select: { libraryResyncRequiredAt: true },
    });
    return row?.libraryResyncRequiredAt != null;
  } catch {
    return false;
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

  // A deliberate skip, not a failure.
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

    // Passed on after the bookkeeping above: what it did import is committed.
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
  // here therefore means the server genuinely reported no plays, apart from
  // any users the report below sets aside).
  // Null means "do the full replace" — see `WatchHistorySyncOptions`.
  const incremental =
    options.incremental && client.supportsHistorySince
      ? await resolveIncrementalSince(serverId)
      : null;
  const incrementalSince = incremental?.since ?? null;

  // Acted on by the full replace; an append deletes nothing, so it gets none.
  const report: DetailedWatchHistoryReport = {
    incompleteUsers: new Map(),
    devicesUnavailable: false,
  };

  let entries: DetailedWatchHistoryEntry[];
  try {
    entries = await client.getDetailedWatchHistory(
      incrementalSince ? { since: incrementalSince } : { report }
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

  if (incremental) {
    let count: number;
    try {
      count = await appendNewEntries(
        serverId,
        server.name,
        entries,
        incremental.since,
        server.type === "PLEX",
      );
    } catch (error) {
      if (error instanceof WatchHistorySourceChangedError) {
        return sourceChangedResult(server.name, error);
      }
      throw error;
    }
    if (incremental.held) {
      // The hold refuses the write; this runs per playback, so only a debug
      // line. The releasing full sync establishes the history.
      logger.debug(
        "WatchHistory",
        `Not marking "${server.name}"'s watch history established — held until a ` +
          `complete library sync of the server`,
      );
    } else {
      await markHistoryEstablished(evidence, server.name);
    }
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

  // Set-aside users keep their stored rows: replacing them with nothing would
  // read everything they watched as unwatched and arm "not played" rules.
  const keptUsers = [...report.incompleteUsers.keys()];
  // Only the Jellyfin/Emby client sets users aside.
  const product = server.type === "EMBY" ? "Emby" : "Jellyfin";
  if (keptUsers.length > 0) {
    // Every sync: it stays true for as long as they are set aside.
    logger.warn(
      "WatchHistory",
      `Not replacing the stored plays of ` +
        [...report.incompleteUsers]
          .map(([name, why]) => `"${name}" (${why === "refused" ? "refused" : "listing incomplete"})`)
          .join(", ") +
        ` on "${server.name}": their watch history could not be read completely this sync. ` +
        `Their plays that are not stored already — new ones, and every play of media added ` +
        `or re-added since (a newly enabled, purged or re-created library) — stay missing ` +
        `until their listing can be read, and an item they alone watched reads as never ` +
        `played unless one of its plays is stored. Make their played items readable in ` +
        `${product} (their library access, parental controls) or remove the user there`,
    );
  }
  // May this run vouch for the history with users set aside? A REFUSED user
  // never blocks it: the key will never read them. An UNRELIABLE user's stored
  // rows vouch for it whatever the marker was at the start (a hold's release
  // also nulls it, and refusing there paused such a server for good), unless
  // they have none and the marker was null (a first sync, a wiped history).
  // Accepted cost: their plays not stored — new ones, and those of a newly
  // enabled, purged or re-created library — stay missing from an established
  // history, so an item only they watched reads never played; the WARN says so.
  const unreadableUsers = [...report.incompleteUsers]
    .filter(([, why]) => why === "unreliable")
    .map(([name]) => name);
  // Whose stored rows decide it; read inside the replace, which keeps them.
  const storedRowsOf = evidence.marker === null ? unreadableUsers : [];
  if (report.devicesUnavailable) {
    logger.warn(
      "WatchHistory",
      `"${server.name}" did not answer its device list; keeping the device and ` +
        `platform already stored for every play this sync re-delivers`,
    );
  }

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
  const plays: DetailedWatchHistoryEntry[] = [];
  let duplicates = 0;
  for (const entry of entries) {
    // Their stored rows stand; anything arriving for them would duplicate those.
    if (report.incompleteUsers.has(entry.username)) continue;
    if (entry.watchedAt) {
      const key = `${entry.ratingKey}|${entry.username}|${entry.watchedAt}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
    }
    plays.push(entry);
  }

  let outcome: ReplaceOutcome;
  try {
    outcome = await withWriteConflictRetry(server.name, signal, () =>
      replaceNativeHistory({
        serverId,
        serverName: server.name,
        keysServerUnique: server.type === "PLEX",
        plays,
        keptUsers,
        storedRowsOf,
        devicesUnavailable: report.devicesUnavailable,
        onProgress,
        signal,
      }),
    );
  } catch (error) {
    if (error instanceof WatchHistorySourceChangedError) {
      return sourceChangedResult(server.name, error);
    }
    throw error;
  }

  // The readable users' rows are committed either way; the vouching rule above
  // decides the marker.
  const unestablishedUsers = storedRowsOf.filter(
    (name) => !outcome.usersWithStoredRows.has(name),
  );
  if (unestablishedUsers.length === 0) {
    await markHistoryEstablished(evidence, server.name);
  } else {
    logger.warn(
      "WatchHistory",
      `Not marking "${server.name}"'s watch history established: the played-items ` +
        `listing of ${unestablishedUsers.map((name) => `"${name}"`).join(", ")} could not ` +
        `be read completely and none of their plays is stored, so play-activity rules ` +
        `for this server stay paused. Make their played items readable in ${product} ` +
        `(their library access, parental controls) or remove the user there — ` +
        `a Refresh alone does not lift this`,
    );
  }

  if (plays.length === 0) {
    // Nothing to store: the replace still cleared the rest, and the marker was
    // handled above like any successful replace (see `markHistoryEstablished`).
    return { count: 0 };
  }

  const insertedCount = outcome.inserted;
  logger.info(
    "WatchHistory",
    `Synced ${insertedCount} watch history entries for "${server.name}" ` +
      `(${outcome.unmatched} unmatched, ${duplicates} duplicates removed` +
      (outcome.vanished > 0
        ? `, ${outcome.vanished} whose item was deleted while the sync ran`
        : "") +
      `)`
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

/** A failure, so it is named and retried (on the Tracearr path by then); the marker is untouched. */
function sourceChangedResult(
  serverName: string,
  error: WatchHistorySourceChangedError,
): WatchHistorySyncResult {
  logger.warn(
    "WatchHistory",
    error.serverGone
      ? `"${serverName}" was deleted while its watch history was being fetched; nothing was written`
      : `"${serverName}" was mapped to a Tracearr server while its native watch history was ` +
          `being fetched; nothing was written — its history now comes from Tracearr`,
  );
  return { count: 0, failed: SOURCE_CHANGED_FAILURE };
}

interface ReplaceOutcome {
  /** Rows written: a play filed against two copies of one item is two rows. */
  inserted: number;
  /** Plays whose rating key matched no item. */
  unmatched: number;
  /** Plays whose every item was deleted between resolving and writing them. */
  vanished: number;
  /** Of `storedRowsOf`, the users who still have stored rows on the server. */
  usersWithStoredRows: Set<string>;
}

/**
 * The native full replace: the server's stored history is dropped and
 * re-written from `plays` in ONE transaction, so a mid-insert failure rolls
 * back instead of leaving the table empty. Everything that can go stale
 * between fetch and write is read here, so the one retry re-reads all of it.
 */
async function replaceNativeHistory(args: {
  serverId: string;
  serverName: string;
  /** See `ratingKeyResolver`. */
  keysServerUnique: boolean;
  /** Deduplicated plays, with every set-aside user's already removed. */
  plays: DetailedWatchHistoryEntry[];
  /** Users whose stored rows the replace keeps (`DetailedWatchHistoryReport`). */
  keptUsers: string[];
  /** Set-aside users to report on in `usersWithStoredRows`. */
  storedRowsOf: string[];
  devicesUnavailable: boolean;
  onProgress?: WatchHistoryProgressReporter;
  signal?: AbortSignal;
}): Promise<ReplaceOutcome> {
  const { serverId, keptUsers, onProgress, signal } = args;

  // Not needed when the replace only clears the old rows.
  const mediaItems =
    args.plays.length > 0
      ? await prisma.$queryRawUnsafe<ItemKeyRow[]>(
          `SELECT mi."id", mi."ratingKey", l."key" AS "libraryKey" FROM "MediaItem" mi
           JOIN "Library" l ON mi."libraryId" = l."id"
           WHERE l."mediaServerId"=$1`,
          serverId
        )
      : [];
  const resolveItem = ratingKeyResolver(mediaItems, args.keysServerUnique);
  const resolved = args.plays.map((entry) => ({ entry, ids: resolveItem.resolve(entry) }));

  const outcome: ReplaceOutcome = {
    inserted: 0,
    unmatched: 0,
    vanished: 0,
    usersWithStoredRows: new Set(),
  };
  let storedPlays = 0;

  await prisma.$transaction(async (tx) => {
    await lockServerHistory(tx, serverId);
    await assertStillNative(tx, serverId);

    // The item map was read before the lock, which can wait minutes behind
    // another writer: drop plays of items deleted meanwhile rather than fail
    // the whole replace on the FK (`withWriteConflictRetry` covers the rest).
    const live = await liveItemIds(tx, resolved);
    const storedDevices =
      args.devicesUnavailable && resolved.length > 0
        ? await loadStoredDevices(tx, serverId)
        : null;

    // Full replace: delete existing watch history for this server, except the
    // set-aside users' rows (the plain form when none, not an empty-array bind).
    if (keptUsers.length === 0) {
      await tx.$executeRawUnsafe(
        `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1`,
        serverId
      );
    } else {
      await tx.$executeRawUnsafe(
        `DELETE FROM "WatchHistory"
          WHERE "mediaServerId"=$1 AND NOT ("serverUsername" = ANY($2::text[]))`,
        serverId,
        keptUsers
      );
    }
    // After the DELETE, under the lock: exactly the rows this replace keeps.
    if (args.storedRowsOf.length > 0) {
      const withRows = await tx.$queryRawUnsafe<{ name: string }[]>(
        `SELECT u."name" FROM unnest($2::text[]) AS u("name")
          WHERE EXISTS (SELECT 1 FROM "WatchHistory" wh
                         WHERE wh."mediaServerId" = $1 AND wh."serverUsername" = u."name")`,
        serverId,
        args.storedRowsOf
      );
      outcome.usersWithStoredRows = new Set(withRows.map((row) => row.name));
    }

    for (let i = 0; i < resolved.length; i += BATCH_SIZE) {
      // Cancelled mid-write. Throwing (rather than breaking) is deliberate
      // here and the opposite of the Tracearr path's break: this loop runs
      // inside the full-replace transaction, which has ALREADY deleted the
      // server's rows. Breaking would commit a partially-rewritten history and
      // silently lose plays; throwing rolls the whole transaction back, so a
      // cancelled native sync leaves the previous history exactly as it was.
      if (signal?.aborted) {
        throw new Error("Watch history sync cancelled");
      }

      const rows: NativeRow[] = [];
      for (const { entry, ids } of resolved.slice(i, i + BATCH_SIZE)) {
        if (ids.length === 0) {
          outcome.unmatched++;
          continue;
        }
        // Narrowed to the items that still exist, which also re-picks the
        // primary copy when the one it would have been is gone.
        const playRows = nativeRowsForPlay(ids.filter((id) => live.has(id)), entry);
        if (playRows.length === 0) {
          outcome.vanished++;
          continue;
        }
        storedPlays++;
        for (const row of playRows) {
          rows.push(storedDevices ? withStoredDevice(row, storedDevices) : row);
        }
      }

      // No setImmediate yield between batches: the awaited DB round-trip
      // already yields the event loop, and an extra macrotask only burns the
      // interactive-transaction timeout budget.
      outcome.inserted += await insertNativeRows(tx, serverId, rows);

      // The one place in a watch-history sync where a real percentage is
      // honest: `getDetailedWatchHistory()` has already returned, so the
      // denominator is a counted set of play events rather than a guess at how
      // much history a server holds.
      //
      // Measured over entries CONSUMED, not rows written: an entry whose
      // ratingKey matches no MediaItem is still work done, so counting rows
      // would stall the bar on a server with unmatched plays and never reach 1.
      const processed = Math.min(i + BATCH_SIZE, resolved.length);
      onProgress?.({
        imported: outcome.inserted,
        fraction: processed / resolved.length,
        // Plays, not rows: a play filed against two copies of one item is
        // two rows, and counting those could read "stored 102 of 100".
        detail: `Stored ${storedPlays.toLocaleString()} of ${formatPlayCount(
          resolved.length
        )}`,
      });
    }
  }, TX_OPTIONS);

  resolveItem.logAmbiguous(args.serverName);
  return outcome;
}

/**
 * Run the full replace, and once more if it lost a race the in-transaction
 * checks cannot rule out: an FK violation (an item or a copy's primary deleted
 * after `liveItemIds` read it) or a deadlock with a purge's cascade, which
 * locks in the opposite order. The retry rebuilds everything; a second failure
 * propagates, rolled back. Prisma 7 + adapter-pg report a failed raw statement
 * as P2010 with the SQLSTATE at `meta.driverAdapterError.cause.originalCode`.
 */
async function withWriteConflictRetry<T>(
  serverName: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = sqlStateOf(error);
    if ((code !== FOREIGN_KEY_VIOLATION && code !== DEADLOCK_DETECTED) || signal?.aborted) {
      throw error;
    }
    logger.warn(
      "WatchHistory",
      `Retrying the watch-history write for "${serverName}" once: ` +
        (code === FOREIGN_KEY_VIOLATION
          ? "an item it was writing plays for was deleted meanwhile"
          : "it deadlocked with a concurrent write") +
        ` (SQLSTATE ${code}); the first attempt was rolled back`,
    );
    return run();
  }
}

/** The PostgreSQL SQLSTATE behind a failed raw statement, or null. */
function sqlStateOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const meta = (error as {
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  }).meta;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === "string" ? code : null;
}

/**
 * Where an incremental refresh should start — and whether the server is under
 * a library-resync hold — or `null` for a full replace.
 *
 * Derived from the rows rather than a persisted cursor, like the Tracearr
 * importer's boundaries: the record of what was imported and the point that
 * resumes it cannot then disagree. `watchHistorySyncedAt` is checked too —
 * rows can exist on a server whose evidence has been withdrawn, and an
 * append on top of a history nobody vouches for would leave it that way.
 *
 * A library-resync hold is the one withdrawal that still appends: it refuses
 * the marker until a complete library sync, whose own history pass is the full
 * replace, so a full replace per playback meanwhile would rewrite the whole
 * history for nothing. The append deletes nothing.
 */
async function resolveIncrementalSince(
  serverId: string,
): Promise<{ since: Date; held: boolean } | null> {
  const rows = await prisma.$queryRawUnsafe<
    { establishedAt: Date | null; heldAt: Date | null; newest: Date | null }[]
  >(
    `SELECT ms."watchHistorySyncedAt" AS "establishedAt",
            ms."libraryResyncRequiredAt" AS "heldAt",
            (SELECT MAX(wh."watchedAt") FROM "WatchHistory" wh WHERE wh."mediaServerId" = ms."id") AS "newest"
       FROM "MediaServer" ms
      WHERE ms."id" = $1`,
    serverId
  );
  const row = rows[0];
  const held = row?.heldAt != null;
  if (!row?.newest || (!row.establishedAt && !held)) return null;
  return {
    since: new Date(new Date(row.newest).getTime() - INCREMENTAL_OVERLAP_MS),
    held,
  };
}

/**
 * Store the entries not already present. A play's identity is item +
 * watchedAt (to the second) + account, checked against the rows stored since
 * `since`; undated entries are skipped (Plex always dates a play). A play whose
 * account could not be named is stored as "Unknown", so "Unknown" on either
 * side pairs with one otherwise-unmatched play at the same item and second —
 * exact names first — or the overlap would append it again, for good
 * (`playCount` is monotonic). Two real names stay two plays. A stored
 * "Unknown" so paired is relabelled to the name.
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
    await assertStillNative(tx, serverId);

    // As in the full replace: drop plays of items deleted since the map was read.
    const resolved = dated.map((entry) => ({ entry, ids: resolveItem.resolve(entry) }));
    const live = await liveItemIds(tx, resolved);

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

    // Collapse plays the response repeats (same item, instant and name). Keyed
    // per item, so each copy of a fanned-out play is matched on its own, with
    // the primary chosen exactly as the full replace chooses it.
    const incoming: Array<{ key: string; row: NativeRow; matched: boolean }> = [];
    const repeated = new Set<string>();
    for (const { entry, ids } of resolved) {
      for (const row of nativeRowsForPlay(ids.filter((id) => live.has(id)), entry)) {
        const key = playInstantKey(row.mediaItemId, entry.watchedAt!);
        const exact = `${key}|${entry.username}`;
        if (repeated.has(exact)) continue;
        repeated.add(exact);
        incoming.push({ key, row, matched: false });
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
    return insertNativeRows(tx, serverId, fresh);
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
 * A rating key is unique only within a library, so one server can hold it in
 * two, and `keysServerUnique` says what that means:
 * - Plex keys are server-wide, so a duplicate is a stale row: only the play's
 *   `librarySectionID` can pick the live one, and without it the play is
 *   skipped — a dropped play beats one on the wrong item (`playCount` is
 *   monotonic).
 * - Jellyfin/Emby list one item in two libraries over the same folder and send
 *   no section, so the play is filed against every copy (skipped, both read
 *   as unwatched); see `nativeRowsForPlay`.
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
        // It names a library none of the rows are in: on Plex all are stale.
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

type RawClient = Pick<typeof prisma, "$executeRawUnsafe" | "$queryRawUnsafe">;

type NativeEntry = Pick<
  DetailedWatchHistoryEntry,
  "username" | "watchedAt" | "deviceName" | "platform"
>;

interface NativeRow {
  mediaItemId: string;
  /** The copy holding the play's primary row (`WatchHistory.fanOutOfItemId`); null on it. */
  fanOutOfItemId: string | null;
  entry: NativeEntry;
}

/**
 * The rows one play is stored as, one per copy it was filed against — the ONE
 * place both writers build them, so they agree on the primary. Every copy must
 * read as watched to per-item consumers, but play lists show a play once, so
 * every row but the primary's names the primary copy: the lowest id (plain
 * string order). Callers pass only live ids, which re-picks it when its copy
 * is gone. Stored rows are not re-pointed: deleting the primary copy `SetNull`s
 * every survivor, so with 3+ copies the play lists once per survivor until the
 * next full replace rebuilds its rows (a set-aside user's: once they are read).
 */
function nativeRowsForPlay(mediaItemIds: string[], entry: NativeEntry): NativeRow[] {
  if (mediaItemIds.length <= 1) {
    return mediaItemIds.map((mediaItemId) => ({ mediaItemId, fanOutOfItemId: null, entry }));
  }
  const [primary, ...copies] = [...mediaItemIds].sort();
  return [
    { mediaItemId: primary, fanOutOfItemId: null, entry },
    ...copies.map((mediaItemId) => ({ mediaItemId, fanOutOfItemId: primary, entry })),
  ];
}

/** Which of the resolved items still exist; read inside the write transaction. */
async function liveItemIds(
  db: RawClient,
  plays: Array<{ ids: string[] }>,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const play of plays) for (const id of play.ids) ids.add(id);
  if (ids.size === 0) return ids;
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "MediaItem" WHERE "id" = ANY($1::text[])`,
    [...ids],
  );
  return new Set(rows.map((row) => row.id));
}

type StoredDevices = Map<string, { deviceName: string | null; platform: string | null }>;

/** A stored play's identity for carrying its device over: item + second + account. */
function storedDeviceKey(mediaItemId: string, watchedAt: Date | string, username: string): string {
  return `${playInstantKey(mediaItemId, watchedAt)}|${username}`;
}

/**
 * The device and platform already stored per play, read before the replace
 * deletes them, for when `/devices` failed (`devicesUnavailable`).
 */
async function loadStoredDevices(db: RawClient, serverId: string): Promise<StoredDevices> {
  const rows = await db.$queryRawUnsafe<
    {
      mediaItemId: string;
      serverUsername: string;
      watchedAt: Date;
      deviceName: string | null;
      platform: string | null;
    }[]
  >(
    `SELECT "mediaItemId", "serverUsername", "watchedAt", "deviceName", "platform"
       FROM "WatchHistory"
      WHERE "mediaServerId" = $1 AND "watchedAt" IS NOT NULL
        AND ("deviceName" IS NOT NULL OR "platform" IS NOT NULL)`,
    serverId,
  );
  const stored: StoredDevices = new Map();
  for (const row of rows) {
    stored.set(storedDeviceKey(row.mediaItemId, row.watchedAt, row.serverUsername), {
      deviceName: row.deviceName,
      platform: row.platform,
    });
  }
  return stored;
}

/** `row`, with the stored device and platform of the same play filling any gap. */
function withStoredDevice(row: NativeRow, stored: StoredDevices): NativeRow {
  const { entry } = row;
  if (!entry.watchedAt || (entry.deviceName != null && entry.platform != null)) return row;
  const prior = stored.get(storedDeviceKey(row.mediaItemId, entry.watchedAt, entry.username));
  if (!prior) return row;
  return {
    ...row,
    entry: {
      ...entry,
      deviceName: entry.deviceName ?? prior.deviceName,
      platform: entry.platform ?? prior.platform,
    },
  };
}

/**
 * Serialises every writer of one server's native history. Transaction-scoped
 * (released on commit or rollback), keyed per server so two servers never
 * wait on each other. Both the full replace and the incremental append take
 * it; see `appendNewEntries` for the race it closes. The server PUT takes it
 * too, before it changes the server's watch-history source.
 */
async function lockServerHistory(db: RawClient, serverId: string): Promise<void> {
  await db.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext('watch-history:' || $1))`,
    serverId
  );
}

/**
 * Called by every native write straight after `lockServerHistory`: refuse when
 * the server was mapped to Tracearr (or deleted) during the fetch — the
 * replace's DELETE is not scoped by source, so it would destroy TRACEARR rows
 * and leave both strata, doubling `playCount` for good. Decisive because the
 * server PUT takes the same lock before its UPDATE; a separate statement, so a
 * fresh READ COMMITTED snapshot. A plain read, not a row lock, so a PUT that
 * changes nothing about the source never waits out a replace.
 */
async function assertStillNative(db: RawClient, serverId: string): Promise<void> {
  const rows = await db.$queryRawUnsafe<{ tracearrServerId: string | null }[]>(
    `SELECT "tracearrServerId" FROM "MediaServer" WHERE "id" = $1`,
    serverId,
  );
  if (rows.length === 0) throw new WatchHistorySourceChangedError(true);
  if (rows[0].tracearrServerId) throw new WatchHistorySourceChangedError(false);
}

/**
 * Multi-row INSERTs of native play rows, BATCH_SIZE rows per statement — the
 * one column list both writers use. Split here, not by the callers: one play
 * can be several rows, and the bind limit is per statement.
 */
async function insertNativeRows(db: RawClient, serverId: string, rows: NativeRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { randomUUID } = await import("crypto");
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const values: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;
    for (const { mediaItemId, fanOutOfItemId, entry } of rows.slice(start, start + BATCH_SIZE)) {
      values.push(
        `($${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++})`
      );
      params.push(
        randomUUID(),
        mediaItemId,
        fanOutOfItemId,
        serverId,
        entry.username,
        entry.watchedAt ? new Date(entry.watchedAt) : null,
        entry.deviceName,
        entry.platform,
        new Date()
      );
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "WatchHistory" ("id","mediaItemId","fanOutOfItemId","mediaServerId","serverUsername","watchedAt","deviceName","platform","createdAt")
       VALUES ${values.join(",")}`,
      ...params
    );
  }
  return rows.length;
}
