import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import {
  MAIN_QUEUE,
  TASK_SYNC_SERVER,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
} from "@/lib/jobs/constants";
import { logger } from "@/lib/logger";

/**
 * Run a scheduled job now — the Settings "Run now" buttons and the public
 * API's `/api/v1/jobs/*` endpoints. One implementation so the two cannot
 * drift: same dedup keys, same watermarks, same queue.
 */

export type RunNowJob = "sync" | "detection" | "execution";

export type RunNowResult = { ok: true } | { ok: false; error: string };

export async function runJobNow(
  userId: string,
  job: RunNowJob,
  /**
   * Where the request came from, worded to follow "Manual sync" — e.g. "from
   * Settings (Run now)". Logged, and part of every sync job's `trigger`.
   */
  source: string,
): Promise<RunNowResult> {
  if (job === "sync") {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { mediaServers: true },
    });
    let allEnqueued = true;
    if (user) {
      // Enqueue a durable sync job per enabled server. Enqueueing is
      // non-blocking and error-isolated, so one unreachable server can't
      // abort syncing the rest (the worker retries each job independently).
      for (const server of user.mediaServers) {
        if (!server.enabled) continue;
        const activeJob = await prisma.syncJob.findFirst({
          where: { mediaServerId: server.id, status: { in: ["RUNNING", "PENDING"] } },
          select: { id: true },
        });
        if (activeJob) continue;
        logger.info("Scheduler", `Manual sync triggered for server "${server.name}" ${source}`);
        const ok = await enqueueJob(
          TASK_SYNC_SERVER,
          { serverId: server.id, trigger: `manual sync ${source}` },
          { jobKey: `sync:${server.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
        );
        if (!ok) allEnqueued = false;
      }
    }
    // Advance the watermark only when every enqueue succeeded, so a failed
    // enqueue doesn't stamp "last run" and skip the next scheduled window.
    if (allEnqueued) {
      await prisma.appSettings.update({
        where: { userId },
        data: { lastScheduledSync: new Date() },
      });
    }
    return { ok: true };
  }

  if (job === "detection") {
    logger.info("Scheduler", `Manual lifecycle detection triggered ${source}`);
    // Enqueue a durable job on MAIN_QUEUE with a stable jobKey so a
    // double-click or a collision with the per-minute dispatcher dedupes
    // into one run instead of executing detection concurrently.
    const ok = await enqueueJob(
      TASK_LIFECYCLE_DETECTION,
      { userId },
      { jobKey: `detection:${userId}`, queueName: MAIN_QUEUE, maxAttempts: 2 },
    );
    if (!ok) return { ok: false, error: "Failed to enqueue detection job" };
    await prisma.appSettings.update({
      where: { userId },
      data: { lastScheduledLifecycleDetection: new Date() },
    });
    return { ok: true };
  }

  logger.info("Scheduler", `Manual lifecycle execution triggered ${source}`);
  // Same dedup guard as detection. maxAttempts: 1 mirrors the dispatcher —
  // execution applies destructive Arr actions and must not be retried as a
  // whole job.
  const ok = await enqueueJob(
    TASK_LIFECYCLE_EXECUTION,
    { userId },
    { jobKey: `execution:${userId}`, queueName: MAIN_QUEUE, maxAttempts: 1 },
  );
  if (!ok) return { ok: false, error: "Failed to enqueue execution job" };
  await prisma.appSettings.update({
    where: { userId },
    data: { lastScheduledLifecycleExecution: new Date() },
  });
  return { ok: true };
}
