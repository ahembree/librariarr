import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { computeDeletionStats } from "@/lib/lifecycle/deletion-stats";

/**
 * The figures the dashboard's lifecycle pipeline renders, in one request:
 * rule sets, current matches, pending deletions and space reclaimed.
 *
 * The zone used to read them from three routes, one of them the full Matches
 * listing — every match's stored snapshot, ~1 MB compressed on 11k matches —
 * fetched only to be counted. Matches are counted here the way that listing
 * reports them (enabled rule sets only); the deletion figures are the same
 * computation `/api/lifecycle/stats` returns.
 */
export const GET = withSession(async (session) => {
  const userId = session.userId;

  const [ruleSets, matchCounts, deletion] = await Promise.all([
    prisma.ruleSet.findMany({ where: { userId }, select: { enabled: true } }),
    prisma.ruleMatch.groupBy({
      by: ["ruleSetId"],
      where: { ruleSet: { userId, enabled: true } },
      _count: true,
    }),
    computeDeletionStats(userId),
  ]);

  return NextResponse.json({
    ruleTotal: ruleSets.length,
    ruleEnabled: ruleSets.filter((r) => r.enabled).length,
    matchCount: matchCounts.reduce((sum, g) => sum + g._count, 0),
    matchRuleSets: matchCounts.filter((g) => g._count > 0).length,
    pendingCount: deletion.pendingCount,
    pendingBytes: deletion.pendingBytes,
    reclaimedBytes: deletion.totalBytesDeleted,
    reclaimedActions: deletion.actionCount,
  });
});
