import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { runDetection, syncCollectionsAfterDetection } from "@/lib/lifecycle/detect-matches";
import { scheduleActionsForRuleSet } from "@/lib/lifecycle/processor";
import { eventBus } from "@/lib/events/event-bus";
import { validateRequest, ruleRunSchema } from "@/lib/validation";
import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import { hasAnyActiveRules } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

/**
 * Why `runDetection` produced no result for a rule set the caller named.
 *
 * `runDetection` skips a rule set silently — it logs a warning and moves on —
 * so a manual run of one that the evaluability guard refuses returned 200 with
 * an empty `ruleMatches`, and the editor navigated to Matches showing the
 * PRESERVED matches from the last successful run. Nothing on screen said the
 * run had not happened. A skip is invisible by construction, so the only way to
 * report it is to ask, after the fact, why the rule set is missing.
 *
 * Re-derived rather than plumbed out of `runDetection` so this stays a
 * reporting path with no say in policy: it calls the same shared helpers the
 * loop itself skipped on, and if it can find no reason it says nothing.
 */
async function explainSkippedRuleSet(
  userId: string,
  ruleSetId: string,
): Promise<string | null> {
  const ruleSet = await prisma.ruleSet.findFirst({
    where: { id: ruleSetId, userId },
    include: {
      user: { include: { mediaServers: { where: { enabled: true }, select: { id: true } } } },
    },
  });
  if (!ruleSet) return null;
  if (!ruleSet.enabled) return "The rule set is disabled.";

  const enabledIds = new Set(ruleSet.user.mediaServers.map((s) => s.id));
  const serverIds = ruleSet.serverIds.filter((id) => enabledIds.has(id));
  if (serverIds.length === 0) {
    return "None of the rule set's selected servers are enabled.";
  }

  const rules = ruleSet.rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];
  if (!hasAnyActiveRules(rules)) return "The rule set has no active rules.";

  const evaluability = await checkLifecycleRuleEvaluability(userId, ruleSet.type, rules, serverIds);
  return evaluability.evaluable ? null : evaluability.reason;
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, ruleRunSchema);
  if (error) return error;

  const results = await runDetection(session.userId!, data.ruleSetId, data.fullReEval ?? false);

  // Immediately schedule/cancel actions instead of waiting for next scheduler cycle
  if (data.processActions) {
    // Determine which rule set IDs to process
    const ruleSetIds = data.ruleSetId
      ? [data.ruleSetId]
      : results.map((r) => r.ruleSet.id);

    if (ruleSetIds.length > 0) {
      const ruleSets = await prisma.ruleSet.findMany({
        where: { id: { in: ruleSetIds }, userId: session.userId },
      });
      const ruleSetMap = new Map(ruleSets.map((rs) => [rs.id, rs]));

      for (const result of results) {
        const ruleSet = ruleSetMap.get(result.ruleSet.id);
        if (!ruleSet) continue;

        // Rebuild episodeIdMap from matched items
        const episodeIdMap = new Map<string, string[]>();
        for (const item of result.items) {
          const id = item.id as string;
          const memberIds = item.memberIds as string[] | undefined;
          if (memberIds && memberIds.length > 0) {
            episodeIdMap.set(id, memberIds);
          }
        }

        await scheduleActionsForRuleSet(ruleSet, result.items, episodeIdMap);
      }
    }
  }

  // Sync Plex collections last, so ACTION_DATE ordering reflects any actions
  // just scheduled above.
  await syncCollectionsAfterDetection(session.userId!, data.ruleSetId, results);

  // Same event the scheduled processor emits. Without it, a detection run the
  // user triggered by hand updated nothing outside the calling component,
  // while an identical background run refreshed the Matches page and the
  // dashboard — the opposite of what anyone expects from pressing a button.
  eventBus.emit({
    type: "lifecycle:detection-completed",
    userId: session.userId!,
    meta: { ruleSetId: data.ruleSetId ?? null, manual: true },
  });

  // A named rule set missing from the results was skipped. Report the reason so
  // the caller can say what happened instead of presenting the previous run's
  // matches as this run's answer.
  const skippedReason =
    data.ruleSetId && !results.some((r) => r.ruleSet.id === data.ruleSetId)
      ? await explainSkippedRuleSet(session.userId!, data.ruleSetId)
      : null;

  return NextResponse.json({ ruleMatches: results, skippedReason });
}
