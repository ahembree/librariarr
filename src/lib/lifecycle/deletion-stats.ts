import { prisma } from "@/lib/db";

/** One row of the per-rule-set deletion breakdown. */
interface RuleSetDeletionStats {
  ruleSetId: string | null;
  ruleSetName: string;
  ruleSetType: string | null;
  /** The rule set has been deleted; its actions keep their snapshot name. */
  deleted: boolean;
  deletedBytes: string;
  deletedCount: number;
  pendingBytes: string;
  pendingCount: number;
}

interface DeletionStats {
  totalBytesDeleted: string;
  actionCount: number;
  pendingBytes: string;
  pendingCount: number;
  byRuleSet: RuleSetDeletionStats[];
  resetAt: string | null;
}

/**
 * Space reclaimed by completed lifecycle deletions (since the stats reset) and
 * the space the scheduled ones will free, in total and per rule set.
 *
 * "Pending" is every PENDING delete action plus every match of an enabled,
 * action-enabled delete rule set that has no PENDING delete action yet — the
 * matches the next scheduling run will turn into actions. Completed or failed
 * NON-delete actions do not exclude a match: a destructive action is always
 * re-schedulable (see `scheduleActionsForRuleSet`), so that item will still be
 * deleted and must be counted. Each one stands for the sum of its member items
 * when it lists any (a series or artist), else its own item's file size.
 *
 * Every match of every delete rule set used to be loaded with its whole stored
 * snapshot, only to read its member ids and drop the ones already scheduled:
 * 0.45 s on 10.8k pending actions. Matches that already have an action are now
 * dropped in SQL and only the member ids of the rest are read, sizes come from
 * one lookup, and completed actions are summed in the database.
 *
 * Shared by `GET /api/lifecycle/stats` (the Pending page) and
 * `GET /api/lifecycle/summary` (the dashboard) so their figures cannot drift.
 */
