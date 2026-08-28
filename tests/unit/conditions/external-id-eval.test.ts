import { describe, it, expect } from "vitest";
import { matchExternalIdField } from "@/lib/conditions/external-id-eval";
import { ruleToWhere } from "@/lib/conditions/where-builder";
import { evaluateAllQueryRulesInMemory } from "@/lib/query/query-engine";
import { getMatchedCriteriaForItems } from "@/lib/rules/lifecycle-engine";
import type { QueryGroup } from "@/lib/query/types";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

const withIds = [{ source: "TMDB", externalId: "1" }, { source: "IMDB", externalId: "tt1" }];
const noIds: Array<{ source: string }> = [];

describe("matchExternalIdField (shared Phase-2 external-id evaluator)", () => {
  it("isNull / isNotNull ask about LIST emptiness, not about a source", () => {
    expect(matchExternalIdField(noIds, "isNull", "")).toBe(true);
    expect(matchExternalIdField(withIds, "isNull", "")).toBe(false);
    expect(matchExternalIdField(withIds, "isNotNull", "")).toBe(true);
    expect(matchExternalIdField(noIds, "isNotNull", "")).toBe(false);
  });

  it("isNull / isNotNull ignore a leftover source value", () => {
    // A saved rule can still carry one (import/API). It must not revert to the
    // per-source reading — equals/notEquals/contains express that question.
    expect(matchExternalIdField(withIds, "isNull", "TVDB")).toBe(false);
    expect(matchExternalIdField(withIds, "isNotNull", "TVDB")).toBe(true);
  });

  it("per-source operators still compare against the value", () => {
    expect(matchExternalIdField(withIds, "equals", "TMDB")).toBe(true);
    expect(matchExternalIdField(withIds, "equals", "TVDB")).toBe(false);
    expect(matchExternalIdField(withIds, "notEquals", "TVDB")).toBe(true);
    expect(matchExternalIdField(withIds, "contains", "TVDB|IMDB")).toBe(true);
    expect(matchExternalIdField(withIds, "notContains", "TVDB")).toBe(true);
    expect(matchExternalIdField(withIds, "matchesWildcard", "T*")).toBe(true);
    expect(matchExternalIdField(withIds, "notMatchesWildcard", "X*")).toBe(true);
  });

  it("normalizes a null / non-array value to 'no ids'", () => {
    expect(matchExternalIdField(null, "isNull", "")).toBe(true);
    expect(matchExternalIdField(undefined, "isNotNull", "")).toBe(false);
    expect(matchExternalIdField("nonsense", "isNull", "")).toBe(true);
  });

  it("returns null for an unknown operator so the caller bypasses negate", () => {
    expect(matchExternalIdField(withIds, "greaterThan", "1")).toBeNull();
  });
});

describe("hasExternalId Phase 1 / Phase 2 agree and never sweep the library", () => {
  const rule = (operator: string, value: string, negate?: boolean) =>
    ({ id: "r", condition: "AND", field: "hasExternalId", operator, value, ...(negate ? { negate } : {}) }) as never;

  it("Phase 1 emits list-emptiness clauses, not a vacuous source comparison", () => {
    // The regression: `{ none: { source: "" } }` is true for EVERY row, so
    // "Is Empty" matched the whole library — with a destructive rule set that
    // armed an action on all of it.
    expect(ruleToWhere(rule("isNull", ""))).toEqual({ externalIds: { none: {} } });
    expect(ruleToWhere(rule("isNotNull", ""))).toEqual({ externalIds: { some: {} } });
    expect(JSON.stringify(ruleToWhere(rule("isNull", "")))).not.toContain('"source"');
  });

  it("Phase 1 keeps the per-source shape for equals / notEquals", () => {
    expect(ruleToWhere(rule("equals", "TMDB"))).toEqual({ externalIds: { some: { source: "TMDB" } } });
    expect(ruleToWhere(rule("notEquals", "TMDB"))).toEqual({ externalIds: { none: { source: "TMDB" } } });
  });

  it("both engines agree with Phase 1 on an item that HAS external ids", () => {
    const item = { id: "1", externalIds: withIds };
    const lifecycle = (operator: string) =>
      (getMatchedCriteriaForItems(
        [item],
        [{ id: "g", condition: "AND", rules: [rule(operator, "")], groups: [] }] as LifecycleRuleGroup[],
        "MOVIE",
      ).get("1") ?? []).length > 0;
    const query = (operator: string) =>
      evaluateAllQueryRulesInMemory(
        [{ id: "g", condition: "AND", rules: [rule(operator, "")], groups: [] }] as QueryGroup[],
        item, undefined, undefined,
      );

    // "Is Empty" on an item that has two ids must be false in both engines.
    expect(lifecycle("isNull")).toBe(false);
    expect(query("isNull")).toBe(false);
    expect(lifecycle("isNotNull")).toBe(true);
    expect(query("isNotNull")).toBe(true);
  });
});
