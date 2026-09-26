import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import { eventBus } from "@/lib/events/event-bus";
import { MAIN_QUEUE, TASK_SYNC_SERVER } from "@/lib/jobs/constants";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const server = await prisma.mediaServer.findFirst({
    where: { id, userId: session.userId },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  if (!server.enabled) {
    return NextResponse.json(
      { error: "Cannot sync a disabled server" },
      { status: 400 },
    );
  }

  // Prevent duplicate syncs — if a sync is already running or pending for this server, reject
  const activeJob = await prisma.syncJob.findFirst({
    where: { mediaServerId: server.id, status: { in: ["RUNNING", "PENDING"] } },
    select: { id: true },
  });
  if (activeJob) {
    return NextResponse.json(
      { error: "A sync is already running for this server" },
      { status: 409 },
    );
  }

  // Optional: scope sync to a specific library
  let libraryKey: string | undefined;
  try {
    const body = await request.json();
    if (body?.libraryKey && typeof body.libraryKey === "string") {
      libraryKey = body.libraryKey;
    }
  } catch {
    // No body or invalid JSON — sync all enabled libraries
  }

  if (libraryKey) {
    const library = await prisma.library.findFirst({
      where: { key: libraryKey, mediaServerId: server.id },
      select: { id: true },
    });
    if (!library) {
      return NextResponse.json(
        { error: "Library not found on this server" },
        { status: 400 },
      );
    }
  }

  // Mark the user's sync schedule as just-ran so the scheduler doesn't
  // fire a redundant sync at the next 15-minute mark (e.g. right after onboarding).
  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: { lastScheduledSync: new Date() },
    create: { userId: session.userId!, lastScheduledSync: new Date() },
  });

  // Enqueue a durable background sync job (serialized on the main queue,
  // retried on transient failure). The jobKey is scoped to the library so a
  // full-server sync and distinct library-scoped syncs don't collide and
  // replace one another.
  const jobKey = libraryKey ? `sync:${server.id}:${libraryKey}` : `sync:${server.id}`;
  // Returned so the caller can tell the run this request starts from the
  // previous one: the row below and anything the worker stamps later carry a
  // `startedAt` at or after it, on this same process clock. Comparing job ids
  // against the caller's last-seen list could not do that — a list that missed
  // an event named an older job, and the newer finished one then read as this
  // request's run and ended it before it began.
  const requestedAt = new Date();

  // The row exists from the moment the sync is asked for. MAIN_QUEUE is
  // serial, so the job can wait behind a Tracearr backfill slice (up to five
  // minutes), another server's sync or a lifecycle run — and until something
  // wrote a row, every page had nothing to show: the click looked ignored for
  // as long as the queue was busy. The run claims this row via `syncJobId`.
  const syncJob = await prisma.syncJob.create({
    data: { mediaServerId: server.id, status: "PENDING", startedAt: requestedAt },
    select: { id: true },
  });

  const enqueued = await enqueueJob(
    TASK_SYNC_SERVER,
    {
      serverId: server.id,
      libraryKey,
      trigger: "manual sync request for this server",
      syncJobId: syncJob.id,
    },
    { jobKey, queueName: MAIN_QUEUE, maxAttempts: 3 },
  );
  if (!enqueued) {
    // Nothing will ever claim the row, and a PENDING row makes this route
    // answer 409 until a restart — so close it here instead.
    await prisma.syncJob.update({
      where: { id: syncJob.id },
      data: { status: "FAILED", completedAt: new Date(), error: "Could not queue the sync job" },
    });
    return NextResponse.json({ error: "Could not queue the sync job" }, { status: 500 });
  }

  eventBus.emit({ type: "sync:started", userId: session.userId!, meta: { serverId: server.id } });

  return NextResponse.json({ message: "Sync started", requestedAt: requestedAt.toISOString() });
}
