import type { Task, TaskList } from "graphile-worker";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { syncMediaServer } from "@/lib/sync/sync-server";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { syncMediaServerItems } from "@/lib/sync/sync-incremental";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { emitWatchHistoryUpdated } from "@/lib/sync/watch-history-events";
import { processLifecycleRules, executeLifecycleActions } from "@/lib/lifecycle/processor";
import { createBackup, getBackupPassphrase, pruneBackups } from "@/lib/backup/backup-service";
import { archiveLogs } from "@/lib/logs/archive";
import { pruneImageCache } from "@/lib/image-cache/image-cache";
import { dispatchScheduledJobs } from "@/lib/jobs/dispatch";
import { enqueueJob } from "@/lib/jobs/client";
import {
  TASK_DISPATCH,
  TASK_SYNC_SERVER,
  TASK_SYNC_WATCH_HISTORY,
  TASK_TRACEARR_BACKFILL,
  TASK_SYNC_INCREMENTAL,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
  TASK_SCHEDULED_BACKUP,
  TASK_ARCHIVE_LOGS,
  TASK_CLEANUP_ACTIONS,
  TASK_PRUNE_IMAGE_CACHE,
  MAIN_QUEUE,
  type SyncServerPayload,
  type SyncWatchHistoryPayload,
  type SyncIncrementalPayload,
  type UserPayload,
  type LifecycleExecutionPayload,
} from "@/lib/jobs/constants";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { recoverHistoryForNewItems } from "@/lib/sync/tracearr-backfill-additions";
import { watchForCancel } from "@/lib/sync/cancel-watch";

/** Remove completed/failed lifecycle actions older than the retention window. */
export async function cleanupOldActions(): Promise<void> {
  // Orphaned PENDING actions whose media item was purged from the DB (the FK is
  // SetNull, so mediaItemId goes null) can never execute and are never swept by the
  // retention pass below — garbage-collect them unconditionally, even when retention
  // is set to "keep forever".
  const orphans = await prisma.lifecycleAction.deleteMany({
    where: { status: "PENDING", mediaItemId: null },
  });
  if (orphans.count > 0) {
    logger.info("Jobs", `Action cleanup: removed ${orphans.count} orphaned pending actions (media item no longer exists)`);
  }

  const settings = await prisma.appSettings.findFirst({
    select: { actionHistoryRetentionDays: true },
  });
  const retentionDays = settings?.actionHistoryRetentionDays ?? 30;
  if (retentionDays === 0) return; // 0 = keep forever

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const deleted = await prisma.lifecycleAction.deleteMany({
    where: {
      status: { not: "PENDING" },
      createdAt: { lt: cutoff },
    },
  });

  if (deleted.count > 0) {
    logger.info("Jobs", `Action cleanup: removed ${deleted.count} entries older than ${retentionDays} days`);
  }
}

/** Create a database backup and prune old ones to the configured retention count. */
export async function runScheduledBackup(): Promise<void> {
  const settings = await prisma.appSettings.findFirst({
    select: { backupRetentionCount: true },
  });
  const passphrase = await getBackupPassphrase();
  if (!passphrase) {
    logger.warn(
      "Jobs",
      "Scheduled backup is UNENCRYPTED — it contains plaintext secrets. Set a backup encryption password under Settings → General."
    );
  }
  await createBackup(passphrase);
  await pruneBackups(settings?.backupRetentionCount ?? 7);
  logger.info("Jobs", "Scheduled backup completed");
}

const dispatch: Task = async () => {
  await dispatchScheduledJobs();
};

const syncServer: Task = async (payload) => {
  const { serverId, libraryKey, skipWatchHistory, trigger, syncJobId } = payload as SyncServerPayload;

  // Skip if a sync is already in progress for this server (belt-and-suspenders
  // alongside the queue serialization and the sync engine's own semaphore).
  // RUNNING only: a PENDING row is a queued sync waiting for its job — usually
  // this very job, whose row the sync route created at enqueue time — and the
  // run below claims it. Counting PENDING here made every such job skip itself.
  const running = await prisma.syncJob.findFirst({
    where: { mediaServerId: serverId, status: "RUNNING" },
    select: { id: true },
  });
  if (running) {
    logger.info(
      "Jobs",
      `Skipping sync for server ${serverId} (${trigger ?? "trigger not recorded"}) — already running`,
    );
    return;
  }

  // The trigger rides along so the sync's own "Starting sync" line says why it
  // ran — the job payload is the only place that knowledge survives the hop
  // through the queue.
  await syncMediaServer(serverId, libraryKey, {
    ...(skipWatchHistory ? { skipWatchHistory: true } : {}),
    ...(trigger ? { trigger } : {}),
    ...(syncJobId ? { syncJobId } : {}),
  });
};

