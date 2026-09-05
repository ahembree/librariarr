import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { runDetection, syncCollectionsAfterDetection } from "@/lib/lifecycle/detect-matches";
import { scheduleActionsForRuleSet } from "@/lib/lifecycle/processor";
import { eventBus } from "@/lib/events/event-bus";
import { validateRequest, ruleRunSchema } from "@/lib/validation";

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

  return NextResponse.json({ ruleMatches: results });
}
