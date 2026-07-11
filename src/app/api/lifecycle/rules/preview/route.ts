import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { evaluateLifecycleRules, evaluateSeriesScope, evaluateMusicScope, hasArrRules, hasSeerrRules, hasAnyActiveRules, groupSeriesResults, getMatchedCriteriaForItems, getActualValuesForAllRules } from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRuleGroup, LifecycleRule } from "@/lib/rules/types";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import { validateRequest, rulePreviewSchema } from "@/lib/validation";
import { progressStreamResponse } from "@/lib/progress/stream";
import type { ProgressPhase } from "@/lib/progress/types";

// Streaming, potentially long-running (Arr/Seerr sweeps + full-library eval).
// Force dynamic and cap the duration so a request can't pin a function forever.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, rulePreviewSchema);
  if (error) return error;

  const { rules, type, seriesScope, serverIds } = data;
  const typedRules = rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];

  // SAFETY: Refuse to evaluate if no rules are active — would match everything
  if (!hasAnyActiveRules(typedRules)) {
    return NextResponse.json({ error: "No active rules to evaluate" }, { status: 400 });
  }

  // MATCH-ALL SAFETY: Arr/Seerr rules with no enabled instance would evaluate
  // against an empty metadata map and preview the ENTIRE library as matching
  // ("foundInArr = false" / "seerrRequested = false" go vacuously true).
  // Detection skips such rule sets, so error here instead of previewing a
  // result detection would never produce.
  const evaluability = await checkLifecycleRuleEvaluability(session.userId!, type, typedRules);
  if (!evaluability.evaluable) {
    return NextResponse.json({ error: evaluability.reason }, { status: 400 });
  }

  const willFetchArr = hasArrRules(typedRules);
  const willFetchSeerr = hasSeerrRules(typedRules) && type !== "MUSIC";
  const phases: ProgressPhase[] = [
    ...(willFetchArr ? [{ key: "arr", label: "Fetching Arr metadata" }] : []),
    ...(willFetchSeerr ? [{ key: "seerr", label: "Fetching Seerr metadata" }] : []),
    { key: "evaluate", label: "Evaluating rules" },
    { key: "finalize", label: "Computing matched criteria" },
  ];

  return progressStreamResponse(async (emit) => {
    emit({ type: "plan", phases });
    // (request.signal passed below aborts this run on client disconnect.)

    let arrData: ArrDataMap | undefined;
    if (willFetchArr) {
      emit({ type: "phase", key: "arr", fraction: 0 });
      arrData = await fetchArrMetadata(session.userId!, type, (f) =>
        emit({ type: "phase", key: "arr", fraction: f }),
      );
    }

    let seerrData: SeerrDataMap | undefined;
    if (willFetchSeerr) {
      emit({ type: "phase", key: "seerr", fraction: 0 });
      // willFetchSeerr already guarantees type !== "MUSIC".
      seerrData = await fetchSeerrMetadata(session.userId!, type as "MOVIE" | "SERIES", (f) =>
        emit({ type: "phase", key: "seerr", fraction: f }),
      );
    }

    emit({ type: "phase", key: "evaluate" });
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
      const rawItems = await evaluateLifecycleRules(
        typedRules,
        type,
        serverIds,
        arrData,
        seerrData
      );
      items = type === "SERIES" ? groupSeriesResults(rawItems) : rawItems;
    }

    emit({ type: "phase", key: "finalize" });
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

    return { items: itemsWithCriteria, count: itemsWithCriteria.length };
  }, { signal: request.signal });
}