/**
 * How long one backfill slice may run.
 *
 * Bounded below by the per-run cost of `buildTracearrJoinIndex`, which loads
 * every candidate item on the server: slice too finely and each run re-pays
 * that before importing anything. Bounded above by `MAIN_QUEUE` being serial —
 * syncs and lifecycle runs queue behind this.
 */
const TRACEARR_BACKFILL_SLICE_MS = 5 * 60_000;

const syncWatchHistoryTask: Task = async (payload) => {
  const { serverId, incremental = false } = payload as SyncWatchHistoryPayload;

  // A full sync already refreshes watch history — if one is running/queued for
  // this server, skip the standalone refresh to avoid redundant work.
  const running = await prisma.syncJob.findFirst({
    where: { mediaServerId: serverId, status: { in: ["RUNNING", "PENDING"] } },
    select: { id: true },
  });
  if (running) {
    logger.info("Jobs", `Skipping watch-history refresh for server ${serverId} — full sync in progress`);
    return;
  }

  // The realtime manager enqueues this per finished playback with
  // `incremental`, so it appends only the plays since the last one rather than
  // re-importing the server's whole history (see `WatchHistorySyncOptions`).
  // Without the flag — `/api/sync/by-type`'s deferred refresh — it is the full
  // replace, which is what reconciles plays the server has since deleted.
  const { count, failed } = await syncWatchHistory(serverId, undefined, undefined, { incremental });
  // Watch-history-derived caches (filters, stats) must drop so listings reflect
  // the fresh play data instead of waiting out the TTL. An incremental run that
  // appended nothing changed nothing, and it fires per playback, so it keeps
  // every cached listing; a full replace may have removed rows even at count 0
  // — unless it failed, in which case it never reached its write.
  if (count > 0 || (!incremental && !failed)) invalidateMediaCaches();
  // A run that could not sync left the stored history intact and returned
  // rather than threw — but this job exists to bring that history up to date,
  // so it fails here: graphile-worker records the failure and retries with
  // backoff (`maxAttempts` at the enqueue sites) instead of logging a clean
  // "synced 0 entries" for a server it never reached. The realtime manager,
  // which enqueues this per finished playback, holds off while the failed job
  // backs off or for a cooldown after it parks (`isJobRetrying`), so a lasting
  // failure is not re-armed by every playback; the by-type refresh is under its
  // own key and never waits on that.
  if (failed) {
    throw new Error(`Watch-history refresh for server ${serverId} failed: ${failed}`);
  }
  logger.info("Jobs", `Watch-history refresh for server ${serverId} synced ${count} entries`);
};

/**
 * One time-sliced slice of a server's Tracearr history backfill.
 *
 * Tracearr serves history newest-first, so importing a server's archive means
 * walking backwards page by page — ~1,600 pages for a 160k-play library. That
 * cannot live in a request (it dies with the tab, and the progress stream caps
 * at 30 minutes) and it cannot be one long job either, because `MAIN_QUEUE` is
 * serial and an hours-long job would block every sync and lifecycle run behind
 * it.
 *
 * So each run takes a bounded slice and re-enqueues itself if there is more to
 * do. All the resume state lives in the database — the imported rows establish
 * the boundary and `MediaServer.tracearrBackfillComplete` records whether the
 * walk ever reached the end — so a slice that dies to a restart, a deploy or a
 * crash simply picks up from the oldest play it managed to import.
 */
/**
 * How long a PENDING SyncJob row counts as "a requested sync is waiting".
 * Bounded so a row whose job was lost (nothing claims it) cannot shrink every
 * later backfill slice to one page forever.
 */
const REQUESTED_SYNC_WAIT_WINDOW_MS = 60 * 60_000;

/**
 * Is a sync someone asked for queued behind this job? The sync route creates
 * its PENDING row at enqueue time, and nothing else leaves one behind while a
 * MAIN_QUEUE job runs (the queue is serial), so a recent PENDING row is exactly
 * that signal.
 */
