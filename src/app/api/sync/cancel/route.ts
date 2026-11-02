import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, syncCancelSchema } from "@/lib/validation";
import { eventBus } from "@/lib/events/event-bus";

export const POST = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, syncCancelSchema);
  if (error) return error;

  const { serverId } = data;

  // Verify user owns this server
  const server = await prisma.mediaServer.findFirst({
    where: { id: serverId, userId: session.userId },
    select: { id: true },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  // Every active row for the server: the library pages' Sync queues behind a
  // running sync, so a server can hold a RUNNING row and a PENDING one at once,
  // and Stop must end both rather than whichever one a lookup returned first.
  const jobs = await prisma.syncJob.findMany({
    where: {
      mediaServerId: serverId,
      status: { in: ["RUNNING", "PENDING"] },
    },
    select: { id: true, status: true },
  });

  if (jobs.length === 0) {
    return NextResponse.json({ error: "No active sync to cancel" }, { status: 404 });
  }

  // Still queued: nothing is running to notice a flag, and the queue may not
  // reach these jobs for minutes, so end them now. Their jobs see the
  // CANCELLED row and exit without syncing. Conditional on PENDING because the
  // worker can flip a row to RUNNING at the same moment — then the flag below
  // applies.
  const pendingIds = jobs.filter((job) => job.status === "PENDING").map((job) => job.id);
  const stopped =
    pendingIds.length > 0
      ? await prisma.syncJob.updateMany({
          where: { id: { in: pendingIds }, status: "PENDING" },
          data: { status: "CANCELLED", completedAt: new Date(), cancelRequested: true },
        })
      : { count: 0 };

  // A running sync (and a queued row the worker claimed meanwhile) notices the
  // flag at its next checkpoint and announces its own exit.
  await prisma.syncJob.updateMany({
    where: { id: { in: jobs.map((job) => job.id) }, status: "RUNNING" },
    data: { cancelRequested: true },
  });

  // Status surfaces refetch on it and drop the rows ended here at once.
  if (stopped.count > 0) {
    eventBus.emit({ type: "sync:failed", userId: session.userId, meta: { serverId } });
  }

  return NextResponse.json({ success: true });
});
