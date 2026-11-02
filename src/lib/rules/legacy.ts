import type { Condition, ConditionGroup, ConditionLogic } from "@/lib/conditions/types";

/**
 * Legacy flat rule sets (the pre-groups format) as the group tree they are
 * evaluated as. Pure and dependency-free: the rule engine and the rule
 * editor (a client component) both read it, so the editor shows a legacy rule
 * set exactly as the engine evaluates it.
 *
 * A flat rule's `condition` is the connective to the NEXT rule: buckets split
 * after each rule whose condition is AND, rules within a bucket join with OR,
 * and buckets join with AND — `[A∨, B∧, C∨, D]` is (A ∨ B) ∧ (C ∨ D). In a
 * group a rule's `condition` is the connective to the PREVIOUS item instead,
 * so each rule's condition is rewritten: the first in its bucket AND (it is
 * ignored), the rest OR.
 *
 * Only ENABLED rules place bucket boundaries. A disabled rule's connective
 * never splits a bucket — the old in-memory evaluator filtered disabled rules
 * out before reading connectives, and the old Phase 1 did not, so the phases
 * disagreed; the group path ends that.
 */
function bucketLegacyRules(rules: Condition[], keepDisabled: boolean): Condition[][] {
  const enabled = rules.filter((r) => r.enabled !== false);
  const lastEnabled = enabled.at(-1);
  const buckets: Condition[][] = [[]];
  for (const rule of rules) {
    const active = rule.enabled !== false;
    if (!active && !keepDisabled) continue;
    buckets[buckets.length - 1].push(rule);
    // Split only before a later enabled rule, so no bucket is left empty.
    if (active && rule !== lastEnabled && rule.condition === "AND") buckets.push([]);
  }
  return buckets;
}

function bucketToGroup(bucket: Condition[], id: string): ConditionGroup {
  // AND on the first ENABLED rule — the one whose connective both phases
  // ignore — so a kept disabled rule ahead of it changes nothing evaluated.
  const firstActive = Math.max(0, bucket.findIndex((r) => r.enabled !== false));
  return {
    id,
    condition: "AND",
    rules: bucket.map((r, ri) => ({ ...r, condition: (ri === firstActive ? "AND" : "OR") as ConditionLogic })),
    groups: [],
  };
}

/**
 * The engine's conversion: enabled rules only. Empty when no rule is
 * enabled, which every caller reads as "nothing to evaluate".
 */
export function legacyRulesToGroups(rules: Condition[]): ConditionGroup[] {
  if (!rules.some((r) => r.enabled !== false)) return [];
  return bucketLegacyRules(rules, false).map((bucket, bi) => bucketToGroup(bucket, `legacy-bucket-${bi}`));
}

/**
 * The rule editor's conversion: the same buckets, with every disabled rule
 * kept in the bucket it sits in, so opening and saving a legacy rule set
 * neither loses a disabled rule nor changes what is evaluated (disabled rules
 * are skipped by both phases wherever they sit).
 */
export function legacyRulesToEditorGroups(
  rules: Condition[] | ConditionGroup[],
  makeId: () => string,
): ConditionGroup[] {
  if (rules.length === 0) return [];
  if ("rules" in rules[0]) {
    return (rules as ConditionGroup[]).map((g) => ({ ...g, groups: g.groups ?? [] }));
  }
  return bucketLegacyRules(rules as Condition[], true).map((bucket) => bucketToGroup(bucket, makeId()));
}
