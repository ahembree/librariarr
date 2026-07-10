import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { evaluateLifecycleRules, evaluateSeriesScope, evaluateMusicScope, hasArrRules, hasSeerrRules, hasAnyActiveRules, groupSeriesResults } from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { fetchArrMetadata, hasEnabledArrInstances, arrFamilyLabel } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata, hasEnabledSeerrInstances } from "@/lib/lifecycle/fetch-seerr-metadata";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const ruleSet = await prisma.ruleSet.findFirst({
    where: { id, userId: session.userId },
  });

  if (!ruleSet) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rules = ruleSet.rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];

  // SAFETY: Refuse to evaluate if no rules are active — would match everything.
  // Checked first as the more fundamental guard.
  if (!hasAnyActiveRules(rules)) {
    return NextResponse.json({ error: "No active rules to evaluate" }, { status: 400 });
  }

  const enabledServers = await prisma.mediaServer.findMany({
    where: { userId: session.userId, enabled: true },
    select: { id: true },
  });
  // Scope the preview to the rule set's own targeted servers (intersected with
  // enabled servers), exactly as detection/collections do — otherwise the
  // preview matches libraries the rule set won't actually act on.
  const enabledServerIds = enabledServers.map((s) => s.id);
  const serverIds = ruleSet.serverIds.filter((sid) => enabledServerIds.includes(sid));
  if (serverIds.length === 0) {
    return NextResponse.json({ items: [], count: 0 });
  }

  // MATCH-ALL SAFETY: mirror detection — Arr/Seerr rules with no enabled
  // instance behind them would preview the entire library as matching.
  if (hasArrRules(rules) && !(await hasEnabledArrInstances(session.userId!, ruleSet.type))) {
    return NextResponse.json(
      { error: `Rules use Arr criteria but no enabled ${arrFamilyLabel(ruleSet.type)} instance is configured` },
      { status: 400 }
    );
  }
  if (hasSeerrRules(rules)) {
    if (ruleSet.type === "MUSIC") {
      return NextResponse.json(
        { error: "Seerr criteria are not supported for music rules" },
        { status: 400 }
      );
    }
    if (!(await hasEnabledSeerrInstances(session.userId!))) {
      return NextResponse.json(
        { error: "Rules use Seerr criteria but no enabled Seerr instance is configured" },
        { status: 400 }
      );
    }
  }

  let arrData: ArrDataMap | undefined;
  if (hasArrRules(rules)) {
    arrData = await fetchArrMetadata(session.userId!, ruleSet.type);
  }

  let seerrData: SeerrDataMap | undefined;
  if (hasSeerrRules(rules) && ruleSet.type !== "MUSIC") {
    seerrData = await fetchSeerrMetadata(session.userId!, ruleSet.type);
  }

  let items;
  if (ruleSet.type === "SERIES" && ruleSet.seriesScope) {
    items = await evaluateSeriesScope(
      rules,
      serverIds,
      arrData,
      seerrData
    );
  } else if (ruleSet.type === "MUSIC" && ruleSet.seriesScope) {
    items = await evaluateMusicScope(
      rules,
      serverIds,
      arrData
    );
  } else {
    const rawItems = await evaluateLifecycleRules(
      rules,
      ruleSet.type,
      serverIds,
      arrData,
      seerrData
    );
    items = ruleSet.type === "SERIES" ? groupSeriesResults(rawItems) : rawItems;
  }

  items.sort((a, b) => {
    const titleA = (a.parentTitle ?? a.title ?? "").toLowerCase();
    const titleB = (b.parentTitle ?? b.title ?? "").toLowerCase();
    return titleA.localeCompare(titleB);
  });

  return NextResponse.json({ items, count: items.length });
}
