import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { findExceptedItemIds } from "@/lib/lifecycle/exception-guard";
import { copyRank, crossServerCopyKeys } from "@/lib/lifecycle/cross-server-copies";
import { evaluateLifecycleRules, evaluateSeriesScope, evaluateMusicScope, hasArrRules, hasSeerrRules, hasAnyActiveRules, hasWatchedByUserRules, groupSeriesResults, getMatchedCriteriaForItems, getActualValuesForAllRules } from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRuleGroup, LifecycleRule } from "@/lib/rules/types";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import { COMPLETED_PLAY_FILTER } from "@/lib/media/watch-completion";
import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import { validateRequest, ruleDiffSchema } from "@/lib/validation";
import { loadGroupMemberStats, aggregateGroupMembers, memberIdsFromItemData } from "@/lib/lifecycle/group-aggregate";

interface DiffItem {
  id: string;
  title: string;
  parentTitle: string | null;
  /**
   * Other candidate ids folded into this match — another server's copy of the
   * title. The preview lists every copy as its own row, so the editor gives
   * these the match's status too.
   */
  copyIds?: string[];
}

// Serialize BigInt fields (fileSize) to strings for JSON response
function serializeItem(item: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(item, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ));
}

/**
 * Removed rows are fetched by `MediaItem.id`, which for a SERIES or MUSIC match
 * is the representative EPISODE — its own title, its own single file size. The
 * added and retained rows beside them in the same preview table are series
 * AGGREGATES, so without this the two render differently ("The Show — Pilot"
 * against "The Show") and a removed series reports one episode's size.
 *
 * Detection already stored the group in `RuleMatch.itemData`, so take the
 * display identity from there and recompute the totals from the members'
 * current rows. A movie (no member ids) is returned untouched.
 */
