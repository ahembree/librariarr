import { describe, it, expect } from "vitest";
import { getMatchedCriteriaForItems } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

function makeRule(overrides: Partial<LifecycleRule> & Pick<LifecycleRule, "field" | "operator" | "value">): LifecycleRule {
  return { id: "r1", condition: "AND", ...overrides };
}

function makeGroup(rules: LifecycleRule[]): LifecycleRuleGroup {
  return { id: "g1", condition: "AND", rules, groups: [] };
}

function evalRules(items: Array<Record<string, unknown>>, rules: LifecycleRuleGroup[]) {
  return getMatchedCriteriaForItems(items, rules, "MOVIE");
}

describe("Rule engine: labels (JSON array)", () => {
  const items = [
    { id: "1", title: "A", labels: ["Imported", "Favorite"] },
    { id: "2", title: "B", labels: ["Favorite"] },
    { id: "3", title: "C", labels: [] },
    { id: "4", title: "D", labels: null },
  ];

  it("equals matches items containing the label", () => {
    const result = evalRules(items, [makeGroup([makeRule({ field: "labels", operator: "equals", value: "Imported" })])]);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("contains matches items containing the label", () => {
    const result = evalRules(items, [makeGroup([makeRule({ field: "labels", operator: "contains", value: "Favorite" })])]);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("3")).toHaveLength(0);
  });

  it("notContains excludes items containing the label", () => {
    const result = evalRules(items, [makeGroup([makeRule({ field: "labels", operator: "notContains", value: "Imported" })])]);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });

  it("matchesWildcard matches via glob pattern", () => {
    const result = evalRules(items, [makeGroup([makeRule({ field: "labels", operator: "matchesWildcard", value: "Fav*" })])]);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("3")).toHaveLength(0);
  });

  it("is case-insensitive for in-memory evaluation", () => {
    const result = evalRules(items, [makeGroup([makeRule({ field: "labels", operator: "contains", value: "imported" })])]);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

describe("Rule engine: ratingCount (numeric)", () => {
  const items = [
    { id: "1", title: "A", ratingCount: 1500 },
    { id: "2", title: "B", ratingCount: 50 },
    { id: "3", title: "C", ratingCount: 0 },
    { id: "4", title: "D", ratingCount: null },
  ];

  it("greaterThan matches items above the threshold", () => {
    const result = evalRules(items, [makeGroup([makeRule({ field: "ratingCount", operator: "greaterThan", value: 100 })])]);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
    expect(result.get("3")).toHaveLength(0);
  });

  it("lessThan matches items below the threshold", () => {
    const result = evalRules(items, [makeGroup([makeRule({ field: "ratingCount", operator: "lessThan", value: 100 })])]);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });

  it("between matches items in the range", () => {
    const result = evalRules(items, [makeGroup([makeRule({ field: "ratingCount", operator: "between", value: "10,200" })])]);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("3")).toHaveLength(0);
  });

  it("equals matches exact ratingCount", () => {
    const result = evalRules(items, [makeGroup([makeRule({ field: "ratingCount", operator: "equals", value: 1500 })])]);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });
});
