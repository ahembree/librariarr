/** Figures the dashboard's lifecycle pipeline zone renders. */
export interface PipelineData {
  ruleTotal: number;
  ruleEnabled: number;
  matchCount: number;
  matchRuleSets: number;
  pendingCount: number;
  pendingBytes: number;
  reclaimedBytes: number;
  reclaimedActions: number;
}

/**
 * The zone's whole state after one load. Each load replaces it entirely, so a
 * load that succeeds after a failed one clears the failure — kept as separate
 * flags, the error was set on failure and never cleared, and the zone went on
 * saying it couldn't load over figures it had since fetched.
 */
export type PipelineState =
  | { status: "failed" }
  | { status: "ready"; data: PipelineData };

interface RulesBody { ruleSets?: { enabled: boolean }[] }
interface MatchesBody { ruleMatches?: { count?: number }[] }
interface StatsBody {
  pendingCount?: number;
  pendingBytes?: string | number;
  totalBytesDeleted?: string | number;
  actionCount?: number;
}

/**
 * Build the zone's state from the three lifecycle responses (`null` for a
 * request that failed). Rules are the source of truth for "no rules yet": if
 * that request failed, the zone reports the failure rather than showing the
 * create-your-first-rule prompt over an outage. Matches and stats are
 * secondary and read as zero when missing.
 */
export function pipelineStateFrom(
  rules: RulesBody | null,
  matches: MatchesBody | null,
  stats: StatsBody | null,
): PipelineState {
  if (rules == null) return { status: "failed" };
  const ruleSets = rules.ruleSets ?? [];
  const ruleMatches = matches?.ruleMatches ?? [];
  return {
    status: "ready",
    data: {
      ruleTotal: ruleSets.length,
      ruleEnabled: ruleSets.filter((r) => r.enabled).length,
      matchCount: ruleMatches.reduce((a, g) => a + (g.count ?? 0), 0),
      matchRuleSets: ruleMatches.filter((g) => (g.count ?? 0) > 0).length,
      pendingCount: stats?.pendingCount ?? 0,
      pendingBytes: Number(stats?.pendingBytes ?? 0),
      reclaimedBytes: Number(stats?.totalBytesDeleted ?? 0),
      reclaimedActions: stats?.actionCount ?? 0,
    },
  };
}
