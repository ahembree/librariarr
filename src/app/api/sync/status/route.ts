import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Scoped to the user's servers through the relation, so the two reads run
  // side by side: they waited on a lookup of the server ids first. A user with
  // no servers matches no job, as the early return for that case answered.
  const ownJobs = { mediaServer: { userId: session.userId } };

  // Get all running/pending jobs, plus the most recent completed/failed per server
  const [activeJobs, recentJobs] = await Promise.all([
    prisma.syncJob.findMany({
      where: {
        ...ownJobs,
        status: { in: ["RUNNING", "PENDING"] },
      },
      include: {
        mediaServer: { select: { name: true, type: true } },
      },
      orderBy: { startedAt: "desc" },
    }),
    prisma.syncJob.findMany({
      where: {
        ...ownJobs,
        status: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
      },
      include: {
        mediaServer: { select: { name: true, type: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 3,
    }),
  ]);

  return NextResponse.json({
    jobs: [...activeJobs, ...recentJobs],
  });
}
