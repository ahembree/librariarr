import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { evaluateRules, evaluateSeriesScope, evaluateMusicScope, hasArrRules, hasSeerrRules, hasAnyActiveRules, groupSeriesResults } from "@/lib/rules/engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/engine";
import type { Rule, RuleGroup } from "@/lib/rules/types";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";

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

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId, enabled: true },
    select: { id: true },
  });

  const rules = ruleSet.rules as unknown as Rule[] | RuleGroup[];

  // SAFETY: Refuse to evaluate if no rules are active — would match everything
  if (!hasAnyActiveRules(rules)) {
    return NextResponse.json({ error: "No active rules to evaluate" }, { status: 400 });
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
      servers.map((s) => s.id),
      arrData,
      seerrData
    );
  } else if (ruleSet.type === "MUSIC" && ruleSet.seriesScope) {
    items = await evaluateMusicScope(
      rules,
      servers.map((s) => s.id),
      arrData
    );
  } else {
    const rawItems = await evaluateRules(
      rules,
      ruleSet.type,
      servers.map((s) => s.id),
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
