import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isScheduleDue } from "@/lib/jobs/schedule";
import { enqueueJob } from "@/lib/jobs/client";
import {
  MAIN_QUEUE,
  TASK_SYNC_SERVER,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
  TASK_SCHEDULED_BACKUP,
} from "@/lib/jobs/constants";

/**
 * Per-minute dispatcher (run by Graphile Worker cron).
 *
 * Evaluates the user-configured, DB-stored schedules and enqueues durable jobs
 * for any work that is due. The `lastScheduled*` timestamp is advanced BEFORE
 * enqueueing so a restart never re-triggers the same window — the enqueued job
 * itself is retried by the worker if it fails mid-run.
 *
 * `jobKey` deduplicates pending work (e.g. the dispatcher firing again while a
 * sync is still queued), and `MAIN_QUEUE` serializes the heavy domain jobs to
 * mirror the original sequential scheduler.
 */
export async function dispatchScheduledJobs(): Promise<void> {
  const now = new Date();

  const allSettings = await prisma.appSettings.findMany({
    include: {
      user: {
        include: { mediaServers: true },
      },
    },
  });

  for (const settings of allSettings) {
    // --- Scheduled media sync ---
    if (isScheduleDue(settings.syncSchedule, settings.lastScheduledSync, now, settings.scheduledJobTime)) {
      await prisma.appSettings.update({
        where: { id: settings.id },
        data: { lastScheduledSync: now },
      });

      for (const server of settings.user.mediaServers) {
        if (!server.enabled) continue;
        await enqueueJob(
          TASK_SYNC_SERVER,
          { serverId: server.id },
          { jobKey: `sync:${server.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
        );
      }
    }

    // --- Scheduled lifecycle detection ---
    if (isScheduleDue(
      settings.lifecycleDetectionSchedule,
      settings.lastScheduledLifecycleDetection,
      now,
      settings.scheduledJobTime,
    )) {
      await prisma.appSettings.update({
        where: { id: settings.id },
        data: { lastScheduledLifecycleDetection: now },
      });
      await enqueueJob(
        TASK_LIFECYCLE_DETECTION,
        { userId: settings.userId },
        { jobKey: `detection:${settings.userId}`, queueName: MAIN_QUEUE, maxAttempts: 2 },
      );
    }

    // --- Scheduled lifecycle execution ---
    if (isScheduleDue(
      settings.lifecycleExecutionSchedule,
      settings.lastScheduledLifecycleExecution,
      now,
      settings.scheduledJobTime,
    )) {
      await prisma.appSettings.update({
        where: { id: settings.id },
        data: { lastScheduledLifecycleExecution: now },
      });
      // maxAttempts: 1 — execution performs destructive Arr actions (delete,
      // unmonitor). It marks each action COMPLETED/FAILED individually, so a
      // whole-job retry could re-attempt already-applied actions and skew the
      // deletion stats. Any actions left PENDING are re-evaluated on the next
      // scheduled execution, matching the original (non-retrying) scheduler.
      await enqueueJob(
        TASK_LIFECYCLE_EXECUTION,
        { userId: settings.userId },
        { jobKey: `execution:${settings.userId}`, queueName: MAIN_QUEUE, maxAttempts: 1 },
      );
    }
  }

  // --- Scheduled backup (global, single-admin) ---
  const backupSettings = await prisma.appSettings.findFirst({
    select: { backupSchedule: true, lastBackupAt: true, scheduledJobTime: true },
  });

  if (
    backupSettings &&
    backupSettings.backupSchedule !== "MANUAL" &&
    isScheduleDue(backupSettings.backupSchedule, backupSettings.lastBackupAt, now, backupSettings.scheduledJobTime)
  ) {
    await prisma.appSettings.updateMany({ data: { lastBackupAt: now } });
    await enqueueJob(
      TASK_SCHEDULED_BACKUP,
      {},
      { jobKey: "scheduled-backup", queueName: MAIN_QUEUE, maxAttempts: 3 },
    );
    logger.info("Jobs", "Enqueued scheduled backup");
  }
}