async function requestedSyncWaiting(): Promise<boolean> {
  const waiting = await prisma.syncJob.findFirst({
    where: {
      status: "PENDING",
      startedAt: { gte: new Date(Date.now() - REQUESTED_SYNC_WAIT_WINDOW_MS) },
    },
    select: { id: true },
  });
  return waiting !== null;
}

const tracearrBackfill: Task = async (payload) => {
  const { serverId } = payload as SyncWatchHistoryPayload;

  // A slice holds the serial MAIN_QUEUE for up to five minutes, and a running
  // job cannot be pre-empted. So the slice watches for a requested sync and
  // ends itself at its next page boundary instead — the same resumable stop as
  // a spent deadline, after which the requested sync (higher priority) runs
  // and this re-enqueued slice follows it.
  //
  // One deadline and one watch for the whole job — the archive slice AND the
  // recovery pass after it — since together they are what holds the queue.
  const deadlineMs = Date.now() + TRACEARR_BACKFILL_SLICE_MS;
  const waitingSync = watchForCancel(requestedSyncWaiting);
  const yieldTo = () => waitingSync.signal.aborted;
  let result: Awaited<ReturnType<typeof syncTracearrHistory>>;
  let recovered = 0;
  try {
    result = await syncTracearrHistory(serverId, {
      passes: "backfill",
      deadlineMs,
      yieldTo,
    });

    // Re-import the plays of items that left the library and came back — their
    // `WatchHistory` was cascade-deleted with the old row, so they read as never
    // watched, which is what arms the destructive "not played in N months" rules.
    //
    // Only once the archive walk is finished. The walk is the priority: it is the
    // pass that has a deadline and a resume boundary, and these are one request
    // per item against the same rolling rate limit, so running them alongside it
    // would spend the slice and the limiter's budget on the smaller problem.
    //
    // Best-effort by design. A failure here must not fail a slice whose imported
    // rows are already committed — graphile-worker would retry the whole job, and
    // the recovery's own candidacy is re-derived from the rows on the next run
    // anyway, so there is nothing to lose by simply logging it.
    if (!result.backfillPending) {
      try {
        // Cheap when there is nothing to recover — the steady state of the job
        // queued after every forward sync: one indexed candidate query, and no
        // instance probe, join index or `/users` walk unless it finds a recent
        // addition to ask about. Bounded by the same slice and the same
        // requested-sync watch as the walk, so it cannot hold the queue past
        // the slice or in front of a sync the user is waiting on.
        ({ imported: recovered } = await recoverHistoryForNewItems(serverId, {
          deadlineMs,
          yieldTo,
        }));
      } catch (error) {
        logger.warn(
          "Jobs",
          `Tracearr history recovery for recently added items on server ${serverId} failed`,
          { error: String(error) },
        );
      }
    }
  } finally {
    waitingSync.stop();
  }

  // Only when something moved. This job is queued after EVERY forward sync —
  // per finished playback on a realtime server — and on a fully backfilled
  // server it almost always walks nothing and recovers nothing. Dropping every
  // media cache and making every open History/stats page refetch for that was
  // pure churn. "Moved" includes the slice that finished the walk with nothing
  // left to store: the backfill state the pages show changed even so.
  const finishedWalk = !result.backfillPending && result.backfillOutcome === "exhausted";
  if (result.count > 0 || recovered > 0 || finishedWalk) {
    // Watch-history-derived caches (filters, stats) must drop so listings
    // reflect the newly imported plays instead of waiting out the TTL.
    invalidateMediaCaches();
    // Once per slice (so ~once every 5 minutes over a multi-hour walk), tell
    // open pages the play data moved. `tracearr:import-progress` fires per page
    // but only drives the "still importing" notice; this is what makes the
    // rows, stats and dashboard actually reflect an import in flight.
    await emitWatchHistoryUpdated(serverId, {
      imported: result.count + recovered,
      backfillPending: result.backfillPending,
    });
  }

  if (!result.backfillPending) {
    // Logged only for a slice that actually walked: a no-op run on a finished
    // archive happens after every forward sync and is not news.
    if (result.backfillOutcome !== undefined || result.count > 0) {
      logger.info(
        "Jobs",
        `Tracearr backfill for server ${serverId} is complete (${result.count} row(s) this slice)`,
      );
    }
    return;
  }

  // Tracearr has no plays at all for this mapping — the walk is "exhausted"
  // having seen nothing, which deliberately does not mark the backfill
  // complete. Re-enqueueing would ask the same empty question again at once,
  // forever, holding MAIN_QUEUE and refetching every open tab each time. Stop
  // here; the next watch-history sync enqueues another slice, so plays that
  // appear later are still picked up.
  //
  // Not when the walk DID finish and only its completion write was refused: a
  // purge or restore restarted the walk (or the mapping moved) while this slice
  // ran, the archive is owed a fresh walk from the top, and stopping here left
  // it waiting for whatever happened to enqueue the next sync.
  if (result.backfillOutcome === "exhausted" && !result.completionLost) {
    logger.info(
      "Jobs",
      `Tracearr backfill for server ${serverId} found no history to import — ` +
        `not re-queueing; the next watch-history sync tries again`,
    );
    return;
  }

  // More history below. Re-enqueue under the SAME jobKey the foreground path
  // uses, so a user pressing Refresh mid-backfill collapses onto this run
  // rather than stacking a second walk over the same pages.
  logger.info(
    "Jobs",
    `Tracearr backfill for server ${serverId} imported ${result.count} row(s) this ` +
      `slice — queueing the next one`,
  );
  // A slice that could not reach Tracearr must NOT re-enqueue immediately.
  // Nothing about the next run would differ, so the job would spin as fast as
  // the queue can turn it over — hammering an instance that is already down and
  // burning the rate limit that the eventual recovery needs. Let the failure
  // propagate instead: graphile-worker retries it with its own exponential
  // backoff, and `maxAttempts` eventually parks it. A slice that merely ran out
  // of time made real progress and should continue straight away.
  if (result.backfillOutcome === "errored") {
    throw new Error(
      `Tracearr backfill slice for server ${serverId} could not reach Tracearr — ` +
        `letting the worker retry with backoff rather than re-queueing immediately`,
    );
  }

  await enqueueJob(
    TASK_TRACEARR_BACKFILL,
    { serverId },
    {
      jobKey: `tracearr-backfill:${serverId}`,
      queueName: MAIN_QUEUE,
      maxAttempts: 3,
    },
  );
};

