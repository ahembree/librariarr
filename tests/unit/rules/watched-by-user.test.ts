import { describe, it, expect } from "vitest";
import { getMatchedCriteriaForItems, hasArrRules, hasSeerrRules } from "@/lib/rules/lifecycle-engine";
import { FIELD_HANDLERS } from "@/lib/conditions/where-builder";
import { getConditionField } from "@/lib/conditions/fields";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<LifecycleRule> & Pick<LifecycleRule, "field" | "operator" | "value">): LifecycleRule {
  return { id: "r1", condition: "AND", ...overrides };
}

function makeGroup(rules: LifecycleRule[], overrides?: Partial<LifecycleRuleGroup>): LifecycleRuleGroup {
  return { id: "g1", condition: "AND", rules, groups: [], ...overrides };
}

function withHistory(id: string, usernames: string[]): Record<string, unknown> {
  return {
    id,
    title: `item-${id}`,
    watchHistory: usernames.map((u) => ({ serverUsername: u })),
  };
}

function withAggregateUsers(id: string, usernames: string[]): Record<string, unknown> {
  return {
    id,
    title: `series-${id}`,
    watchedByUsers: usernames,
  };
}

function matched(
  items: Array<Record<string, unknown>>,
  rules: LifecycleRuleGroup[],
): Map<string, unknown[]> {
  return getMatchedCriteriaForItems(items, rules, "MOVIE");
}

// ---------------------------------------------------------------------------
// Field registration
// ---------------------------------------------------------------------------

describe("watchedByUser field registration", () => {
  it("is registered in CONDITION_FIELDS as enumerable text in 'activity'", () => {
    const def = getConditionField("watchedByUser");
    expect(def).toBeDefined();
    expect(def?.type).toBe("text");
    expect(def?.section).toBe("activity");
    expect(def?.enumerable).toBe(true);
  });

  it("is not classified as an external (Arr/Seerr) field", () => {
    const rules: LifecycleRule[] = [makeRule({ field: "watchedByUser", operator: "equals", value: "alice" })];
    expect(hasArrRules(rules)).toBe(false);
    expect(hasSeerrRules(rules)).toBe(false);
  });

  it("has a Phase 1 handler registered in FIELD_HANDLERS", () => {
    expect(FIELD_HANDLERS.watchedByUser).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 1 (Prisma WHERE) — handler output shape
// ---------------------------------------------------------------------------

describe("watchedByUser Phase 1 WHERE clauses", () => {
  const handler = FIELD_HANDLERS.watchedByUser!;

  it("equals emits watchHistory.some with case-insensitive match", () => {
    const clause = handler("equals", "alice", "watchedByUser");
    expect(clause).toEqual({
      watchHistory: { some: { serverUsername: { equals: "alice", mode: "insensitive" } } },
    });
  });

  it("notEquals emits watchHistory.none with case-insensitive match", () => {
    const clause = handler("notEquals", "alice", "watchedByUser");
    expect(clause).toEqual({
      watchHistory: { none: { serverUsername: { equals: "alice", mode: "insensitive" } } },
    });
  });

  it("contains splits on pipe and emits watchHistory.some + in", () => {
    const clause = handler("contains", "alice|bob", "watchedByUser");
    expect(clause).toEqual({
      watchHistory: { some: { serverUsername: { in: ["alice", "bob"], mode: "insensitive" } } },
    });
  });

  it("notContains splits on pipe and emits watchHistory.none + in", () => {
    const clause = handler("notContains", "alice|bob", "watchedByUser");
    expect(clause).toEqual({
      watchHistory: { none: { serverUsername: { in: ["alice", "bob"], mode: "insensitive" } } },
    });
  });

  it("isNotNull emits watchHistory.some {}", () => {
    const clause = handler("isNotNull", "", "watchedByUser");
    expect(clause).toEqual({ watchHistory: { some: {} } });
  });

  it("isNull emits watchHistory.none {}", () => {
    const clause = handler("isNull", "", "watchedByUser");
    expect(clause).toEqual({ watchHistory: { none: {} } });
  });

  it("negate wraps the positive clause in NOT", () => {
    const clause = handler("equals", "alice", "watchedByUser", true);
    expect(clause).toEqual({
      NOT: { watchHistory: { some: { serverUsername: { equals: "alice", mode: "insensitive" } } } },
    });
  });

  it("wildcard operators defer to Phase 2 (returns empty clause)", () => {
    expect(handler("matchesWildcard", "ali*", "watchedByUser")).toEqual({});
    expect(handler("notMatchesWildcard", "ali*", "watchedByUser")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Phase 2 (in-memory) — evaluation on individual items via watchHistory[]
// ---------------------------------------------------------------------------

describe("watchedByUser Phase 2 evaluation (individual items)", () => {
  const items = [
    withHistory("1", ["alice"]),
    withHistory("2", ["bob"]),
    withHistory("3", ["alice", "bob"]),
    withHistory("4", []),
  ];

  it("equals matches items watched by that user (case-insensitive)", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "equals", value: "ALICE" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
    expect(result.get("3")!.length).toBeGreaterThan(0);
    expect(result.get("4")).toHaveLength(0);
  });

  it("notEquals matches items NOT watched by that user", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "notEquals", value: "alice" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("3")).toHaveLength(0);
    expect(result.get("4")!.length).toBeGreaterThan(0);
  });

  it("contains with multi-select matches any of the listed users", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "contains", value: "alice|carol" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
    expect(result.get("3")!.length).toBeGreaterThan(0);
    expect(result.get("4")).toHaveLength(0);
  });

  it("notContains with multi-select excludes items watched by any listed user", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "notContains", value: "alice|carol" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("3")).toHaveLength(0);
    expect(result.get("4")!.length).toBeGreaterThan(0);
  });

  it("isNotNull matches items with any watch history", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "isNotNull", value: "" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("4")).toHaveLength(0);
  });

  it("isNull matches items never watched", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "isNull", value: "" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("4")!.length).toBeGreaterThan(0);
  });

  it("negate inverts equals", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "equals", value: "alice", negate: true })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("4")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 (in-memory) — series/music aggregate via watchedByUsers[]
