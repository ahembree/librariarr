import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { runDetection } from "@/lib/lifecycle/detect-matches";
import { scheduleActionsForRuleSet } from "@/lib/lifecycle/processor";
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
  if (data.processActions && data.ruleSetId) {
    const ruleSet = await prisma.ruleSet.findFirst({
      where: { id: data.ruleSetId, userId: session.userId },
    });
    if (ruleSet) {
      const result = results.find((r) => r.ruleSet.id === data.ruleSetId);
      if (result) {
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

  return NextResponse.json({ ruleMatches: results });
}
