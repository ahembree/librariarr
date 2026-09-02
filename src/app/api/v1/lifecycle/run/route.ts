import { NextResponse } from "next/server";
import { withApiKey, v1Error } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import {
  MAIN_QUEUE,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
} from "@/lib/jobs/constants";
import { validateRequest, v1LifecycleRunSchema } from "@/lib/validation";
import { apiLogger } from "@/lib/logger";

/**
 * Trigger a lifecycle run.
 *
 * The work is enqueued on the serial main queue, never run inline: detection
 * walks the whole library and execution applies destructive Arr operations, so
 * neither may run concurrently with the scheduler's own pass. The stable
 * `jobKey` is what guarantees that — a burst of API calls, or a collision with
 * the per-minute dispatcher, collapses into a single run.
 */
export const POST = withApiKey(
  async (request, { userId, apiKey }) => {
    const { data, error } = await validateRequest(request, v1LifecycleRunSchema);
    if (error) return error;

    const { mode } = data;
    const isDetection = mode === "detection";

    const ok = await enqueueJob(
      isDetection ? TASK_LIFECYCLE_DETECTION : TASK_LIFECYCLE_EXECUTION,
      { userId },
      {
        jobKey: `${isDetection ? "detection" : "execution"}:${userId}`,
        queueName: MAIN_QUEUE,
        // Execution is not retried as a whole job: a partially applied run of
        // destructive Arr actions must not be replayed from the top.
        maxAttempts: isDetection ? 2 : 1,
      },
    );

    if (!ok) return v1Error(`Failed to enqueue lifecycle ${mode} job`, 500);

    // Advance the watermark only after a successful enqueue, so a queue failure
    // can't stamp "last run" and make the dispatcher skip the next window.
    // `updateMany` rather than `update` because a missing AppSettings row is a
    // no-op here, not a 500 on an otherwise successful trigger.
    await prisma.appSettings.updateMany({
      where: { userId },
      data: isDetection
        ? { lastScheduledLifecycleDetection: new Date() }
        : { lastScheduledLifecycleExecution: new Date() },
    });

    apiLogger.info("api-v1", `Lifecycle ${mode} triggered via API key`, {
      keyName: apiKey.name,
    });

    return NextResponse.json({ mode, enqueued: true });
  },
  { scope: "READ_WRITE" },
);
