/**
 * A missing Plex per-provider rating matches no comparison, negated or not —
 * in Phase 1 (the WHERE clause), the lifecycle engine's Phase 2 and the query
 * engine's Phase 2 alike. Is Empty / Is Not Empty still ask about presence.
 */
import { describe, it, expect } from "vitest";
import { ruleToWhere } from "@/lib/conditions/where-builder";
import { failsClosedOnEmpty } from "@/lib/conditions/helpers";
import { evaluateAllQueryRulesInMemory } from "@/lib/query/query-engine";
import { getMatchedCriteriaForItems } from "@/lib/rules/lifecycle-engine";
import type { QueryGroup } from "@/lib/query/types";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

const FIELDS = ["imdbRating", "tmdbRating", "rtCriticRating", "rtAudienceRating"];
const COMPARISONS: Array<[string, string]> = [
  ["equals", "7"], ["notEquals", "7"], ["greaterThan", "6"], ["greaterThanOrEqual", "6"],
  ["lessThan", "6"], ["lessThanOrEqual", "6"], ["between", "5,8"],
];

function groups(field: string, operator: string, value: string, negate: boolean) {
  return [{
    id: "g", condition: "AND" as const, groups: [],
    rules: [{ id: "r", field, operator, value, negate, condition: "AND" as const }],
  }];
}

const lifecycleMatches = (item: Record<string, unknown>, field: string, operator: string, value: string, negate: boolean) =>
  (getMatchedCriteriaForItems([{ id: "i", title: "T", ...item }], groups(field, operator, value, negate) as LifecycleRuleGroup[], "MOVIE").get("i") ?? []).length > 0;

const queryMatches = (item: Record<string, unknown>, field: string, operator: string, value: string, negate: boolean) =>
  evaluateAllQueryRulesInMemory(groups(field, operator, value, negate) as unknown as QueryGroup[], { id: "i", title: "T", ...item }, undefined, undefined);

describe("an empty Plex rating", () => {
  it("matches no comparison, positive or negated, in either engine", () => {
    for (const field of FIELDS) {
      for (const [operator, value] of COMPARISONS) {
        for (const negate of [false, true]) {
          const label = `${negate ? "NOT " : ""}${field} ${operator} ${value}`;
          expect(lifecycleMatches({ [field]: null }, field, operator, value, negate), label).toBe(false);
          expect(queryMatches({ [field]: null }, field, operator, value, negate), label).toBe(false);
        }
      }
    }
  });

  it("still negates a comparison on a real score", () => {
    for (const run of [lifecycleMatches, queryMatches]) {
      expect(run({ imdbRating: 5 }, "imdbRating", "greaterThanOrEqual", "6", true)).toBe(true);
      expect(run({ imdbRating: 7 }, "imdbRating", "greaterThanOrEqual", "6", true)).toBe(false);
      expect(run({ rtCriticRating: 9.4 }, "rtCriticRating", "notEquals", "7", false)).toBe(true);
    }
  });

  it("is still found by Is Empty, and by a negated Is Not Empty", () => {
    for (const run of [lifecycleMatches, queryMatches]) {
      expect(run({ tmdbRating: null }, "tmdbRating", "isNull", "", false)).toBe(true);
      expect(run({ tmdbRating: null }, "tmdbRating", "isNotNull", "", true)).toBe(true);
      expect(run({ tmdbRating: null }, "tmdbRating", "isNotNull", "", false)).toBe(false);
    }
  });

  it("keeps the old semantics for every other rating", () => {
    expect(lifecycleMatches({ rating: null }, "rating", "greaterThanOrEqual", "6", true)).toBe(true);
    expect(queryMatches({ audienceRating: null }, "audienceRating", "notEquals", "7", false)).toBe(true);
  });
});

describe("Phase 1", () => {
  it("ANDs 'has a score' onto every comparison of a Plex rating, after negation", () => {
    const where = ruleToWhere({ id: "r", field: "imdbRating", operator: "greaterThanOrEqual", value: "6", negate: true, condition: "AND" });
    expect(where).toEqual({
      AND: [
        { imdbRating: { not: null } },
        { OR: [{ imdbRating: null }, { NOT: { imdbRating: { gte: 6 } } }] },
      ],
    });
  });

  it("leaves Is Empty / Is Not Empty and other fields alone", () => {
    expect(ruleToWhere({ id: "r", field: "rtCriticRating", operator: "isNull", value: "", condition: "AND" })).toEqual({ rtCriticRating: null });
    expect(ruleToWhere({ id: "r", field: "rating", operator: "notEquals", value: "7", condition: "AND" }))
      .toEqual({ OR: [{ rating: null }, { rating: { not: 7 } }] });
  });

  it("classifies the operators", () => {
    expect(failsClosedOnEmpty("imdbRating", "lessThan")).toBe(true);
    expect(failsClosedOnEmpty("imdbRating", "isNull")).toBe(false);
    expect(failsClosedOnEmpty("imdbRating", "isNotNull")).toBe(false);
    expect(failsClosedOnEmpty("rating", "lessThan")).toBe(false);
  });
});
