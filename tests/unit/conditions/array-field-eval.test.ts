import { describe, it, expect } from "vitest";
import { matchArrayField } from "@/lib/conditions/array-field-eval";
import { evaluateAllQueryRulesInMemory } from "@/lib/query/query-engine";
import { getMatchedCriteriaForItems } from "@/lib/rules/lifecycle-engine";
import type { QueryGroup } from "@/lib/query/types";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

describe("matchArrayField (shared Phase-2 JSON-array evaluator)", () => {
  const arr = ["Action", "Sci-Fi"];

  it("equals / contains are case-INsensitive (Bug 5 regression intent)", () => {
    expect(matchArrayField(arr, "equals", "Action")).toBe(true);
    expect(matchArrayField(arr, "equals", "action")).toBe(true);
    expect(matchArrayField(arr, "equals", "ACTION")).toBe(true);
    expect(matchArrayField(arr, "contains", "sci-fi")).toBe(true);
    expect(matchArrayField(arr, "contains", "drama")).toBe(false);
  });

  it("notEquals / notContains are case-insensitive and match empty arrays", () => {
    expect(matchArrayField(arr, "notEquals", "ACTION")).toBe(false);
    expect(matchArrayField(arr, "notEquals", "drama")).toBe(true);
    expect(matchArrayField([], "notContains", "Action")).toBe(true);
    expect(matchArrayField(null, "notContains", "Action")).toBe(true);
  });

  it("contains / notContains treat pipe-separated values as multi-select membership", () => {
    expect(matchArrayField(arr, "contains", "comedy|SCI-FI")).toBe(true);
    expect(matchArrayField(arr, "contains", "Comedy|Drama")).toBe(false);
    expect(matchArrayField(arr, "notContains", "Comedy|sci-fi")).toBe(false);
  });

  it("wildcards are case-insensitive", () => {
    expect(matchArrayField(arr, "matchesWildcard", "sci*")).toBe(true);
    expect(matchArrayField(arr, "matchesWildcard", "SCI*")).toBe(true);
    expect(matchArrayField(arr, "notMatchesWildcard", "act*")).toBe(false);
  });

  it("null / undefined / non-array normalize to 'no assignments' ([])", () => {
    for (const empty of [null, undefined, "not-an-array", 42]) {
      expect(matchArrayField(empty, "contains", "Action")).toBe(false);
      expect(matchArrayField(empty, "isNull", "")).toBe(true);
      expect(matchArrayField(empty, "isNotNull", "")).toBe(false);
    }
  });

  it("empty array reads as isNull, non-empty as isNotNull", () => {
    expect(matchArrayField([], "isNull", "")).toBe(true);
    expect(matchArrayField(arr, "isNull", "")).toBe(false);
    expect(matchArrayField(arr, "isNotNull", "")).toBe(true);
  });

  it("returns null for an unknown operator (caller must bypass negate)", () => {
    expect(matchArrayField(arr, "greaterThan", "1")).toBeNull();
    expect(matchArrayField(arr, "bogus", "x")).toBeNull();
  });
});

// Regression for the cross-engine drift bug: the lifecycle engine lowercased
// both sides (case-insensitive) while the query engine matched case-sensitively,
// so the same rule matched different items in each. Both now route through
// matchArrayField and MUST agree — including on the case-insensitive cases that
// used to diverge.
describe("cross-engine parity for JSON-array fields", () => {
  const item = { id: "1", genres: ["Action", "Sci-Fi"], countries: ["France"] };

  function queryMatches(field: string, operator: string, value: string): boolean {
    const groups: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [{ id: "r", field, operator, value, condition: "AND" }],
    }];
    return evaluateAllQueryRulesInMemory(groups, item, undefined, undefined);
  }

  function lifecycleMatches(field: string, operator: string, value: string): boolean {
    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [{ id: "r", field, operator, value, condition: "AND" }],
    }];
    return (getMatchedCriteriaForItems([item], rules, "MOVIE").get("1")?.length ?? 0) > 0;
  }

  const cases: Array<[string, string, string]> = [
    ["genre", "equals", "Action"],
    ["genre", "equals", "action"],        // case-insensitive → both true (used to diverge)
    ["genre", "contains", "Sci-Fi"],
    ["genre", "contains", "SCI-FI"],      // case-insensitive → both true (used to diverge)
    ["genre", "notContains", "action"],   // case-insensitive → both false (used to diverge)
    ["genre", "matchesWildcard", "sci*"], // case-insensitive wildcard → both true
    ["country", "equals", "France"],
    ["country", "equals", "france"],      // case-insensitive → both true (used to diverge)
    ["country", "contains", "france|japan"],
  ];

  for (const [field, operator, value] of cases) {
    it(`${field} ${operator} "${value}" agrees across engines`, () => {
      expect(lifecycleMatches(field, operator, value)).toBe(queryMatches(field, operator, value));
    });
  }
});
