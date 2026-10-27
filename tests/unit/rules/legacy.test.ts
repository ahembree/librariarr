import { describe, it, expect } from "vitest";
import { legacyRulesToGroups, legacyRulesToEditorGroups } from "@/lib/rules/legacy";
import type { Condition, ConditionGroup } from "@/lib/conditions/types";

const rule = (id: string, condition: "AND" | "OR", enabled = true): Condition => ({
  id,
  field: "playCount",
  operator: "equals",
  value: "0",
  condition,
  ...(enabled ? {} : { enabled: false }),
});

/** The engine's conversion as it stood before it moved to legacy.ts. */
function previousEngineConversion(rules: Condition[]): ConditionGroup[] {
  const flat = rules.filter((r) => r.enabled !== false);
  if (flat.length === 0) return [];
  const buckets: Condition[][] = [[]];
  for (let i = 0; i < flat.length; i++) {
    buckets[buckets.length - 1].push(flat[i]);
    if (i < flat.length - 1 && flat[i].condition === "AND") buckets.push([]);
  }
  return buckets.map((bucket, bi) => ({
    id: `legacy-bucket-${bi}`,
    condition: "AND" as const,
    rules: bucket.map((r, ri) => ({ ...r, condition: ri === 0 ? ("AND" as const) : ("OR" as const) })),
    groups: [],
  }));
}

/** The groups' rules as id + connective, disabled ones dropped — what both phases evaluate. */
function evaluated(groups: ConditionGroup[]): Array<Array<[string, string]>> {
  return groups
    .map((g) => g.rules.filter((r) => r.enabled !== false).map((r) => [r.id, r.condition] as [string, string]))
    .filter((g) => g.length > 0);
}

/** Every flat rule list of up to `n` rules over AND/OR × enabled/disabled. */
function allRuleLists(n: number): Condition[][] {
  const out: Condition[][] = [[]];
  let frontier: Condition[][] = [[]];
  for (let len = 1; len <= n; len++) {
    const next: Condition[][] = [];
    for (const prefix of frontier) {
      for (const cond of ["AND", "OR"] as const) {
        for (const enabled of [true, false]) {
          next.push([...prefix, rule(`r${len}`, cond, enabled)]);
        }
      }
    }
    out.push(...next);
    frontier = next;
  }
  return out;
}

describe("legacyRulesToGroups", () => {
  it("reads flat connectives as (A ∨ B) ∧ (C ∨ D)", () => {
    const groups = legacyRulesToGroups([rule("A", "OR"), rule("B", "AND"), rule("C", "OR"), rule("D", "AND")]);
    expect(evaluated(groups)).toEqual([
      [["A", "AND"], ["B", "OR"]],
      [["C", "AND"], ["D", "OR"]],
    ]);
    expect(groups.map((g) => g.id)).toEqual(["legacy-bucket-0", "legacy-bucket-1"]);
  });

  it("is identical to the conversion it replaced, for every list of up to 5 rules", () => {
    for (const rules of allRuleLists(5)) {
      expect(legacyRulesToGroups(rules)).toEqual(previousEngineConversion(rules));
    }
  });

  it("is empty when no rule is enabled", () => {
    expect(legacyRulesToGroups([])).toEqual([]);
    expect(legacyRulesToGroups([rule("A", "AND", false)])).toEqual([]);
  });

  it("never lets a disabled rule's connective split a bucket", () => {
    const groups = legacyRulesToGroups([rule("A", "OR"), rule("B", "AND", false), rule("C", "OR")]);
    expect(evaluated(groups)).toEqual([[["A", "AND"], ["C", "OR"]]]);
  });
});

describe("legacyRulesToEditorGroups", () => {
  let n = 0;
  const makeId = () => `g${++n}`;

  it("keeps every rule, disabled ones included", () => {
    for (const rules of allRuleLists(5)) {
      const groups = legacyRulesToEditorGroups(rules, makeId);
      expect(groups.flatMap((g) => g.rules.map((r) => r.id))).toEqual(rules.map((r) => r.id));
      expect(groups.flatMap((g) => g.rules.map((r) => r.enabled))).toEqual(rules.map((r) => r.enabled));
    }
  });

  it("shows exactly what the engine evaluates", () => {
    for (const rules of allRuleLists(5)) {
      expect(evaluated(legacyRulesToEditorGroups(rules, makeId))).toEqual(evaluated(legacyRulesToGroups(rules)));
    }
  });

  it("rewrites the connectives instead of showing a flat AND as a group AND", () => {
    // The editor used to keep B's own AND, showing (A ∧ B) for what the engine
    // evaluated — and saving — as (A ∨ B).
    const groups = legacyRulesToEditorGroups([rule("A", "OR"), rule("B", "AND"), rule("C", "OR")], makeId);
    expect(groups.map((g) => g.rules.map((r) => `${r.id}:${r.condition}`))).toEqual([
      ["A:AND", "B:OR"],
      ["C:AND"],
    ]);
  });

  it("passes grouped rule sets through, defaulting missing sub-groups", () => {
    const grouped = [{ id: "x", condition: "AND", rules: [rule("A", "AND")] }] as unknown as ConditionGroup[];
    expect(legacyRulesToEditorGroups(grouped, makeId)).toEqual([
      { id: "x", condition: "AND", rules: [rule("A", "AND")], groups: [] },
    ]);
    expect(legacyRulesToEditorGroups([], makeId)).toEqual([]);
  });
});
