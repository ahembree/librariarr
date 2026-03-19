import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { evaluateRules, evaluateSeriesScope, evaluateMusicScope, hasArrRules, hasSeerrRules, hasAnyActiveRules } from "@/lib/rules/engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/engine";
import { syncPlexCollection } from "@/lib/lifecycle/collections";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import type { Rule, RuleGroup } from "@/lib/rules/types";
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

  const serverIds = ruleSet.user.mediaServers.map((s) => s.id);
  const rules = ruleSet.rules as unknown as Rule[] | RuleGroup[];

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
    matchedItems = await evaluateRules(rules, ruleSet.type, serverIds, arrData, seerrData);
  }

  await syncPlexCollection(ruleSet, matchedItems);

  return NextResponse.json({
    success: true,
    matchedCount: matchedItems.length,
    collectionName: ruleSet.collectionName,
  });
}
