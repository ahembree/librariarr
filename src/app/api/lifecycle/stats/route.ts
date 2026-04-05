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

  // Aggregate completed delete actions (after reset point if set)
  const completedWhere = {
    userId: session.userId!,
    status: "COMPLETED" as const,
    actionType: { contains: "DELETE" },
    deletedBytes: { not: null },
    ...(resetAt ? { executedAt: { gte: resetAt } } : {}),
  };

  const [result, count, completedActions, pendingActions] = await Promise.all([
    prisma.lifecycleAction.aggregate({
      where: completedWhere,
      _sum: { deletedBytes: true },
    }),
    prisma.lifecycleAction.count({ where: completedWhere }),
    // Fetch completed delete actions with rule set info for per-rule breakdown
    prisma.lifecycleAction.findMany({
      where: completedWhere,
      select: {
        ruleSetId: true,
        ruleSetName: true,
        ruleSetType: true,
        deletedBytes: true,
      },
    }),
    // Fetch pending delete actions with their media item file sizes and member IDs
    prisma.lifecycleAction.findMany({
      where: {
        userId: session.userId!,
        status: "PENDING",
        actionType: { contains: "DELETE" },
      },
      select: {
        ruleSetId: true,
        ruleSetName: true,
        ruleSetType: true,
        matchedMediaItemIds: true,
        mediaItem: { select: { fileSize: true } },
      },
    }),
  ]);

  // Compute pending deletion bytes
  const memberIds = pendingActions.flatMap((a) => a.matchedMediaItemIds);
  let pendingBytes = BigInt(0);
  let pendingCount = 0;

  // Pre-fetch member sizes if needed
  let memberSizeMap = new Map<string, bigint>();
  if (memberIds.length > 0) {
    const memberSizes = await prisma.mediaItem.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, fileSize: true },
    });
    memberSizeMap = new Map(memberSizes.map((m) => [m.id, m.fileSize ?? BigInt(0)]));
  }

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

  // Build per-rule-set breakdown
  const ruleSetStats = new Map<string, {
    ruleSetId: string | null;
    ruleSetName: string;
    ruleSetType: string | null;
    deletedBytes: bigint;
    deletedCount: number;
    pendingBytes: bigint;
    pendingCount: number;
  }>();

  // For active rules, key by ID. For deleted rules (ruleSetId=null due to
  // onDelete:SetNull), key by name+type so stats from different deleted rules
  // with different names don't merge.
  const getRuleKey = (ruleSetId: string | null, ruleSetName: string | null, ruleSetType: string | null) =>
    ruleSetId ?? `deleted:${ruleSetName ?? "Unknown"}:${ruleSetType ?? ""}`;

  for (const action of completedActions) {
    const key = getRuleKey(action.ruleSetId, action.ruleSetName, action.ruleSetType);
    if (!ruleSetStats.has(key)) {
      ruleSetStats.set(key, {
        ruleSetId: action.ruleSetId,
        ruleSetName: action.ruleSetName ?? "Unknown",
        ruleSetType: action.ruleSetType,
        deletedBytes: BigInt(0),
        deletedCount: 0,
        pendingBytes: BigInt(0),
        pendingCount: 0,
      });
    }
    const entry = ruleSetStats.get(key)!;
    entry.deletedBytes += action.deletedBytes ?? BigInt(0);
    entry.deletedCount++;
  }

  for (const action of pendingActions) {
    const key = getRuleKey(action.ruleSetId, action.ruleSetName, action.ruleSetType);
    if (!ruleSetStats.has(key)) {
      ruleSetStats.set(key, {
        ruleSetId: action.ruleSetId,
        ruleSetName: action.ruleSetName ?? "Unknown",
        ruleSetType: action.ruleSetType,
        deletedBytes: BigInt(0),
        deletedCount: 0,
        pendingBytes: BigInt(0),
        pendingCount: 0,
      });
    }
    const entry = ruleSetStats.get(key)!;
    if (action.matchedMediaItemIds.length > 0) {
      entry.pendingBytes += action.matchedMediaItemIds.reduce(
        (sum, id) => sum + (memberSizeMap.get(id) ?? BigInt(0)),
        BigInt(0),
      );
    } else if (action.mediaItem?.fileSize) {
      entry.pendingBytes += action.mediaItem.fileSize;
    }
    entry.pendingCount++;
  }

  const byRuleSet = [...ruleSetStats.values()]
    .sort((a, b) => Number(b.deletedBytes + b.pendingBytes) - Number(a.deletedBytes + a.pendingBytes))
    .map((s) => ({
      ruleSetId: s.ruleSetId,
      ruleSetName: s.ruleSetName,
      ruleSetType: s.ruleSetType,
      deleted: s.ruleSetId === null,
      deletedBytes: s.deletedBytes.toString(),
      deletedCount: s.deletedCount,
      pendingBytes: s.pendingBytes.toString(),
      pendingCount: s.pendingCount,
    }));

  return NextResponse.json({
    totalBytesDeleted: (result._sum.deletedBytes ?? BigInt(0)).toString(),
    actionCount: count,
    pendingBytes: pendingBytes.toString(),
    pendingCount,
    byRuleSet,
    resetAt: resetAt?.toISOString() ?? null,
  });
}
