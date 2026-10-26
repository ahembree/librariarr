import { describe, it, expect } from "vitest";
import {
  anyEnabled,
  hasActiveRules,
  hasWildcardRules,
  hasStreamRules,
  hasExternalIdFieldRules,
  hasCustomFormatScoreRules,
} from "@/lib/conditions/helpers";
import { hasStreamQueryInMemoryRules } from "@/lib/conditions/stream-query-where";
import type { Condition, ConditionGroup } from "@/lib/conditions/types";

const r = (field: string, extra: Partial<Condition> = {}): Condition => ({
  id: field,
  field,
  operator: "equals",
  value: "1",
  condition: "AND",
  ...extra,
});
const g = (rules: Condition[], extra: Partial<ConditionGroup> = {}): ConditionGroup => ({
  id: "g",
  condition: "AND",
  rules,
  groups: [],
  ...extra,
});

describe("anyEnabled", () => {
  it("skips disabled rules and disabled groups, sub-groups included", () => {
    const tree = [
      g([r("title", { enabled: false })]),
      g([], { enabled: false, groups: [g([r("title")])] }),
    ];
    expect(anyEnabled(tree, (rule) => rule.field === "title")).toBe(false);
    expect(anyEnabled([g([], { groups: [g([r("title")])] })], (rule) => rule.field === "title")).toBe(true);
  });

  it("asks the group predicate of enabled groups only", () => {
    const visited: string[] = [];
    anyEnabled(
      [g([], { id: "on", groups: [g([], { id: "off", enabled: false })] })],
      () => false,
      (group) => (visited.push(group.id), false),
    );
    expect(visited).toEqual(["on"]);
  });
});

describe("rule-set gates", () => {
  it("hasActiveRules needs one enabled rule", () => {
    expect(hasActiveRules([])).toBe(false);
    expect(hasActiveRules([g([])])).toBe(false);
    expect(hasActiveRules([g([r("title", { enabled: false })])])).toBe(false);
    expect(hasActiveRules([g([], { groups: [g([r("title")])] })])).toBe(true);
  });

  it("hasWildcardRules ignores external fields, which evaluate their own wildcards", () => {
    expect(hasWildcardRules([g([r("title", { operator: "matchesWildcard" })])])).toBe(true);
    expect(hasWildcardRules([g([r("title", { operator: "notMatchesWildcard" })])])).toBe(true);
    expect(hasWildcardRules([g([r("arrTag", { operator: "matchesWildcard" })])])).toBe(false);
    expect(hasWildcardRules([g([r("title", { operator: "contains" })])])).toBe(false);
  });

  it("hasStreamRules sees a stream field or any enabled stream query group", () => {
    expect(hasStreamRules([g([r("audioLanguage")])])).toBe(true);
    expect(hasStreamRules([g([], { streamQuery: { streamType: "audio" } })])).toBe(true);
    expect(hasStreamRules([g([], { streamQuery: { streamType: "audio" }, enabled: false })])).toBe(false);
    expect(hasStreamRules([g([r("title")])])).toBe(false);
  });

  it("hasStreamQueryInMemoryRules: the all quantifier, computed fields and wildcards", () => {
    const sq = (rules: Condition[], quantifier?: "any" | "none" | "all") =>
      g(rules, { streamQuery: { streamType: "audio", quantifier } });
    expect(hasStreamQueryInMemoryRules([sq([r("sqCodec")], "all")])).toBe(true);
    expect(hasStreamQueryInMemoryRules([sq([r("sqAudioProfile")])])).toBe(true);
    expect(hasStreamQueryInMemoryRules([sq([r("sqCodec", { operator: "matchesWildcard" })])])).toBe(true);
    expect(hasStreamQueryInMemoryRules([sq([r("sqCodec")])])).toBe(false);
    expect(hasStreamQueryInMemoryRules([g([], { groups: [sq([r("sqCodec")], "all")] })])).toBe(true);
    expect(hasStreamQueryInMemoryRules([g([], { enabled: false, groups: [sq([r("sqCodec")], "all")] })])).toBe(false);
  });

  it("hasExternalIdFieldRules and hasCustomFormatScoreRules match their field", () => {
    expect(hasExternalIdFieldRules([g([r("hasExternalId")])])).toBe(true);
    expect(hasExternalIdFieldRules([g([r("title")])])).toBe(false);
    expect(hasCustomFormatScoreRules([g([r("arrCustomFormatScore")])])).toBe(true);
    expect(hasCustomFormatScoreRules([g([r("arrCustomFormatScore", { enabled: false })])])).toBe(false);
  });
});
