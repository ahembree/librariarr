import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { hasAnyActiveRules, hasArrRules } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { loadPreviewMetadata, previewMetadataPhase } from "@/lib/lifecycle/preview-metadata";
import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import { loadEditorScopeAction } from "@/lib/lifecycle/editor-action";
import { evaluateEditorRuleSet } from "@/lib/lifecycle/editor-evaluation";
import { findExceptedItemIds } from "@/lib/lifecycle/exception-guard";
import { buildContributionsFromMatches, loadMatchedItems, loadPendingActionsForOrder } from "@/lib/lifecycle/collections";
import { rulesChanged, serverIdsChanged } from "@/lib/lifecycle/rule-set-matching";
import {
  buildEditorContribution,
  editorPendingActions,
  previewCollectionOrder,
  type EditorCandidate,
} from "@/lib/lifecycle/collection-order-preview";
import { validateRequest, collectionOrderPreviewSchema } from "@/lib/validation";
import { progressStreamResponse } from "@/lib/progress/stream";
import type { ProgressPhase } from "@/lib/progress/types";

// Streaming, potentially long-running (Arr/Seerr sweeps + full-library eval +
// Plex reads), as the rule preview is.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The rule editor's Collection Order Preview: the order the collection's
 * members would be in after the next sync — the edited rule set's UNSAVED
 * rules in place of its stored matches, every other rule set feeding the
 * collection by its stored ones — against the order Plex holds now. Reads
 * only; nothing is written to Plex or the database.
 */
export const POST = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, collectionOrderPreviewSchema);
  if (error) return error;

  const { rules, type, seriesScope, serverIds, arrInstanceId, ruleSetId, collectionId } = data;
  const typedRules = rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];

  // The name Plex holds an existing collection by: a rename in the editor is
  // made on Plex by the save, so the current order is read under this one.
  let plexName: string | undefined;
  if (collectionId) {
    const collection = await prisma.collection.findFirst({
      where: { id: collectionId, userId: session.userId },
      select: { type: true, name: true },
    });
    if (!collection) return NextResponse.json({ error: "Collection not found" }, { status: 404 });
    if (collection.type !== type) {
      return NextResponse.json({ error: "The collection is for another library type" }, { status: 400 });
    }
    plexName = collection.name;
  }
  const storedRuleSet = ruleSetId
    ? await prisma.ruleSet.findFirst({
        where: { id: ruleSetId, userId: session.userId },
        select: {
          actionDelayDays: true,
          rules: true,
          serverIds: true,
          seriesScope: true,
          arrInstanceId: true,
          stickyMatches: true,
          targetQualityProfileId: true,
          addImportExclusion: true,
        },
      })
    : null;
  if (ruleSetId && !storedRuleSet) return NextResponse.json({ error: "Rule set not found" }, { status: 404 });

  // SAFETY: refuse to evaluate if no rules are active — would match everything.
  if (!hasAnyActiveRules(typedRules)) {
    return NextResponse.json({ error: "No active rules to evaluate" }, { status: 400 });
  }
  // As the rule preview refuses it: an Arr/Seerr dependency that cannot
  // answer, or per-episode criteria the scope and action cannot follow.
  const action = await loadEditorScopeAction(session.userId, data, ruleSetId);
  const evaluability = await checkLifecycleRuleEvaluability(
    session.userId, type, typedRules, serverIds, arrInstanceId, seriesScope !== false, action,
  );
  if (!evaluability.evaluable) {
    return NextResponse.json({ error: evaluability.reason }, { status: 400 });
  }

  const metadataPhase = previewMetadataPhase(typedRules, type);
  const phases: ProgressPhase[] = [
    ...(metadataPhase ? [metadataPhase] : []),
    { key: "evaluate", label: "Evaluating rules" },
    { key: "order", label: "Reading Plex collections" },
  ];

  return progressStreamResponse(async (emit) => {
    emit({ type: "plan", phases });

    const enabled = data.enabled !== false;
    let candidates: EditorCandidate[] = [];
    if (enabled) {
      let arrData;
      let seerrData;
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
      const items = (await evaluateEditorRuleSet({
        rules: typedRules, type, seriesScope, serverIds, arrData, seerrData, excludeRuleSetId: ruleSetId,
      })) as unknown as Array<Record<string, unknown>>;
      // An exception keeps an item (and every copy of it) out, as detection does.
      const excluded = await findExceptedItemIds(session.userId, items.map((i) => i.id as string));
      candidates = items
        .filter((i) => !excluded.has(i.id as string))
        .map((i) => ({
          id: i.id as string,
          libraryId: i.libraryId as string,
          ratingKey: i.ratingKey as string,
          title: (i.title as string | null) ?? null,
          parentTitle: (i.parentTitle as string | null) ?? null,
          memberIds: Array.isArray(i.memberIds) ? (i.memberIds as string[]) : undefined,
        }));
    }

    emit({ type: "phase", key: "order" });
    // `seriesScope` as the detection of a saved rule set would store it.
    const editorScope = seriesScope !== false;
    const others = collectionId ? await buildContributionsFromMatches(collectionId, ruleSetId) : [];
    // Sticky matches the save keeps: with sticky matches on and what the rule
    // set matches unchanged (rules, servers, scope, the Arr instance its Arr
    // criteria are read from), the save clears nothing and detection keeps
    // stored matches the rules no longer select.
    const keepsStored =
      !!storedRuleSet &&
      (data.stickyMatches ?? storedRuleSet.stickyMatches) &&
      !rulesChanged(storedRuleSet.rules, rules) &&
      !serverIdsChanged(storedRuleSet.serverIds, serverIds) &&
      (type === "MOVIE" || storedRuleSet.seriesScope === editorScope) &&
      !(hasArrRules(typedRules) && (arrInstanceId ?? null) !== (storedRuleSet.arrInstanceId ?? null));
    const keptItems = keepsStored && ruleSetId ? ((await loadMatchedItems([ruleSetId])).get(ruleSetId) ?? []) : [];
    const contributions = enabled
      ? [...others, await buildEditorContribution(ruleSetId, editorScope, candidates, keptItems)]
      : others;

    const pendingActions = data.sort === "ACTION_DATE"
      ? [
          ...(await loadPendingActionsForOrder(others.map((c) => c.ruleSetId))),
          ...(enabled
            ? await editorPendingActions(session.userId, ruleSetId, candidates, {
                armed: !!action.actionEnabled && !!action.actionType,
                delayDays: data.actionDelayDays ?? storedRuleSet?.actionDelayDays ?? 0,
                type,
                config: {
                  actionType: action.actionType ?? null,
                  arrInstanceId: arrInstanceId ?? storedRuleSet?.arrInstanceId ?? null,
                  targetQualityProfileId: data.targetQualityProfileId !== undefined
                    ? data.targetQualityProfileId
                    : (storedRuleSet?.targetQualityProfileId ?? null),
                  addImportExclusion: data.addImportExclusion ?? storedRuleSet?.addImportExclusion ?? false,
                  searchAfterAction: !!action.searchAfterAction,
                  addArrTags: [...(action.addArrTags ?? [])],
                  removeArrTags: [...(action.removeArrTags ?? [])],
                },
              })
            : []),
        ]
      : [];

    return previewCollectionOrder({
      userId: session.userId,
      collection: { name: data.collectionName, plexName, type, sort: data.sort, sortDirection: data.sortDirection },
      contributions,
      pendingActions,
    });
  }, { request });
});
