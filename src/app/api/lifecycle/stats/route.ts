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
  const completedWhere = {
    userId: session.userId!,
    status: "COMPLETED" as const,
    deletedBytes: { not: null },
    ...(resetAt ? { executedAt: { gte: resetAt } } : {}),
  };

  const [result, count, pendingActions] = await Promise.all([
    prisma.lifecycleAction.aggregate({
      where: completedWhere,
      _sum: { deletedBytes: true },
    }),
    prisma.lifecycleAction.count({ where: completedWhere }),
    // Fetch pending actions with their media item file sizes and member IDs
    prisma.lifecycleAction.findMany({
      where: {
        userId: session.userId!,
        status: "PENDING",
      },
      select: {
        matchedMediaItemIds: true,
        mediaItem: { select: { fileSize: true } },
      },
    }),
  ]);

  // Compute pending deletion bytes
  // For actions with matchedMediaItemIds (series/music episode-level), sum member sizes
  const memberIds = pendingActions.flatMap((a) => a.matchedMediaItemIds);
  let pendingBytes = BigInt(0);
  let pendingCount = 0;

  if (memberIds.length > 0) {
    const memberSizes = await prisma.mediaItem.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, fileSize: true },
    });
    const memberSizeMap = new Map(memberSizes.map((m) => [m.id, m.fileSize ?? BigInt(0)]));

    for (const action of pendingActions) {
      if (action.matchedMediaItemIds.length > 0) {
        const total = action.matchedMediaItemIds.reduce(
          (sum, id) => sum + (memberSizeMap.get(id) ?? BigInt(0)),
          BigInt(0),
        );
        pendingBytes += total;
      } else if (action.mediaItem?.fileSize) {
        pendingBytes += action.mediaItem.fileSize;
      }
      pendingCount++;
    }
  } else {
    for (const action of pendingActions) {
      if (action.mediaItem?.fileSize) {
        pendingBytes += action.mediaItem.fileSize;
      }
      pendingCount++;
    }
  }

  return NextResponse.json({
    totalBytesDeleted: (result._sum.deletedBytes ?? BigInt(0)).toString(),
    actionCount: count,
    pendingBytes: pendingBytes.toString(),
    pendingCount,
    resetAt: resetAt?.toISOString() ?? null,
  });
}
