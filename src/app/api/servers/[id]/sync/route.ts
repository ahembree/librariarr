import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { syncMediaServer } from "@/lib/sync/sync-server";
import { logger } from "@/lib/logger";

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

  // Mark the user's sync schedule as just-ran so the scheduler doesn't
  // fire a redundant sync at the next 15-minute mark (e.g. right after onboarding).
  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: { lastScheduledSync: new Date() },
    create: { userId: session.userId!, lastScheduledSync: new Date() },
  });

  // Start sync in background
  syncMediaServer(server.id, libraryKey).catch((err) =>
    logger.error("Sync", "Sync failed", { error: String(err) })
  );

  return NextResponse.json({ message: "Sync started" });
}
