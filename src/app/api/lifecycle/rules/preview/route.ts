import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { evaluateRules, evaluateSeriesScope, evaluateMusicScope, hasArrRules, hasSeerrRules, hasAnyActiveRules, groupSeriesResults, getMatchedCriteriaForItems, getActualValuesForAllRules } from "@/lib/rules/engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/engine";
import type { RuleGroup, Rule } from "@/lib/rules/types";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import { validateRequest, rulePreviewSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, rulePreviewSchema);
  if (error) return error;

  const { rules, type, seriesScope, serverIds } = data;
  const typedRules = rules as unknown as Rule[] | RuleGroup[];

  // SAFETY: Refuse to evaluate if no rules are active — would match everything
  if (!hasAnyActiveRules(typedRules)) {
    return NextResponse.json({ error: "No active rules to evaluate" }, { status: 400 });
  }

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
    items = await evaluateSeriesScope(
      typedRules,
      serverIds,
      arrData,
      seerrData
    );
  } else if (type === "MUSIC" && seriesScope !== false) {
    items = await evaluateMusicScope(
      typedRules,
      serverIds,
      arrData
    );
  } else {
    const rawItems = await evaluateRules(
      typedRules,
      type,
      serverIds,
      arrData,
      seerrData
    );
    items = type === "SERIES" ? groupSeriesResults(rawItems) : rawItems;
  }

  // Compute which rules matched and actual values for all rules
  const itemRecords = items as unknown as Array<Record<string, unknown>>;
  const criteriaMap = getMatchedCriteriaForItems(
    itemRecords,
    typedRules,
    type,
    arrData,
    seerrData
  );
  const actualValuesMap = getActualValuesForAllRules(
    itemRecords,
    typedRules,
    type,
    arrData,
    seerrData
  );

  const itemsWithCriteria = items
    .map((item) => {
      const ms = (item as Record<string, unknown>).library as { mediaServer?: { id: string; name: string; type: string } } | undefined;
      const itemActualValues = actualValuesMap.get(item.id);
      return {
        ...item,
        matchedCriteria: criteriaMap.get(item.id) ?? [],
        actualValues: itemActualValues ? Object.fromEntries(itemActualValues) : {},
        servers: ms?.mediaServer
          ? [{ serverId: ms.mediaServer.id, serverName: ms.mediaServer.name, serverType: ms.mediaServer.type }]
          : [],
      };
    })
    .sort((a, b) => {
      const titleA = (a.parentTitle ?? a.title ?? "").toLowerCase();
      const titleB = (b.parentTitle ?? b.title ?? "").toLowerCase();
      return titleA.localeCompare(titleB);
    });

  return NextResponse.json({ items: itemsWithCriteria, count: itemsWithCriteria.length });
}
