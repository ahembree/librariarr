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

  const [result, count, completedActions, pendingActions, upcomingMatches] = await Promise.all([
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
        mediaItemId: true,
        matchedMediaItemIds: true,
        mediaItem: { select: { fileSize: true } },
      },
    }),
    // Fetch upcoming RuleMatch items for delete-type rules that don't yet have actions
    prisma.ruleMatch.findMany({
      where: {
        ruleSet: {
          userId: session.userId!,
          enabled: true,
          actionEnabled: true,
          actionType: { contains: "DELETE" },
        },
      },
      select: {
        ruleSetId: true,
        mediaItemId: true,
        itemData: true,
        ruleSet: {
          select: { id: true, name: true, type: true },
        },
        mediaItem: {
          select: { fileSize: true },
        },
      },
    }),
  ]);

  // Build set of (ruleSetId:mediaItemId) that already have an action to avoid double-counting
  const actionedPairs = new Set(
    pendingActions.map((a) => `${a.ruleSetId}:${a.mediaItemId}`),
  );

  // Compute pending deletion bytes from actual PENDING actions + upcoming matches
  // Collect all member IDs that need size lookups
  const allMemberIds = [
    ...pendingActions.flatMap((a) => a.matchedMediaItemIds),
    ...upcomingMatches
      .filter((m) => !actionedPairs.has(`${m.ruleSetId}:${m.mediaItemId}`))
      .flatMap((m) => {
        const data = m.itemData as Record<string, unknown> | null;
        return (data?.memberIds as string[] | undefined) ?? [];
      }),
  ];
  let pendingBytes = BigInt(0);
  let pendingCount = 0;

  // Pre-fetch member sizes if needed
  let memberSizeMap = new Map<string, bigint>();
  if (allMemberIds.length > 0) {
    const memberSizes = await prisma.mediaItem.findMany({
      where: { id: { in: allMemberIds } },
      select: { id: true, fileSize: true },
    });
    memberSizeMap = new Map(memberSizes.map((m) => [m.id, m.fileSize ?? BigInt(0)]));
  }

  // Sum actual PENDING actions
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

  // Sum upcoming RuleMatch items that don't yet have a LifecycleAction
  for (const match of upcomingMatches) {
    if (actionedPairs.has(`${match.ruleSetId}:${match.mediaItemId}`)) continue;
    const data = match.itemData as Record<string, unknown> | null;
    const matchMemberIds = (data?.memberIds as string[] | undefined) ?? [];
    if (matchMemberIds.length > 0) {
      const total = matchMemberIds.reduce(
        (sum, id) => sum + (memberSizeMap.get(id) ?? BigInt(0)),
        BigInt(0),
      );
      pendingBytes += total;
    } else if (match.mediaItem?.fileSize) {
      pendingBytes += match.mediaItem.fileSize;
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

  // Include upcoming matches in per-rule breakdown
  for (const match of upcomingMatches) {
    if (actionedPairs.has(`${match.ruleSetId}:${match.mediaItemId}`)) continue;
    const key = getRuleKey(match.ruleSet.id, match.ruleSet.name, match.ruleSet.type);
    if (!ruleSetStats.has(key)) {
      ruleSetStats.set(key, {
        ruleSetId: match.ruleSet.id,
        ruleSetName: match.ruleSet.name,
        ruleSetType: match.ruleSet.type,
        deletedBytes: BigInt(0),
        deletedCount: 0,
        pendingBytes: BigInt(0),
        pendingCount: 0,
      });
    }
    const entry = ruleSetStats.get(key)!;
    const data = match.itemData as Record<string, unknown> | null;
    const matchMemberIds = (data?.memberIds as string[] | undefined) ?? [];
    if (matchMemberIds.length > 0) {
      entry.pendingBytes += matchMemberIds.reduce(
        (sum, id) => sum + (memberSizeMap.get(id) ?? BigInt(0)),
        BigInt(0),
      );
    } else if (match.mediaItem?.fileSize) {
      entry.pendingBytes += match.mediaItem.fileSize;
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
