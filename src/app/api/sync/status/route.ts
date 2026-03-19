import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId },
    select: { id: true },
  });
  const serverIds = servers.map((s) => s.id);

  if (serverIds.length === 0) {
    return NextResponse.json({ jobs: [] });
  }

  // Get all running/pending jobs, plus the most recent completed/failed per server
  const activeJobs = await prisma.syncJob.findMany({
    where: {
      mediaServerId: { in: serverIds },
      status: { in: ["RUNNING", "PENDING"] },
    },
    include: {
      mediaServer: { select: { name: true, type: true } },
    },
    orderBy: { startedAt: "desc" },
  });

  const recentJobs = await prisma.syncJob.findMany({
    where: {
      mediaServerId: { in: serverIds },
      status: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
    },
    include: {
      mediaServer: { select: { name: true, type: true } },
    },
    orderBy: { startedAt: "desc" },
    take: 3,
  });

  return NextResponse.json({
    jobs: [...activeJobs, ...recentJobs],
  });
}
