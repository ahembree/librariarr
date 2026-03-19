import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { evaluateRules, evaluateSeriesScope, evaluateMusicScope, hasArrRules, hasSeerrRules, hasAnyActiveRules, groupSeriesResults, getMatchedCriteriaForItems, getActualValuesForAllRules } from "@/lib/rules/engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/engine";
import type { RuleGroup, Rule } from "@/lib/rules/types";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import { validateRequest, ruleDiffSchema } from "@/lib/validation";

interface DiffItem {
  id: string;
  title: string;
  parentTitle: string | null;
}

// Serialize BigInt fields (fileSize) to strings for JSON response
function serializeItem(item: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(item, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ));
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
    select: { id: true },
  });
  if (!ruleSet) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { rules, type, seriesScope, serverIds } = data;
  const typedRules = rules as unknown as Rule[] | RuleGroup[];

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
    const enrichedRemovedItems = removedItems.map((item) => {
      const serialized = serializeItem(item as unknown as Record<string, unknown>);
      serialized.matchedCriteria = [];
      serialized.actualValues = {};
      return serialized;
    });
    return NextResponse.json({
      added: [],
      removed,
      retained: [],
      removedItems: enrichedRemovedItems,
      counts: { added: 0, removed: removed.length, retained: 0 },
    });
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
    const rawItems = await evaluateRules(typedRules, type, serverIds, arrData, seerrData);
    items = type === "SERIES" ? groupSeriesResults(rawItems) : rawItems;
  }

  // Filter out excluded items
  const candidateIds = items.map((item) => (item as Record<string, unknown>).id as string);
  const excludedItems = await prisma.lifecycleException.findMany({
    where: {
      userId: session.userId,
      mediaItemId: { in: candidateIds },
    },
    select: { mediaItemId: true },
  });
  const excludedIds = new Set(excludedItems.map((e) => e.mediaItemId));

  const newMatchIds = new Set<string>();
  const newMatchMap = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const rec = item as Record<string, unknown>;
    const itemId = rec.id as string;
    if (!excludedIds.has(itemId)) {
      newMatchIds.add(itemId);
      newMatchMap.set(itemId, rec);
    }
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
      include: { library: { include: { mediaServer: { select: { id: true, name: true, type: true } } } }, streams: true, externalIds: true },
    });
    const removedRecords = fullRemovedItems.map((item) => item as unknown as Record<string, unknown>);
    const removedCriteriaMap = getMatchedCriteriaForItems(removedRecords, typedRules, type, arrData, seerrData);
    const removedActualMap = getActualValuesForAllRules(removedRecords, typedRules, type, arrData, seerrData);
    removedItems = fullRemovedItems.map((item) => {
      const serialized = serializeItem(item as unknown as Record<string, unknown>);
      serialized.matchedCriteria = removedCriteriaMap.get(item.id) ?? [];
      const itemActualValues = removedActualMap.get(item.id);
      serialized.actualValues = itemActualValues ? Object.fromEntries(itemActualValues) : {};
      return serialized;
    });
  }

  return NextResponse.json({
    added,
    removed,
    retained,
    removedItems,
    counts: { added: added.length, removed: removed.length, retained: retained.length },
  });
}
