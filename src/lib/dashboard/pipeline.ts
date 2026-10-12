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

/** `GET /api/lifecycle/summary`. Byte sizes arrive as decimal strings. */
interface SummaryBody {
  ruleTotal?: number;
  ruleEnabled?: number;
  matchCount?: number;
  matchRuleSets?: number;
  pendingCount?: number;
  pendingBytes?: string | number;
  reclaimedBytes?: string | number;
  reclaimedActions?: number;
}

/**
 * Build the zone's state from `/api/lifecycle/summary` (`null` when the request
 * failed). A failed request reports the failure rather than showing the
 * create-your-first-rule prompt over an outage.
 */
export function pipelineStateFrom(summary: SummaryBody | null): PipelineState {
  if (summary == null) return { status: "failed" };
  return {
    status: "ready",
    data: {
      ruleTotal: summary.ruleTotal ?? 0,
      ruleEnabled: summary.ruleEnabled ?? 0,
      matchCount: summary.matchCount ?? 0,
      matchRuleSets: summary.matchRuleSets ?? 0,
      pendingCount: summary.pendingCount ?? 0,
      pendingBytes: Number(summary.pendingBytes ?? 0),
      reclaimedBytes: Number(summary.reclaimedBytes ?? 0),
      reclaimedActions: summary.reclaimedActions ?? 0,
    },
  };
}