// ---------------------------------------------------------------------------

describe("watchedByUser Phase 2 evaluation (series/music aggregate)", () => {
  const items = [
    withAggregateUsers("s1", ["alice", "bob"]),
    withAggregateUsers("s2", ["carol"]),
    withAggregateUsers("s3", []),
  ];

  it("equals reads from watchedByUsers array on aggregates", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "equals", value: "alice" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
    expect(result.get("s3")).toHaveLength(0);
  });

  it("contains multi-select on aggregates", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "contains", value: "alice|carol" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")!.length).toBeGreaterThan(0);
    expect(result.get("s3")).toHaveLength(0);
  });

  it("isNull on aggregates matches series/artists with no plays", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "isNull", value: "" })])];
    const result = matched(items, rules);
    expect(result.get("s1")).toHaveLength(0);
    expect(result.get("s3")!.length).toBeGreaterThan(0);
  });

  it("aggregated watchedByUsers takes precedence over raw watchHistory if both present", () => {
    // If a caller passes both fields, the aggregate is authoritative — this
    // is the series-scope flow: aggregator strips watchHistory but writes
    // watchedByUsers. We assert the engine prefers the aggregate.
    const mixed = [{
      id: "m1",
      title: "mixed",
      watchedByUsers: ["alice"],
      watchHistory: [{ serverUsername: "bob" }],
    }];
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "equals", value: "alice" })])];
    expect(matched(mixed, rules).get("m1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Safety net — unconfigured / malformed rules must not sweep the library
// ---------------------------------------------------------------------------

describe("watchedByUser safety guards", () => {
  const items = [withHistory("1", ["alice"]), withHistory("2", [])];

  it("unconfigured contains (empty value) matches nothing even with negate=true", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "contains", value: "", negate: true })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("unconfigured notContains (empty value) matches nothing even with negate=true", () => {
    const rules: LifecycleRuleGroup[] = [makeGroup([makeRule({ field: "watchedByUser", operator: "notContains", value: "|", negate: true })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")).toHaveLength(0);
  });
});
