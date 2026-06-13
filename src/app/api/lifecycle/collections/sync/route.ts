import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { evaluateLifecycleRules, evaluateSeriesScope, evaluateMusicScope, hasArrRules, hasSeerrRules, hasAnyActiveRules } from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import { syncPlexCollection } from "@/lib/lifecycle/collections";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { validateRequest, collectionSyncSchema } from "@/lib/validation";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, collectionSyncSchema);
  if (error) return error;

  const { ruleSetId } = data;

  const ruleSet = await prisma.ruleSet.findUnique({
    where: { id: ruleSetId, userId: session.userId },
    include: {
      user: {
        include: { mediaServers: { where: { enabled: true }, select: { id: true } } },
      },
    },
  });

  if (!ruleSet) {
    return NextResponse.json({ error: "Rule set not found" }, { status: 404 });
  }

  if (!ruleSet.collectionEnabled || !ruleSet.collectionName) {
    return NextResponse.json(
      { error: "Collection sync is not enabled for this rule set" },
      { status: 400 }
    );
  }

  // Intersect the rule set's own server scope with the user's enabled servers
  // (mirrors processLifecycleRules) so evaluation never reaches outside the
  // libraries the rule set targets.
  const enabledServerIds = ruleSet.user.mediaServers.map((s) => s.id);
  const serverIds = ruleSet.serverIds.filter((id) => enabledServerIds.includes(id));
  if (serverIds.length === 0) {
    return NextResponse.json({ error: "Rule set has no valid servers" }, { status: 400 });
  }
  const rules = ruleSet.rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];

  // SAFETY: Refuse to evaluate if no rules are active — would match everything
  if (!hasAnyActiveRules(rules)) {
    return NextResponse.json({ error: "No active rules to evaluate" }, { status: 400 });
  }

  let arrData: ArrDataMap | undefined;
  if (hasArrRules(rules)) {
    arrData = await fetchArrMetadata(ruleSet.userId, ruleSet.type);
  }

  let seerrData: SeerrDataMap | undefined;
  if (hasSeerrRules(rules) && ruleSet.type !== "MUSIC") {
    seerrData = await fetchSeerrMetadata(ruleSet.userId, ruleSet.type);
  }

  let matchedItems;
  if (ruleSet.type === "SERIES" && ruleSet.seriesScope) {
    matchedItems = await evaluateSeriesScope(rules, serverIds, arrData, seerrData);
  } else if (ruleSet.type === "MUSIC" && ruleSet.seriesScope) {
    matchedItems = await evaluateMusicScope(rules, serverIds, arrData);
  } else {
    matchedItems = await evaluateLifecycleRules(rules, ruleSet.type, serverIds, arrData, seerrData);
  }

  // Exclude items that carry a LifecycleException for this user, mirroring
  // detect-matches.ts — a manual collection sync must not re-add an item the
  // user explicitly excluded from this rule set's lifecycle.
  const isGroupedScope =
    (ruleSet.type === "SERIES" || ruleSet.type === "MUSIC") && ruleSet.seriesScope;
  const records = matchedItems as unknown as Array<Record<string, unknown>>;

  if (isGroupedScope) {
    // Grouped items are aggregated: the series/artist name lives on `title`
    // (the engine swaps title/parentTitle), while exceptions are stored against
    // individual episode/track rows by parentTitle.
    const groupTitles = records.map((item) => item.title as string).filter(Boolean);
    if (groupTitles.length > 0) {
      const excepted = await prisma.lifecycleException.findMany({
        where: {
          userId: ruleSet.userId,
          mediaItem: {
            parentTitle: { in: groupTitles },
            type: ruleSet.type,
            library: { mediaServerId: { in: serverIds } },
          },
        },
        select: { mediaItem: { select: { parentTitle: true } } },
      });
      if (excepted.length > 0) {
        const excludedSet = new Set(excepted.map((e) => e.mediaItem.parentTitle));
        matchedItems = records.filter(
          (item) => !excludedSet.has(item.title as string),
        ) as typeof matchedItems;
      }
    }
  } else {
    // Individual-scope: check by exact mediaItemId (plus memberIds for grouped
    // SERIES so excepted episodes drop the group when none remain).
    const allIds = new Set<string>();
    for (const item of records) {
      allIds.add(item.id as string);
      const members = item.memberIds as string[] | undefined;
      if (members) for (const mid of members) allIds.add(mid);
    }
    if (allIds.size > 0) {
      const excepted = await prisma.lifecycleException.findMany({
        where: { userId: ruleSet.userId, mediaItemId: { in: [...allIds] } },
        select: { mediaItemId: true },
      });
      if (excepted.length > 0) {
        const excludedIds = new Set(excepted.map((e) => e.mediaItemId));
        matchedItems = records.filter((item) => {
          const members = item.memberIds as string[] | undefined;
          if (members) {
            return members.some((mid) => !excludedIds.has(mid));
          }
          return !excludedIds.has(item.id as string);
        }) as typeof matchedItems;
      }
    }
  }

  await syncPlexCollection(ruleSet, matchedItems);

  return NextResponse.json({
    success: true,
    matchedCount: matchedItems.length,
    collectionName: ruleSet.collectionName,
  });
}
