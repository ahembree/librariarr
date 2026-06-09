import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import { MAIN_QUEUE, TASK_SYNC_SERVER } from "@/lib/jobs/constants";
import {
  processLifecycleRules,
  executeLifecycleActions,
} from "@/lib/lifecycle/processor";
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
          await enqueueJob(
            TASK_SYNC_SERVER,
            { serverId: server.id },
            { jobKey: `sync:${server.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
          );
        }
      }
      await prisma.appSettings.update({
        where: { userId: session.userId! },
        data: { lastScheduledSync: new Date() },
      });
    } else if (job === "detection") {
      logger.info("Scheduler", "Manual lifecycle detection triggered");
      await processLifecycleRules(session.userId!);
      await prisma.appSettings.update({
        where: { userId: session.userId! },
        data: { lastScheduledLifecycleDetection: new Date() },
      });
    } else if (job === "execution") {
      logger.info("Scheduler", "Manual lifecycle execution triggered");
      await executeLifecycleActions(session.userId!);
      await prisma.appSettings.update({
        where: { userId: session.userId! },
        data: { lastScheduledLifecycleExecution: new Date() },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("Scheduler", `Manual ${job} failed`, { error: String(error) });
    return NextResponse.json({ error: `Job failed: ${sanitizeErrorDetail(String(error))}` }, { status: 500 });
  }
}
