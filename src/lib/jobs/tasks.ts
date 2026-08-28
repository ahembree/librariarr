import type { Task, TaskList } from "graphile-worker";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { syncMediaServer } from "@/lib/sync/sync-server";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { syncMediaServerItems } from "@/lib/sync/sync-incremental";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
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
  const { serverId, libraryKey, skipWatchHistory } = payload as SyncServerPayload;

  // Skip if a sync is already in progress for this server (belt-and-suspenders
  // alongside the queue serialization and the sync engine's own semaphore).
  const running = await prisma.syncJob.findFirst({
    where: { mediaServerId: serverId, status: { in: ["RUNNING", "PENDING"] } },
    select: { id: true },
  });
  if (running) {
    logger.info("Jobs", `Skipping sync for server ${serverId} — already running`);
    return;
  }

  await syncMediaServer(serverId, libraryKey, skipWatchHistory ? { skipWatchHistory: true } : undefined);
};

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

const syncIncremental: Task = async (payload) => {
  const { serverId, changedIds, removedIds } = payload as SyncIncrementalPayload;
  const result = await syncMediaServerItems(serverId, changedIds ?? [], removedIds ?? []);
  if (result.status === "fell-back") {
    logger.info("Jobs", `Incremental sync for ${serverId} fell back to full sync (${result.reason})`);
    // Same jobKey as the scheduler so it dedupes with any pending full sync.
    await enqueueJob(
      TASK_SYNC_SERVER,
      { serverId },
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
  [TASK_LIFECYCLE_DETECTION]: lifecycleDetection,
  [TASK_LIFECYCLE_EXECUTION]: lifecycleExecution,
  [TASK_SCHEDULED_BACKUP]: scheduledBackup,
  [TASK_ARCHIVE_LOGS]: archiveLogsTask,
  [TASK_CLEANUP_ACTIONS]: cleanupActionsTask,
  [TASK_PRUNE_IMAGE_CACHE]: pruneImageCacheTask,
};
