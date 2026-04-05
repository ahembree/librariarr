import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function POST() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    create: {
      userId: session.userId!,
      deletionStatsResetAt: now,
    },
    update: { deletionStatsResetAt: now },
  });

  // Fetch current pending stats so they're preserved in the response
  const pendingActions = await prisma.lifecycleAction.findMany({
    where: { userId: session.userId!, status: "PENDING" },
    select: {
      matchedMediaItemIds: true,
      mediaItem: { select: { fileSize: true } },
    },
  });

  let pendingBytes = BigInt(0);
  const memberIds = pendingActions.flatMap((a) => a.matchedMediaItemIds);

  if (memberIds.length > 0) {
    const memberSizes = await prisma.mediaItem.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, fileSize: true },
    });
    const memberSizeMap = new Map(memberSizes.map((m) => [m.id, m.fileSize ?? BigInt(0)]));

    for (const action of pendingActions) {
      if (action.matchedMediaItemIds.length > 0) {
        pendingBytes += action.matchedMediaItemIds.reduce(
          (sum, id) => sum + (memberSizeMap.get(id) ?? BigInt(0)),
          BigInt(0),
        );
      } else if (action.mediaItem?.fileSize) {
        pendingBytes += action.mediaItem.fileSize;
      }
    }
  } else {
    for (const action of pendingActions) {
      if (action.mediaItem?.fileSize) {
        pendingBytes += action.mediaItem.fileSize;
      }
    }
  }

  return NextResponse.json({
    totalBytesDeleted: "0",
    actionCount: 0,
    pendingBytes: pendingBytes.toString(),
    pendingCount: pendingActions.length,
    resetAt: now.toISOString(),
  });
}
