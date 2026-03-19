import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { syncMediaServer } from "@/lib/sync/sync-server";
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
        for (const server of user.mediaServers) {
          const runningJob = await prisma.syncJob.findFirst({
            where: { mediaServerId: server.id, status: "RUNNING" },
          });
          if (!runningJob) {
            logger.info("Scheduler", `Manual sync triggered for server "${server.name}"`);
            await syncMediaServer(server.id);
          }
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
