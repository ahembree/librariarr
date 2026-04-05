import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { deletionStatsResetAt: true },
  });

  const resetAt = settings?.deletionStatsResetAt ?? null;

  // Aggregate completed actions (after reset point if set)
  const where = {
    userId: session.userId!,
    status: "COMPLETED" as const,
    deletedBytes: { not: null },
    ...(resetAt ? { executedAt: { gte: resetAt } } : {}),
  };

  const [result, count] = await Promise.all([
    prisma.lifecycleAction.aggregate({
      where,
      _sum: { deletedBytes: true },
    }),
    prisma.lifecycleAction.count({ where }),
  ]);

  return NextResponse.json({
    totalBytesDeleted: (result._sum.deletedBytes ?? BigInt(0)).toString(),
    actionCount: count,
    resetAt: resetAt?.toISOString() ?? null,
  });
}
