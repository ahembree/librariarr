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
} from "@/lib/jobs/constants";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { recoverHistoryForNewItems } from "@/lib/sync/tracearr-backfill-additions";

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
  await createBackup(passphrase);
  await pruneBackups(settings?.backupRetentionCount ?? 7);
  logger.info("Jobs", "Scheduled backup completed");
}

const dispatch: Task = async () => {
  await dispatchScheduledJobs();
};

const syncServer: Task = async (payload) => {
  const { serverId, libraryKey, skipWatchHistory, trigger } = payload as SyncServerPayload;

  // Skip if a sync is already in progress for this server (belt-and-suspenders
  // alongside the queue serialization and the sync engine's own semaphore).
  const running = await prisma.syncJob.findFirst({
    where: { mediaServerId: serverId, status: { in: ["RUNNING", "PENDING"] } },
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
  const { serverId } = payload as SyncWatchHistoryPayload;

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

  const { count } = await syncWatchHistory(serverId);
  // Watch-history-derived caches (filters, stats) must drop so listings reflect
  // the fresh play data instead of waiting out the TTL.
  invalidateMediaCaches();
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
const tracearrBackfill: Task = async (payload) => {
  const { serverId } = payload as SyncWatchHistoryPayload;

  const result = await syncTracearrHistory(serverId, {
    passes: "backfill",
    deadlineMs: Date.now() + TRACEARR_BACKFILL_SLICE_MS,
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
      await recoverHistoryForNewItems(serverId);
    } catch (error) {
      logger.warn(
        "Jobs",
        `Tracearr history recovery for recently added items on server ${serverId} failed`,
        { error: String(error) },
      );
    }
  }

  // Watch-history-derived caches (filters, stats) must drop so listings reflect
  // the newly imported plays instead of waiting out the TTL.
  invalidateMediaCaches();
  // Once per slice (so ~once every 5 minutes over a multi-hour walk), tell open
  // pages the play data moved. `tracearr:import-progress` fires per page but
  // only drives the "still importing" notice; this is what makes the rows,
  // stats and dashboard actually reflect an import in flight.
  await emitWatchHistoryUpdated(serverId, {
    imported: result.count,
    backfillPending: result.backfillPending,
  });

  if (!result.backfillPending) {
    logger.info(
      "Jobs",
      `Tracearr backfill for server ${serverId} is complete (${result.count} row(s) this slice)`,
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
  const { userId } = payload as UserPayload;
  await executeLifecycleActions(userId);
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
