import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import {
  MAIN_QUEUE,
  TASK_SYNC_SERVER,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
  type LifecycleExecutionPayload,
} from "@/lib/jobs/constants";
import { logger } from "@/lib/logger";

/**
 * Run a scheduled job now — the Settings "Run now" buttons and the public
 * API's `/api/v1/jobs/*` endpoints. One implementation so the two cannot
 * drift: same dedup keys, same watermarks, same queue.
 */

export type RunNowJob = "sync" | "detection" | "execution";

/** `jobs`: how many jobs this call queued — for a sync, one per enabled server not already syncing. */
type RunNowResult = { ok: true; jobs: number } | { ok: false; error: string };

export async function runJobNow(
  userId: string,
  job: RunNowJob,
  /**
   * Where the request came from, worded to follow "Manual sync" — e.g. "from
   * Settings (Run now)". Logged, and part of every sync job's `trigger`.
   */
  source: string,
  options: {
    /**
     * The API key queueing the job, for `/api/v1/jobs/*`. Only execution
     * differs: see its branch below.
     */
    viaApiKey?: string;
  } = {},
): Promise<RunNowResult> {
  if (job === "sync") {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { mediaServers: true },
    });
    let queued = 0;
    let failed = 0;
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
        if (ok) queued++;
        else failed++;
      }
    }
    // Advance the watermark only when every enqueue succeeded, so a failed
    // enqueue doesn't stamp "last run" and skip the next scheduled window —
    // and say so, rather than reporting a sync that was never queued.
    if (failed > 0) {
      const total = queued + failed;
      return {
        ok: false,
        error: `Failed to enqueue the sync for ${failed} of ${total} server${total === 1 ? "" : "s"}`,
      };
    }
    await prisma.appSettings.update({
      where: { userId },
      data: { lastScheduledSync: new Date() },
    });
    return { ok: true, jobs: queued };
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
    return { ok: true, jobs: 1 };
  }

  logger.info("Scheduler", `Manual lifecycle execution triggered ${source}`);

  if (options.viaApiKey) {
    // A run queued through the API is held by the API's destructive limits
    // (`executeLifecycleActions` → `viaApiKey`), so it gets a job key of its
    // own — the scheduled run's `execution:<userId>` would let the dispatcher
    // replace this payload (dropping the limits) or let this one replace the
    // dispatcher's (holding a scheduled run). And it leaves the schedule's
    // watermark alone: a run the limits hold executes nothing, and counting it
    // as the scheduled run would let a key postpone that run indefinitely.
    const ok = await enqueueJob(
      TASK_LIFECYCLE_EXECUTION,
      { userId, viaApiKey: options.viaApiKey } satisfies LifecycleExecutionPayload,
      { jobKey: `execution-api:${userId}`, queueName: MAIN_QUEUE, maxAttempts: 1 },
    );
    if (!ok) return { ok: false, error: "Failed to enqueue execution job" };
    return { ok: true, jobs: 1 };
  }

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
  return { ok: true, jobs: 1 };
}