export async function computeDeletionStats(userId: string): Promise<DeletionStats> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { deletionStatsResetAt: true },
  });
  const resetAt = settings?.deletionStatsResetAt ?? null;

  const [completedGroups, pendingActions, upcomingMatches] = await Promise.all([
    prisma.lifecycleAction.groupBy({
      by: ["ruleSetId", "ruleSetName", "ruleSetType"],
      where: {
        userId,
        status: "COMPLETED",
        actionType: { contains: "DELETE" },
        deletedBytes: { not: null },
        ...(resetAt ? { executedAt: { gte: resetAt } } : {}),
      },
      _sum: { deletedBytes: true },
      _count: true,
      // A rule set renamed since some of its actions ran has a group per name;
      // the most recently executed one names the row.
      orderBy: { _max: { executedAt: "desc" } },
    }),
    prisma.lifecycleAction.findMany({
      where: { userId, status: "PENDING", actionType: { contains: "DELETE" } },
      select: {
        ruleSetId: true,
        ruleSetName: true,
        ruleSetType: true,
        mediaItemId: true,
        matchedMediaItemIds: true,
      },
    }),
    // Matches the PENDING delete actions above don't already stand for.
    prisma.$queryRawUnsafe<{
      ruleSetId: string;
      ruleSetName: string;
      ruleSetType: string;
      mediaItemId: string;
      memberIds: string[] | null;
    }[]>(
      `SELECT rs.id AS "ruleSetId", rs.name AS "ruleSetName", rs.type::text AS "ruleSetType", rm."mediaItemId",
              CASE WHEN jsonb_typeof(rm."itemData"->'memberIds') = 'array'
                THEN rm."itemData"->'memberIds' END AS "memberIds"
         FROM "RuleMatch" rm
         JOIN "RuleSet" rs ON rs.id = rm."ruleSetId"
        WHERE rs."userId" = $1 AND rs.enabled AND rs."actionEnabled" AND rs."actionType" LIKE '%DELETE%'
          AND NOT EXISTS (
            SELECT 1 FROM "LifecycleAction" a
             WHERE a."userId" = $1 AND a.status = 'PENDING' AND a."actionType" LIKE '%DELETE%'
               AND a."ruleSetId" = rm."ruleSetId" AND a."mediaItemId" = rm."mediaItemId"
          )`,
      userId,
    ),
  ]);

  // What each pending row stands for: its members, or else its own item.
  const pending = [
    ...pendingActions.map((a) => ({
      ruleSetId: a.ruleSetId,
      ruleSetName: a.ruleSetName,
      ruleSetType: a.ruleSetType,
      itemIds: a.matchedMediaItemIds.length > 0 ? a.matchedMediaItemIds : a.mediaItemId ? [a.mediaItemId] : [],
    })),
    ...upcomingMatches.map((m) => ({
      ruleSetId: m.ruleSetId,
      ruleSetName: m.ruleSetName,
      ruleSetType: m.ruleSetType,
      itemIds: m.memberIds && m.memberIds.length > 0 ? m.memberIds : [m.mediaItemId],
    })),
  ];
  const sizeIds = [...new Set(pending.flatMap((p) => p.itemIds))];
  const sizes = new Map<string, bigint>();
  if (sizeIds.length > 0) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; fileSize: bigint | null }[]>(
      `SELECT id, "fileSize" FROM "MediaItem" WHERE id = ANY($1::text[])`,
      sizeIds,
    );
    for (const row of rows) sizes.set(row.id, row.fileSize ?? BigInt(0));
  }
  // A missing item counts as 0, and a member listed twice is counted twice.
  const bytesOf = (itemIds: string[]) =>
    itemIds.reduce((sum, id) => sum + (sizes.get(id) ?? BigInt(0)), BigInt(0));

  // For active rules, key by ID. For deleted rules (ruleSetId=null due to
  // onDelete:SetNull), key by name+type so stats from different deleted rules
  // with different names don't merge.
  const getRuleKey = (ruleSetId: string | null, ruleSetName: string | null, ruleSetType: string | null) =>
    ruleSetId ?? `deleted:${ruleSetName ?? "Unknown"}:${ruleSetType ?? ""}`;

  const ruleSetStats = new Map<string, {
    ruleSetId: string | null;
    ruleSetName: string;
    ruleSetType: string | null;
    deletedBytes: bigint;
    deletedCount: number;
    pendingBytes: bigint;
    pendingCount: number;
  }>();
  const entryFor = (ruleSetId: string | null, ruleSetName: string | null, ruleSetType: string | null) => {
    const key = getRuleKey(ruleSetId, ruleSetName, ruleSetType);
    let entry = ruleSetStats.get(key);
    if (!entry) {
      entry = {
        ruleSetId,
        ruleSetName: ruleSetName ?? "Unknown",
        ruleSetType,
        deletedBytes: BigInt(0),
        deletedCount: 0,
        pendingBytes: BigInt(0),
        pendingCount: 0,
      };
      ruleSetStats.set(key, entry);
    }
    return entry;
  };

  let totalBytesDeleted = BigInt(0);
  let actionCount = 0;
  for (const group of completedGroups) {
    const bytes = group._sum.deletedBytes ?? BigInt(0);
    const entry = entryFor(group.ruleSetId, group.ruleSetName, group.ruleSetType);
    entry.deletedBytes += bytes;
    entry.deletedCount += group._count;
    totalBytesDeleted += bytes;
    actionCount += group._count;
  }

  let pendingBytes = BigInt(0);
  for (const row of pending) {
    const bytes = bytesOf(row.itemIds);
    const entry = entryFor(row.ruleSetId, row.ruleSetName, row.ruleSetType);
    entry.pendingBytes += bytes;
    entry.pendingCount++;
    pendingBytes += bytes;
  }
  const pendingCount = pending.length;

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

  return {
    totalBytesDeleted: totalBytesDeleted.toString(),
    actionCount,
    pendingBytes: pendingBytes.toString(),
    pendingCount,
    byRuleSet,
    resetAt: resetAt?.toISOString() ?? null,
  };
}