const syncIncremental: Task = async (payload) => {
  const { serverId, changedIds, removedIds } = payload as SyncIncrementalPayload;
  const result = await syncMediaServerItems(serverId, changedIds ?? [], removedIds ?? []);
  if (result.status === "fell-back") {
    const trigger = `incremental sync fell back to a full sync: ${result.reason ?? "no reason given"}`;
    logger.info("Jobs", `Incremental sync for ${serverId} fell back to full sync (${result.reason})`);
    // Same jobKey as the scheduler so it dedupes with any pending full sync.
    // The reason rides along so the full sync's own start line repeats it.
    await enqueueJob(
      TASK_SYNC_SERVER,
      { serverId, trigger },
      { jobKey: `sync:${serverId}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
    );
  }
};

const lifecycleDetection: Task = async (payload) => {
  const { userId } = payload as UserPayload;
  await processLifecycleRules(userId);
};

const lifecycleExecution: Task = async (payload) => {
  const { userId, viaApiKey } = payload as LifecycleExecutionPayload;
  // A run queued through the public API carries the key's name, which holds
  // it to the API's destructive limits (see executeLifecycleActions).
  if (viaApiKey) await executeLifecycleActions(userId, { viaApiKey });
  else await executeLifecycleActions(userId);
};

const scheduledBackup: Task = async () => {
  await runScheduledBackup();
};

const archiveLogsTask: Task = async () => {
  await archiveLogs();
};

const cleanupActionsTask: Task = async () => {
  await cleanupOldActions();
};

const pruneImageCacheTask: Task = async () => {
  await pruneImageCache();
};

/** Complete Graphile Worker task list, keyed by task identifier. */
export const taskList: TaskList = {
  [TASK_DISPATCH]: dispatch,
  [TASK_SYNC_SERVER]: syncServer,
  [TASK_SYNC_WATCH_HISTORY]: syncWatchHistoryTask,
  [TASK_SYNC_INCREMENTAL]: syncIncremental,
  [TASK_TRACEARR_BACKFILL]: tracearrBackfill,
  [TASK_LIFECYCLE_DETECTION]: lifecycleDetection,
  [TASK_LIFECYCLE_EXECUTION]: lifecycleExecution,
  [TASK_SCHEDULED_BACKUP]: scheduledBackup,
  [TASK_ARCHIVE_LOGS]: archiveLogsTask,
  [TASK_CLEANUP_ACTIONS]: cleanupActionsTask,
  [TASK_PRUNE_IMAGE_CACHE]: pruneImageCacheTask,
};
