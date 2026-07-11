import { describe, it, expect, beforeEach, vi } from "vitest";

const mockHasEnabledArrInstances = vi.hoisted(() => vi.fn());
const mockHasEnabledSeerrInstances = vi.hoisted(() => vi.fn());

// Real hasArrRules/hasSeerrRules from the engine classify the rule fixtures;
// only the instance lookups (DB) are mocked.
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/lifecycle/fetch-arr-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/fetch-arr-metadata")>();
  return {
    ...actual,
    hasEnabledArrInstances: mockHasEnabledArrInstances,
  };
});
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/fetch-seerr-metadata")>();
  return {
    ...actual,
    hasEnabledSeerrInstances: mockHasEnabledSeerrInstances,
  };
});

import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

function groupsWith(field: string): LifecycleRuleGroup[] {
  return [
    {
      id: "g1",
      condition: "AND",
      rules: [{ id: "r1", field, operator: "equals", value: "false", condition: "AND" }],
      groups: [],
    },
  ];
}

describe("checkLifecycleRuleEvaluability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasEnabledArrInstances.mockResolvedValue(true);
    mockHasEnabledSeerrInstances.mockResolvedValue(true);
  });

  it("is evaluable for plain DB rules without touching instance lookups", async () => {
    const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("title"));
    expect(result).toEqual({ evaluable: true });
    expect(mockHasEnabledArrInstances).not.toHaveBeenCalled();
    expect(mockHasEnabledSeerrInstances).not.toHaveBeenCalled();
  });

  it("is evaluable for Arr rules when an enabled instance exists", async () => {
    const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("foundInArr"));
    expect(result).toEqual({ evaluable: true });
    expect(mockHasEnabledArrInstances).toHaveBeenCalledWith("u1", "MOVIE");
  });

  it("refuses Arr rules with no enabled instance (transient — no disarm)", async () => {
    mockHasEnabledArrInstances.mockResolvedValue(false);
    const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("foundInArr"));
    expect(result.evaluable).toBe(false);
    if (!result.evaluable) {
      expect(result.permanent).toBe(false);
      expect(result.reason).toMatch(/no enabled Radarr instance/i);
    }
  });

  it("names the right Arr family per library type", async () => {
    mockHasEnabledArrInstances.mockResolvedValue(false);
    const series = await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("foundInArr"));
    if (!series.evaluable) expect(series.reason).toMatch(/Sonarr/);
    const music = await checkLifecycleRuleEvaluability("u1", "MUSIC", groupsWith("foundInArr"));
    if (!music.evaluable) expect(music.reason).toMatch(/Lidarr/);
  });

  it("refuses Seerr rules on MUSIC as PERMANENT regardless of instances", async () => {
    const result = await checkLifecycleRuleEvaluability("u1", "MUSIC", groupsWith("seerrRequested"));
    expect(result.evaluable).toBe(false);
    if (!result.evaluable) {
      expect(result.permanent).toBe(true);
      expect(result.reason).toMatch(/Seerr criteria are not supported for music/i);
    }
    // Never even needs the instance lookup — the config can never evaluate
    expect(mockHasEnabledSeerrInstances).not.toHaveBeenCalled();
  });

  it("refuses Seerr rules with no enabled Seerr instance (transient)", async () => {
    mockHasEnabledSeerrInstances.mockResolvedValue(false);
    const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("seerrRequested"));
    expect(result.evaluable).toBe(false);
    if (!result.evaluable) {
      expect(result.permanent).toBe(false);
      expect(result.reason).toMatch(/no enabled Seerr instance/i);
    }
  });

  it("is evaluable for Seerr rules on MOVIE/SERIES when an enabled instance exists", async () => {
    const result = await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("seerrRequested"));
    expect(result).toEqual({ evaluable: true });
    expect(mockHasEnabledSeerrInstances).toHaveBeenCalledWith("u1");
  });
});
