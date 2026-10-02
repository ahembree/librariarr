import { describe, it, expect } from "vitest";
import { pipelineStateFrom } from "@/lib/dashboard/pipeline";

describe("pipelineStateFrom", () => {
  it("fails when the rules request failed, whatever the others returned", () => {
    expect(pipelineStateFrom(null, { ruleMatches: [] }, { pendingCount: 3 })).toEqual({
      status: "failed",
    });
  });

  it("a successful load after a failed one yields a ready state", () => {
    // The zone replaces its whole state per load; this is the transition that
    // used to leave the error showing.
    const first = pipelineStateFrom(null, null, null);
    const second = pipelineStateFrom({ ruleSets: [{ enabled: true }] }, null, null);
    expect(first.status).toBe("failed");
    expect(second.status).toBe("ready");
  });

  it("summarises rules, matches and stats", () => {
    const state = pipelineStateFrom(
      { ruleSets: [{ enabled: true }, { enabled: false }, { enabled: true }] },
      { ruleMatches: [{ count: 4 }, { count: 0 }, { count: 2 }] },
      { pendingCount: 5, pendingBytes: "2048", totalBytesDeleted: "4096", actionCount: 7 },
    );
    expect(state).toEqual({
      status: "ready",
      data: {
        ruleTotal: 3,
        ruleEnabled: 2,
        matchCount: 6,
        matchRuleSets: 2,
        pendingCount: 5,
        pendingBytes: 2048,
        reclaimedBytes: 4096,
        reclaimedActions: 7,
      },
    });
  });

  it("reads missing matches and stats as zero", () => {
    const state = pipelineStateFrom({ ruleSets: [] }, null, null);
    expect(state).toEqual({
      status: "ready",
      data: {
        ruleTotal: 0,
        ruleEnabled: 0,
        matchCount: 0,
        matchRuleSets: 0,
        pendingCount: 0,
        pendingBytes: 0,
        reclaimedBytes: 0,
        reclaimedActions: 0,
      },
    });
  });

  it("treats a match group without a count as zero", () => {
    const state = pipelineStateFrom({ ruleSets: [{ enabled: true }] }, { ruleMatches: [{}] }, null);
    expect(state.status === "ready" && state.data.matchCount).toBe(0);
    expect(state.status === "ready" && state.data.matchRuleSets).toBe(0);
  });
});
