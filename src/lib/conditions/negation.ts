/**
 * Group-level NOT normalization.
 *
 * A group's `negate` flag is never evaluated directly — doing so would
 * diverge between the engine's two phases: Phase 1 wrapping a group clause
 * in Prisma `{ NOT: ... }` excludes NULL rows under PostgreSQL three-valued
 * logic, while Phase 2's boolean flip over coerced values (`?? ""` / `?? 0`)
 * includes them (see where-builder.ts for the per-rule version of this
 * problem).
 *
 * Instead, both phases call `pushDownGroupNegation` first. It rewrites a
 * negated group via De Morgan's laws into an equivalent tree with no group
 * negation, reusing the per-rule `negate` machinery whose NULL semantics
 * the two phases already agree on:
 *
 *   NOT (A AND B)  →  (NOT A) OR (NOT B)
 *   NOT (A OR  B)  →  (NOT A) AND (NOT B)
 *
 * The engine folds connectives left-associatively, and De Morgan
 * distributes through the fold stepwise:
 *
 *   NOT ((A ⊕₁ B) ⊕₂ C)  →  ((¬A ⊕₁' ¬B) ⊕₂' ¬C)
 *
 * so flipping every child's own negation and dualizing every connective is
 * exact, including for groups that mix AND with OR.
 *
 * Deliberate edge-case semantics (all matching the engine's existing
 * safe defaults):
 * - Disabled / empty groups stay skipped — `NOT (skipped)` never becomes
 *   "match everything".
 * - Dead rules (unknown operator, malformed value) bypass `negate` in both
 *   phases; the push-down preserves that bypass, so a NOT group containing
 *   a dead rule cannot sweep the library.
 * - Stream-query groups map NOT onto the quantifier where it is exact
 *   (any ↔ none, i.e. EXISTS ↔ NOT EXISTS). `all` has no expressible dual,
 *   so NOT is dropped there — the builder never offers it on stream
 *   queries (the quantifier itself covers negation).
 */
import type { ConditionGroup, ConditionLogic } from "./types";

const dual = (c: ConditionLogic): ConditionLogic => (c === "AND" ? "OR" : "AND");

/**
 * Return an equivalent group tree with every group-level `negate` flag
 * pushed down into per-rule negation. Pure — never mutates the input.
 * Idempotent: output trees carry no group `negate` flags.
 *
 * Generic so each engine keeps its own group alias (LifecycleRuleGroup,
 * QueryGroup) — the rewrite is purely structural.
 */
export function pushDownGroupNegation<G extends ConditionGroup>(groups: G[]): G[] {
  return groups.map((group) => normalizeGroup(group));
}

function normalizeGroup<G extends ConditionGroup>(group: G): G {
  if (!group.negate) {
    const subs = (group.groups ?? []) as G[];
    if (subs.length === 0) return group;
    return { ...group, groups: subs.map((sub) => normalizeGroup(sub)) };
  }

  if (group.streamQuery) {
    const quantifier = group.streamQuery.quantifier ?? "any";
    const flipped =
      quantifier === "any" ? "none" : quantifier === "none" ? "any" : quantifier;
    return {
      ...group,
      negate: undefined,
      streamQuery: { ...group.streamQuery, quantifier: flipped },
    };
  }

  // De Morgan push-down: flip each child's own negation, dualize each
  // connective. The first item's condition is ignored by evaluation but is
  // dualized anyway for consistency. Children may now carry their own
  // negate flags (including freshly toggled sub-groups) — recurse once on
  // the rewritten group, which takes the non-negated branch above.
  const rules = group.rules.map((rule) => ({
    ...rule,
    condition: dual(rule.condition),
    negate: !rule.negate,
  }));
  const subs = ((group.groups ?? []) as G[]).map((sub) => ({
    ...sub,
    condition: dual(sub.condition),
    negate: !sub.negate,
  }));
  return normalizeGroup({ ...group, negate: undefined, rules, groups: subs });
}
