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
 * Which rule sets a detection run skipped, and why.
 *
 * `runDetection` skips silently — it logs a warning and moves on — and its
 * results array carries an entry for every rule set it DID evaluate, including
 * one that matched nothing. A rule set missing from the results was therefore
 * always skipped, never "evaluated to zero", and the two are opposite outcomes:
 * a skip PRESERVES the rule set's existing matches (detection logs "preserving
 * N existing matches") while a zero means they are gone.
 *
 * Without this the callers could not tell them apart. The editor read an empty
 * result as success and navigated to Matches, and the Matches page rewrote the
 * skipped rule set's row to "0 matches" on screen — showing the user the exact
 * opposite of what the guard had just done to protect them.
 *
 * Re-derived rather than plumbed out of `runDetection` so this stays a pure
 * reporting path with no say in policy: it calls the same shared helpers the
 * loop skipped on, in the same order, and reports nothing when it finds no
 * reason.
 */
async function explainSkippedRuleSets(
  userId: string,
  namedRuleSetId: string | undefined,
  evaluatedIds: Set<string>,
): Promise<Array<{ ruleSetId: string; name: string; reason: string }>> {
  // A named rule set is fetched whatever its enabled state — "it is disabled"
  // is the answer the user needs when they explicitly asked to run that one.
  // A full run only ever considers ENABLED rule sets, so reporting every
  // disabled one as "skipped" there would be noise about rule sets the user
  // deliberately turned off.
  const candidates = await prisma.ruleSet.findMany({
    where: namedRuleSetId ? { id: namedRuleSetId, userId } : { userId, enabled: true },
    select: { id: true, name: true, type: true, rules: true, enabled: true, serverIds: true },
  });

  const enabledServers = await prisma.mediaServer.findMany({
    where: { userId, enabled: true },
    select: { id: true },
  });
  const enabledServerIds = new Set(enabledServers.map((s) => s.id));

  const skipped: Array<{ ruleSetId: string; name: string; reason: string }> = [];
  for (const ruleSet of candidates) {
    if (evaluatedIds.has(ruleSet.id)) continue;
    const reason = await explainSkip(userId, ruleSet, enabledServerIds);
    if (reason) skipped.push({ ruleSetId: ruleSet.id, name: ruleSet.name, reason });
  }
  return skipped;
}

/** The reasons `runDetection`'s loop skips on, in the order it checks them. */
async function explainSkip(
  userId: string,
  ruleSet: {
    id: string;
    type: "MOVIE" | "SERIES" | "MUSIC";
    rules: unknown;
    enabled: boolean;
    serverIds: string[];
  },
  enabledServerIds: Set<string>,
): Promise<string | null> {
  if (!ruleSet.enabled) return "The rule set is disabled.";

  const serverIds = ruleSet.serverIds.filter((id) => enabledServerIds.has(id));
  if (serverIds.length === 0) {
    return ruleSet.serverIds.length === 0
      ? "The rule set has no servers selected."
      : "None of the rule set's selected servers are enabled.";
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

  // Optional-chained because this runs on EVERY manual run, after detection has
  // already done its work: an entry shaped unexpectedly must leave the skip set
  // empty, never throw and turn a completed run into a 500.
  const evaluatedIds = new Set(
    results.map((r) => r.ruleSet?.id).filter((id): id is string => !!id),
  );
  const skipped = await explainSkippedRuleSets(session.userId!, data.ruleSetId, evaluatedIds);

  return NextResponse.json({ ruleMatches: results, skipped });
}
