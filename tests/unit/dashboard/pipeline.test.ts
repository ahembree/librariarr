import { describe, it, expect } from "vitest";
import { pipelineStateFrom } from "@/lib/dashboard/pipeline";

describe("pipelineStateFrom", () => {
  it("fails when the summary request failed", () => {
    expect(pipelineStateFrom(null)).toEqual({ status: "failed" });
  });

  it("a successful load after a failed one yields a ready state", () => {
    // The zone replaces its whole state per load; this is the transition that
    // used to leave the error showing.
    const first = pipelineStateFrom(null);
    const second = pipelineStateFrom({ ruleTotal: 1, ruleEnabled: 1 });
    expect(first.status).toBe("failed");
    expect(second.status).toBe("ready");
  });

  it("reads the summary, byte sizes from their decimal strings", () => {
    const state = pipelineStateFrom({
      ruleTotal: 3,
      ruleEnabled: 2,
      matchCount: 6,
      matchRuleSets: 2,
      pendingCount: 5,
      pendingBytes: "2048",
      reclaimedBytes: "4096",
      reclaimedActions: 7,
    });
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

  it("reads missing figures as zero", () => {
    expect(pipelineStateFrom({})).toEqual({
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
});
