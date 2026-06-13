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
 * for any work that is due. The `lastScheduled*` watermark is advanced only
 * AFTER the enqueue succeeds — `enqueueJob` swallows errors, so advancing the
 * watermark first would permanently skip a window whose enqueue failed. Once
 * the job is durably queued the worker retries it on its own if it fails mid-run.
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
      try {
        let allEnqueued = true;
        for (const server of settings.user.mediaServers) {
          if (!server.enabled) continue;
          const ok = await enqueueJob(
            TASK_SYNC_SERVER,
            { serverId: server.id },
            { jobKey: `sync:${server.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
          );
          if (!ok) allEnqueued = false;
        }
        // Advance the watermark only when every server's job is durably queued.
        // On partial failure we leave it unadvanced so the next tick retries;
        // the per-server jobKey dedupes the already-queued ones.
        if (allEnqueued) {
          await prisma.appSettings.update({
            where: { id: settings.id },
            data: { lastScheduledSync: now },
          });
        } else {
          logger.error("Jobs", "Scheduled sync enqueue failed for one or more servers — leaving watermark unadvanced");
        }
      } catch (error) {
        logger.error("Jobs", "Failed to dispatch scheduled sync — leaving watermark unadvanced", { error: String(error) });
      }
    }

    // --- Scheduled lifecycle detection ---
    if (isScheduleDue(
      settings.lifecycleDetectionSchedule,
      settings.lastScheduledLifecycleDetection,
      now,
      settings.scheduledJobTime,
    )) {
      try {
        const ok = await enqueueJob(
          TASK_LIFECYCLE_DETECTION,
          { userId: settings.userId },
          { jobKey: `detection:${settings.userId}`, queueName: MAIN_QUEUE, maxAttempts: 2 },
        );
        if (ok) {
          await prisma.appSettings.update({
            where: { id: settings.id },
            data: { lastScheduledLifecycleDetection: now },
          });
        } else {
          logger.error("Jobs", "Lifecycle detection enqueue failed — leaving watermark unadvanced");
        }
      } catch (error) {
        logger.error("Jobs", "Failed to dispatch lifecycle detection — leaving watermark unadvanced", { error: String(error) });
      }
    }

    // --- Scheduled lifecycle execution ---
    if (isScheduleDue(
      settings.lifecycleExecutionSchedule,
      settings.lastScheduledLifecycleExecution,
      now,
      settings.scheduledJobTime,
    )) {
      try {
        // maxAttempts: 1 — execution performs destructive Arr actions (delete,
        // unmonitor). It marks each action COMPLETED/FAILED individually, so a
        // whole-job retry could re-attempt already-applied actions and skew the
        // deletion stats. Any actions left PENDING are re-evaluated on the next
        // scheduled execution, matching the original (non-retrying) scheduler.
        const ok = await enqueueJob(
          TASK_LIFECYCLE_EXECUTION,
          { userId: settings.userId },
          { jobKey: `execution:${settings.userId}`, queueName: MAIN_QUEUE, maxAttempts: 1 },
        );
        if (ok) {
          await prisma.appSettings.update({
            where: { id: settings.id },
            data: { lastScheduledLifecycleExecution: now },
          });
        } else {
          logger.error("Jobs", "Lifecycle execution enqueue failed — leaving watermark unadvanced");
        }
      } catch (error) {
        logger.error("Jobs", "Failed to dispatch lifecycle execution — leaving watermark unadvanced", { error: String(error) });
      }
    }
  }

  // --- Scheduled backup (global, single-admin) ---
  const backupSettings = await prisma.appSettings.findFirst({
    select: { id: true, backupSchedule: true, lastBackupAt: true, scheduledJobTime: true },
  });

  if (
    backupSettings &&
    backupSettings.backupSchedule !== "MANUAL" &&
    isScheduleDue(backupSettings.backupSchedule, backupSettings.lastBackupAt, now, backupSettings.scheduledJobTime)
  ) {
    try {
      const ok = await enqueueJob(
        TASK_SCHEDULED_BACKUP,
        {},
        { jobKey: "scheduled-backup", queueName: MAIN_QUEUE, maxAttempts: 3 },
      );
      if (ok) {
        // Advance the watermark only after the job is durably queued, and scope
        // the update to the single AppSettings row.
        await prisma.appSettings.update({
          where: { id: backupSettings.id },
          data: { lastBackupAt: now },
        });
        logger.info("Jobs", "Enqueued scheduled backup");
      } else {
        logger.error("Jobs", "Scheduled backup enqueue failed — leaving watermark unadvanced");
      }
    } catch (error) {
      logger.error("Jobs", "Failed to dispatch scheduled backup — leaving watermark unadvanced", { error: String(error) });
    }
  }
}
