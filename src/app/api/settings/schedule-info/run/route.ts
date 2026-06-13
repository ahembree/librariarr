import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import {
  MAIN_QUEUE,
  TASK_SYNC_SERVER,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
} from "@/lib/jobs/constants";
import { logger } from "@/lib/logger";
import { validateRequest, runJobSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, runJobSchema);
  if (error) return error;
  const { job } = data;

  try {
    if (job === "sync") {
      const user = await prisma.user.findUnique({
        where: { id: session.userId! },
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
          logger.info("Scheduler", `Manual sync triggered for server "${server.name}"`);
          const ok = await enqueueJob(
            TASK_SYNC_SERVER,
            { serverId: server.id },
            { jobKey: `sync:${server.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
          );
          if (!ok) allEnqueued = false;
        }
      }
      // Advance the watermark only when every enqueue succeeded, so a failed
      // enqueue doesn't stamp "last run" and skip the next scheduled window.
      if (allEnqueued) {
        await prisma.appSettings.update({
          where: { userId: session.userId! },
          data: { lastScheduledSync: new Date() },
        });
      }
    } else if (job === "detection") {
      logger.info("Scheduler", "Manual lifecycle detection triggered");
      // Enqueue a durable job on MAIN_QUEUE with a stable jobKey so a
      // double-click or a collision with the per-minute dispatcher dedupes
      // into one run instead of executing detection concurrently.
      const ok = await enqueueJob(
        TASK_LIFECYCLE_DETECTION,
        { userId: session.userId! },
        { jobKey: `detection:${session.userId!}`, queueName: MAIN_QUEUE, maxAttempts: 2 },
      );
      if (!ok) {
        return NextResponse.json({ error: "Failed to enqueue detection job" }, { status: 500 });
      }
      await prisma.appSettings.update({
        where: { userId: session.userId! },
        data: { lastScheduledLifecycleDetection: new Date() },
      });
    } else if (job === "execution") {
      logger.info("Scheduler", "Manual lifecycle execution triggered");
      // Same dedup guard as detection. maxAttempts: 1 mirrors the dispatcher —
      // execution applies destructive Arr actions and must not be retried as a
      // whole job.
      const ok = await enqueueJob(
        TASK_LIFECYCLE_EXECUTION,
        { userId: session.userId! },
        { jobKey: `execution:${session.userId!}`, queueName: MAIN_QUEUE, maxAttempts: 1 },
      );
      if (!ok) {
        return NextResponse.json({ error: "Failed to enqueue execution job" }, { status: 500 });
      }
      await prisma.appSettings.update({
        where: { userId: session.userId! },
        data: { lastScheduledLifecycleExecution: new Date() },
      });
    }

    return NextResponse.json({ queued: true });
  } catch (error) {
    logger.error("Scheduler", `Manual ${job} failed`, { error: String(error) });
    return NextResponse.json({ error: `Job failed: ${sanitizeErrorDetail(String(error))}` }, { status: 500 });
  }
}
