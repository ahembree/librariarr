import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
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
  await enqueueJob(
    TASK_SYNC_SERVER,
    { serverId: server.id, libraryKey },
    { jobKey, queueName: MAIN_QUEUE, maxAttempts: 3 },
  );

  return NextResponse.json({ message: "Sync started" });
}
