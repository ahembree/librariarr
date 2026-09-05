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
import { enqueueJob } from "@/lib/jobs/client";
import { TASK_TRACEARR_BACKFILL, MAIN_QUEUE } from "@/lib/jobs/constants";
import { markWatchHistoryEstablished } from "@/lib/media/watch-evidence";

// 500 rows × 8 params = 4000 bind params per INSERT — well under Postgres's
// 65535 limit, but ~5× fewer round-trips than 100, which keeps the full-replace
// transaction comfortably inside its timeout on large histories.
const BATCH_SIZE = 500;

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
async function markHistoryEstablished(serverId: string): Promise<void> {
  await markWatchHistoryEstablished([serverId]);
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
  signal?: AbortSignal
): Promise<{ count: number }> {
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
    }[]
  >(
    `SELECT "id","name","url","accessToken","type","tlsSkipVerify","enabled","userId","tracearrServerId" FROM "MediaServer" WHERE "id"=$1`,
    serverId
  );

  if (serverRows.length === 0) {
    throw new Error(`MediaServer not found: ${serverId}`);
  }
  const server = serverRows[0];

  if (!server.enabled) {
    logger.info(
      "WatchHistory",
      `Skipping watch history sync for disabled server "${server.name}"`
    );
    return { count: 0 };
  }

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
      return { count: 0 };
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
    {
      await enqueueJob(
        TASK_TRACEARR_BACKFILL,
        { serverId },
        {
          jobKey: `tracearr-backfill:${serverId}`,
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

    return { count: result.count };
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
  let entries: Awaited<ReturnType<typeof client.getDetailedWatchHistory>>;
  try {
    entries = await client.getDetailedWatchHistory();
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Skipping watch history sync for "${server.name}" — fetch failed; leaving existing history intact`,
      { error: String(error) }
    );
    return { count: 0 };
  }
  logger.info(
    "WatchHistory",
    `Got ${entries.length} play events from "${server.name}"`
  );

  if (entries.length === 0) {
    // Still clear old records in case items were removed
    await prisma.$queryRawUnsafe(
      `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1`,
      serverId
    );
    // ...and release the marker here too. This is a SUCCESSFUL full replace —
    // the fetch threw on a hard failure above, so reaching here means the
    // server genuinely reports no plays, which is a complete and faithful
    // record of its history. Returning early without clearing left a server
    // switched Tracearr → native whose native history is legitimately empty
    // (a fresh Plex, or Jellyfin degrading to a per-user response) marked
    // un-evidenced FOREVER, silently pausing every `watchedByUser` rule set
    // scoped to it with nothing that could ever release it.
    await markHistoryEstablished(serverId);
    return { count: 0 };
  }

  // Build a lookup from ratingKey -> mediaItemId for this server's items
  const mediaItems = await prisma.$queryRawUnsafe<
    { id: string; ratingKey: string }[]
  >(
    `SELECT mi."id", mi."ratingKey" FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l."id"
     WHERE l."mediaServerId"=$1`,
    serverId
  );

  const ratingKeyToId = new Map<string, string>();
  for (const item of mediaItems) {
    ratingKeyToId.set(item.ratingKey, item.id);
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
  const { randomUUID } = await import("crypto");

  // Wrap the full-replace DELETE and all batch INSERTs in a single transaction
  // so a mid-insert failure rolls back instead of leaving the table empty
  // (the previous out-of-transaction version permanently wiped history on any
  // insert error until the next successful sync).
  await prisma.$transaction(async (tx) => {
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
      const values: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      for (const entry of batch) {
        const mediaItemId = ratingKeyToId.get(entry.ratingKey);
        if (!mediaItemId) continue;

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

      if (values.length > 0) {
        // No setImmediate yield between batches: the awaited DB round-trip
        // already yields the event loop, and an extra macrotask only burns the
        // interactive-transaction timeout budget.
        await tx.$executeRawUnsafe(
          `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","deviceName","platform","createdAt")
           VALUES ${values.join(",")}`,
          ...params
        );
        insertedCount += values.length;
      }

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
        detail: `Stored ${insertedCount.toLocaleString()} of ${formatPlayCount(
          dedupedEntries.length
        )}`,
      });
    }
  }, TX_OPTIONS);

  await markHistoryEstablished(serverId);

  logger.info(
    "WatchHistory",
    `Synced ${insertedCount} watch history entries for "${server.name}" ` +
      `(${dedupedEntries.length - insertedCount} unmatched, ` +
      `${entries.length - dedupedEntries.length} duplicates removed)`
  );

  // Push the freshly stored history into `MediaItem.playCount`/`lastPlayedAt`.
  // Those columns are what the rule and query engines read (`lastPlayedAt`, and
  // the `seriesLastPlayedAt` aggregate rolled up from it), but the item sync
  // derives them from account-scoped server metadata — so a play by any other
  // user on the server landed in `WatchHistory` and nowhere else. Non-fatal:
  // the history rows are already committed, so a failure here is corrected by
  // the next sync rather than being worth failing the whole run over.
  try {
    await reconcileWatchStateFromHistory(serverId);
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Failed to reconcile play state from watch history for "${server.name}"`,
      { error: String(error) }
    );
  }

  return { count: insertedCount };
}
