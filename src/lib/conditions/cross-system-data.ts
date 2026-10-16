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

type CrossSystemDataMap = Map<string, CrossSystemDataEntry>;

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
  // Detection stores a title matched on several servers ONCE, on one copy, and
  // records the others in `copyIds` — the rule set matched those copies too, so
  // "Matched By Rule Set" must say so for them as well. An array-overlap probe
  // on the column's GIN index.
  const requested = new Set(itemIds);
  const copyMatches = (
    await prisma.ruleMatch.findMany({
      where: { copyIds: { hasSome: itemIds } },
      select: { copyIds: true, ruleSet: { select: { name: true } } },
    })
  ).flatMap((m) =>
    m.copyIds.filter((id) => requested.has(id)).map((id) => ({ mediaItemId: id, name: m.ruleSet.name })),
  );
  // A show or an artist match is stored on ONE representative episode or track
  // and lists everything it acts on in `itemData.memberIds` — every one of
  // those was matched by the rule set too. Counting the representative alone,
  // a "NOT Matched By Rule Set = Keep" rule read every other episode of a show
  // "Keep" holds as unmatched, and deleted them.
  // The member lists are read whole and intersected here: the callers pass a
  // whole library's ids, and joined in SQL against `unnest($1)` the lookup was
  // estimated past `jit_above_cost`, so Postgres JIT-compiled it on every
  // detection run (~0.7 s for 28k episodes, ~4 s for 150k). This reads one
  // row per series/artist match instead.
  const memberLists = await prisma.$queryRawUnsafe<{ memberIds: unknown; name: string }[]>(
    `SELECT rm."itemData"->'memberIds' AS "memberIds", rs.name
       FROM "RuleMatch" rm
       JOIN "RuleSet" rs ON rs.id = rm."ruleSetId"
      WHERE rs.type::text IN ('SERIES', 'MUSIC')
        AND jsonb_typeof(rm."itemData"->'memberIds') = 'array'`,
  );
  const memberMatches = memberLists.flatMap((m) =>
    (Array.isArray(m.memberIds) ? m.memberIds : [])
      .filter((id): id is string => typeof id === "string" && requested.has(id))
      .map((id) => ({ mediaItemId: id, name: m.name })),
  );
  for (const match of [
    ...ruleMatches.map((m) => ({ mediaItemId: m.mediaItemId, name: m.ruleSet.name })),
    ...copyMatches,
    ...memberMatches,
  ]) {
    const entry = result.get(match.mediaItemId);
    if (entry && match.name && !entry.matchedRuleSets.includes(match.name)) {
      entry.matchedRuleSets.push(match.name);
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

/**
 * The cross-system values of a show or an artist, read across its episodes or
 * tracks: matched by every rule set that matched any of them, pending if any
 * has a pending action, on as many servers as its most-copied one. The
 * series- and artist-scope engines evaluate the aggregate record, which used
 * to carry none of these — every show read "matched by no rule set, no pending
 * action, on one server", so an exclusion such as "NOT Matched By Rule Set =
 * Keep" failed open.
 */
export function foldCrossSystemData(
  memberIds: readonly string[],
  data: CrossSystemDataMap | undefined,
): CrossSystemDataEntry | undefined {
  if (!data) return undefined;
  const names = new Set<string>();
  let serverCount = 1;
  let hasPendingAction = false;
  for (const id of memberIds) {
    const entry = data.get(id);
    if (!entry) continue;
    for (const name of entry.matchedRuleSets) names.add(name);
    serverCount = Math.max(serverCount, entry.serverCount);
    hasPendingAction ||= entry.hasPendingAction;
  }
  return { serverCount, matchedRuleSets: [...names], hasPendingAction };
}
