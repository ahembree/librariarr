import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, syncCancelSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, syncCancelSchema);
  if (error) return error;

  const { serverId } = data;

  // Verify user owns this server
  const server = await prisma.mediaServer.findFirst({
    where: { id: serverId, userId: session.userId! },
    select: { id: true },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  // Find running sync job for this server
  const job = await prisma.syncJob.findFirst({
    where: {
      mediaServerId: serverId,
      status: { in: ["RUNNING", "PENDING"] },
    },
    select: { id: true },
  });

  if (!job) {
    return NextResponse.json({ error: "No active sync to cancel" }, { status: 404 });
  }

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { cancelRequested: true },
  });

  return NextResponse.json({ success: true });
}
