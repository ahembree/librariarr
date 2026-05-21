/**
 * Shared cross-system enrichment for the lifecycle rule engine and the
 * query builder. Both engines batch-fetch `serverCount` (via dedupKey),
 * `matchedRuleSets` (via RuleMatch), and `hasPendingAction` (via
 * LifecycleAction) for the same set of candidate item IDs to support
 * the cross-system rule fields (`serverCount`, `matchedRuleSets`,
 * `hasPendingAction`).
 *
 * The function initializes every requested ID with default values
 * (single-server, no matches, no pending action) so callers can index
 * without null checks even when the relevant tables have no rows.
 */
import { prisma } from "@/lib/db";

export interface CrossSystemDataEntry {
  serverCount: number;
  matchedRuleSets: string[];
  hasPendingAction: boolean;
}

export type CrossSystemDataMap = Map<string, CrossSystemDataEntry>;

export async function fetchCrossSystemData(itemIds: string[]): Promise<CrossSystemDataMap> {
  const result: CrossSystemDataMap = new Map();
  if (itemIds.length === 0) return result;

  for (const id of itemIds) {
    result.set(id, { serverCount: 1, matchedRuleSets: [], hasPendingAction: false });
  }

  // Server count via dedupKey
  const itemsWithDedup = await prisma.mediaItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, dedupKey: true },
  });
  const dedupKeys = itemsWithDedup.map((i) => i.dedupKey).filter(Boolean) as string[];
  if (dedupKeys.length > 0) {
    const uniqueKeys = [...new Set(dedupKeys)];
    const serverCounts = await prisma.mediaItem.groupBy({
      by: ["dedupKey"],
      where: { dedupKey: { in: uniqueKeys } },
      _count: { id: true },
    });
    const countMap = new Map(serverCounts.map((r) => [r.dedupKey, r._count.id]));
    for (const item of itemsWithDedup) {
      if (item.dedupKey) {
        const entry = result.get(item.id);
        if (entry) entry.serverCount = countMap.get(item.dedupKey) ?? 1;
      }
    }
  }

  // Matched rule sets
  const ruleMatches = await prisma.ruleMatch.findMany({
    where: { mediaItemId: { in: itemIds } },
    select: { mediaItemId: true, ruleSet: { select: { name: true } } },
  });
  for (const match of ruleMatches) {
    const entry = result.get(match.mediaItemId);
    if (entry && match.ruleSet.name && !entry.matchedRuleSets.includes(match.ruleSet.name)) {
      entry.matchedRuleSets.push(match.ruleSet.name);
    }
  }

  // Pending actions
  const pendingActions = await prisma.lifecycleAction.findMany({
    where: { mediaItemId: { in: itemIds, not: null }, status: "PENDING" },
    select: { mediaItemId: true },
    distinct: ["mediaItemId"],
  });
  for (const action of pendingActions) {
    if (!action.mediaItemId) continue;
    const entry = result.get(action.mediaItemId);
    if (entry) entry.hasPendingAction = true;
  }

  return result;
}