async function applyGroupShape(
  rows: Record<string, unknown>[],
  itemDataById: Map<string, Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const memberStats = await loadGroupMemberStats(
    rows.flatMap((row) => memberIdsFromItemData(itemDataById.get(row.id as string))),
  );
  return rows.map((row) => {
    const itemData = itemDataById.get(row.id as string);
    const totals = aggregateGroupMembers(memberIdsFromItemData(itemData), memberStats);
    if (!totals) return row;
    return {
      ...row,
      // Identity comes from the stored aggregate so the row reads as the show
      // both in the table and in the detail panel opened from it.
      title: (itemData?.title as string | undefined) ?? row.title,
      parentTitle: (itemData?.parentTitle as string | null | undefined) ?? null,
      fileSize: totals.fileSize > BigInt(0) ? totals.fileSize.toString() : row.fileSize,
      playCount: totals.playCount,
      lastPlayedAt: totals.lastPlayedAt?.toISOString() ?? row.lastPlayedAt,
      matchedEpisodes: totals.matchedEpisodes,
    };
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { data, error } = await validateRequest(request, ruleDiffSchema);
  if (error) return error;

  // Verify ownership
  const ruleSet = await prisma.ruleSet.findFirst({
    where: { id, userId: session.userId },
    select: { id: true, actionEnabled: true, actionType: true },
  });
  if (!ruleSet) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { rules, type, seriesScope, serverIds } = data;
  const typedRules = rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];

  // Get existing matches from DB
  const existingMatches = await prisma.ruleMatch.findMany({
    where: { ruleSetId: id },
    select: { mediaItemId: true, itemData: true },
  });
  const existingById = new Map(
    existingMatches.map((m) => [m.mediaItemId, m.itemData as Record<string, unknown>])
  );

  // If no active rules, everything is removed
  if (!hasAnyActiveRules(typedRules)) {
    const removedIds = existingMatches.map((m) => m.mediaItemId);
    const removed: DiffItem[] = existingMatches.map((m) => {
      const data = m.itemData as Record<string, unknown>;
      return {
        id: m.mediaItemId,
        title: (data.title as string) ?? "Unknown",
        parentTitle: (data.parentTitle as string | null) ?? null,
      };
    });
    const removedItems = await prisma.mediaItem.findMany({
      where: { id: { in: removedIds } },
      include: { library: { include: { mediaServer: { select: { id: true, name: true, type: true } } } }, streams: true, externalIds: true },
    });
    // No active rules → no criteria to evaluate; include empty matchedCriteria/actualValues
    const enrichedRemovedItems = await applyGroupShape(
      removedItems.map((item) => {
        const serialized = serializeItem(item as unknown as Record<string, unknown>);
        serialized.matchedCriteria = [];
        serialized.actualValues = {};
        return serialized;
      }),
      existingById,
    );
    return NextResponse.json({
      added: [],
      removed,
      retained: [],
      removedItems: enrichedRemovedItems,
      counts: { added: 0, removed: removed.length, retained: 0 },
    });
  }

  // MATCH-ALL SAFETY: mirror detection — Arr/Seerr rules with no enabled
  // instance behind them would diff against a vacuous whole-library match set.
  const evaluability = await checkLifecycleRuleEvaluability(session.userId!, type, typedRules, serverIds);
  if (!evaluability.evaluable) {
    return NextResponse.json({ error: evaluability.reason }, { status: 400 });
  }

  // Evaluate the new rules to get candidate matches
  let arrData: ArrDataMap | undefined;
  if (hasArrRules(typedRules)) {
    arrData = await fetchArrMetadata(session.userId!, type);
  }

  let seerrData: SeerrDataMap | undefined;
  if (hasSeerrRules(typedRules) && type !== "MUSIC") {
    seerrData = await fetchSeerrMetadata(session.userId!, type);
  }

  let items;
  if (type === "SERIES" && seriesScope !== false) {
    items = await evaluateSeriesScope(typedRules, serverIds, arrData, seerrData);
  } else if (type === "MUSIC" && seriesScope !== false) {
    items = await evaluateMusicScope(typedRules, serverIds, arrData);
  } else {
    const rawItems = await evaluateLifecycleRules(typedRules, type, serverIds, arrData, seerrData);
    items = type === "SERIES" ? groupSeriesResults(rawItems) : rawItems;
  }

  // Filter out excluded items — an exception on another server's copy of an
  // item (same dedupKey) excludes it too, exactly as detection does.
  const candidateIds = items.map((item) => (item as Record<string, unknown>).id as string);
  const excludedIds = await findExceptedItemIds(session.userId!, candidateIds);

  // Detection stores a title matched on several servers once, listing the
  // other copies in `itemData.copies`. Such a copy matching again is that same
  // match, retained — not a new one to add.
  const copyOf = new Map<string, string>();
  for (const [matchId, data] of existingById) {
    const copies = Array.isArray(data.copies) ? (data.copies as Array<{ id?: unknown }>) : [];
    for (const c of copies) if (typeof c.id === "string") copyOf.set(c.id, matchId);
  }

  // Copies of one title that newly match together are ONE match too:
  // detection collapses them by the same external id (`crossServerCopyKeys`),
  // so each is folded onto the copy detection would keep — one already
  // matched, else the lowest id.
  const candidates = (items as unknown as Record<string, unknown>[]).filter(
    (rec) => !excludedIds.has(rec.id as string),
  );
  const copyKeys = await crossServerCopyKeys(candidates, {
    type,
    serverCount: serverIds.length,
    arrData,
    // The config being saved, not the stored one: arming an action in the
    // same edit is what makes detection collapse copies without Arr data.
    actionArmed: (data.actionEnabled ?? ruleSet.actionEnabled) &&
      !!(data.actionType !== undefined ? data.actionType : ruleSet.actionType),
  });
  // Ranked exactly as detection's collapse ranks them (`copyRank`).
  const keptForKey = new Map<string, string>();
  for (const rec of candidates) {
    const itemId = rec.id as string;
    const key = copyKeys.get(itemId);
    if (!key) continue;
    const current = keptForKey.get(key);
    if (current === undefined) {
      keptForKey.set(key, itemId);
      continue;
    }
    const byRank = copyRank(itemId, existingById, copyOf) - copyRank(current, existingById, copyOf);
    if (byRank < 0 || (byRank === 0 && itemId < current)) keptForKey.set(key, itemId);
  }

  const candidateById = new Map(candidates.map((rec) => [rec.id as string, rec]));
  const newMatchIds = new Set<string>();
  const newMatchMap = new Map<string, Record<string, unknown>>();
  const foldedIds = new Map<string, string[]>();
  for (const rec of candidates) {
    const itemId = rec.id as string;
    const key = copyKeys.get(itemId);
    const keptId = key ? (keptForKey.get(key) ?? itemId) : itemId;
    const matchId = existingById.has(keptId) ? keptId : (copyOf.get(keptId) ?? keptId);
    if (itemId !== matchId) {
      const folded = foldedIds.get(matchId);
      if (folded) folded.push(itemId);
      else foldedIds.set(matchId, [itemId]);
    }
    if (newMatchIds.has(matchId)) continue;
    newMatchIds.add(matchId);
    newMatchMap.set(matchId, candidateById.get(keptId) ?? rec);
  }

  // Compute diff
  const added: DiffItem[] = [];
  const removed: DiffItem[] = [];
  const retained: DiffItem[] = [];

  for (const [itemId, rec] of newMatchMap) {
    const diffItem: DiffItem = {
      id: itemId,
      title: (rec.title as string) ?? (rec.parentTitle as string) ?? "Unknown",
      parentTitle: (rec.parentTitle as string | null) ?? null,
      copyIds: foldedIds.get(itemId) ?? [],
    };
    if (existingById.has(itemId)) {
      retained.push(diffItem);
    } else {
      added.push(diffItem);
    }
  }

  const removedIds: string[] = [];
  for (const [itemId, data] of existingById) {
    if (!newMatchIds.has(itemId)) {
      removedIds.push(itemId);
      removed.push({
        id: itemId,
        title: (data.title as string) ?? (data.parentTitle as string) ?? "Unknown",
        parentTitle: (data.parentTitle as string | null) ?? null,
      });
    }
  }

  // Sort all lists by display title
  const sortByTitle = (a: DiffItem, b: DiffItem) => {
    const titleA = (a.parentTitle ?? a.title).toLowerCase();
    const titleB = (b.parentTitle ?? b.title).toLowerCase();
    return titleA.localeCompare(titleB);
  };
  added.sort(sortByTitle);
  removed.sort(sortByTitle);
  retained.sort(sortByTitle);

  // Fetch full item data for removed items so the frontend can display them in the preview table
  // Evaluate against the NEW rules so Logic Preview highlights which edited rules each item matches
  let removedItems: Record<string, unknown>[] = [];
  if (removedIds.length > 0) {
    const fullRemovedItems = await prisma.mediaItem.findMany({
      where: { id: { in: removedIds } },
      include: {
        library: { include: { mediaServer: { select: { id: true, name: true, type: true } } } },
        streams: true,
        externalIds: true,
        // Required for watchedByUser rules so the diff view displays
        // accurate "actual value" and matched-criteria flags.
        // Filtered to completed plays for the same reason detection's eager
        // load is: Phase 1 already excluded abandoned Tracearr plays via
        // `COMPLETED_PLAY_FILTER`, so loading them unfiltered here makes the
        // preview annotate an item as "watched by alice" when the engine that
        // will actually delete it saw no completed play at all.
        ...(hasWatchedByUserRules(typedRules)
          ? { watchHistory: { where: COMPLETED_PLAY_FILTER, select: { serverUsername: true } } }
          : {}),
      },
    });
    const removedRecords = fullRemovedItems.map((item) => item as unknown as Record<string, unknown>);
    const removedCriteriaMap = getMatchedCriteriaForItems(removedRecords, typedRules, type, arrData, seerrData);
    const removedActualMap = getActualValuesForAllRules(removedRecords, typedRules, type, arrData, seerrData);
    removedItems = await applyGroupShape(
      fullRemovedItems.map((item) => {
        const serialized = serializeItem(item as unknown as Record<string, unknown>);
        serialized.matchedCriteria = removedCriteriaMap.get(item.id) ?? [];
        const itemActualValues = removedActualMap.get(item.id);
        serialized.actualValues = itemActualValues ? Object.fromEntries(itemActualValues) : {};
        return serialized;
      }),
      existingById,
    );
  }

  return NextResponse.json({
    added,
    removed,
    retained,
    removedItems,
    counts: { added: added.length, removed: removed.length, retained: retained.length },
  });
}
