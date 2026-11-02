import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { evaluateLifecycleRules, evaluateSeriesScope, evaluateMusicScope, hasAnyActiveRules, hasSeriesAggregateRules, groupSeriesResults, getMatchedCriteriaForItems, getActualValuesForAllRules } from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRuleGroup, LifecycleRule } from "@/lib/rules/types";
import { loadPreviewMetadata, previewMetadataPhase } from "@/lib/lifecycle/preview-metadata";
import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import { validateRequest, rulePreviewSchema } from "@/lib/validation";
import { progressStreamResponse } from "@/lib/progress/stream";
import type { ProgressPhase } from "@/lib/progress/types";

// Streaming, potentially long-running (Arr/Seerr sweeps + full-library eval).
// Force dynamic and cap the duration so a request can't pin a function forever.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, rulePreviewSchema);
  if (error) return error;

  const { rules, type, seriesScope, serverIds, arrInstanceId, ruleSetId } = data;
  // "Has Pending Action" reads other rule sets' actions, as detection reads it.
  const crossSystemOptions = { excludeRuleSetId: ruleSetId };
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
  const evaluability = await checkLifecycleRuleEvaluability(session.userId, type, typedRules, serverIds, arrInstanceId);
  if (!evaluability.evaluable) {
    return NextResponse.json({ error: evaluability.reason }, { status: 400 });
  }

  const metadataPhase = previewMetadataPhase(typedRules, type);
  const phases: ProgressPhase[] = [
    ...(metadataPhase ? [metadataPhase] : []),
    { key: "evaluate", label: "Evaluating rules" },
    { key: "finalize", label: "Computing matched criteria" },
  ];

  return progressStreamResponse(async (emit) => {
    emit({ type: "plan", phases });
    // (request.signal passed below aborts this run on client disconnect.)

    let arrData: ArrDataMap | undefined;
    let seerrData: SeerrDataMap | undefined;
    if (metadataPhase) {
      emit({ type: "phase", key: metadataPhase.key, fraction: 0 });
      ({ arrData, seerrData } = await loadPreviewMetadata(
        session.userId,
        type,
        typedRules,
        arrInstanceId,
        (f) => emit({ type: "phase", key: metadataPhase.key, fraction: f }),
      ));
    }

    emit({ type: "phase", key: "evaluate" });
    let items;
    // A series-aggregate field forces the series path even with series scope
    // off, members restricted to the matching episodes — exactly as detection
    // routes it (detect-matches.ts). Evaluated per episode the aggregate reads
    // absent, and the preview showed a different set from the one stored.
    const aggregateForced = type === "SERIES" && seriesScope === false && hasSeriesAggregateRules(typedRules);
    if (type === "SERIES" && (seriesScope !== false || aggregateForced)) {
      items = await evaluateSeriesScope(
        typedRules,
        serverIds,
        arrData,
        seerrData,
        aggregateForced,
        crossSystemOptions,
      );
    } else if (type === "MUSIC" && seriesScope !== false) {
      items = await evaluateMusicScope(
        typedRules,
        serverIds,
        arrData,
        crossSystemOptions,
      );
    } else {
      const rawItems = await evaluateLifecycleRules(
        typedRules,
        type,
        serverIds,
        arrData,
        seerrData,
        crossSystemOptions,
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
  }, { request });
});
