/**
 * Shared group composition for the lifecycle rule engine and the query
 * builder. Walks a `ConditionGroup` tree, applies a caller-supplied
 * per-rule WHERE-builder, and combines the resulting clauses using each
 * rule's / sub-group's `condition` (AND | OR) into a single Prisma WHERE.
 *
 * The per-rule builder is the only thing that diverges between the two
 * engines (`ruleToWhereClause` in the rule engine vs `queryRuleToWhere` in
 * the query builder), so it's passed in as a callback. Group-level
 * branching (stream-query groups → `buildStreamQueryClause`, disabled
 * groups, empty groups, single-rule short-circuits) is identical and lives
 * here.
 */
import { Prisma } from "@/generated/prisma/client";
import type { Condition, ConditionGroup, ConditionLogic } from "./types";
import { isStreamQueryGroup } from "./stream-query";
import { pushDownGroupNegation } from "./negation";
import { buildStreamQueryClause, streamQueryNeedsInMemory } from "./stream-query-where";

export type RuleToWhereFn = (rule: Condition) => Prisma.MediaItemWhereInput;

/**
 * Recursively reduce a single ConditionGroup to a Prisma WHERE clause.
 * Returns `null` when the group is disabled or yields no DB-expressible
 * constraints (the caller skips null groups).
 */
export function evaluateGroup(
  group: ConditionGroup,
  ruleToWhere: RuleToWhereFn,
): Prisma.MediaItemWhereInput | null {
  if (group.enabled === false) return null;

  // Stream query groups: build a single `streams: { ... }` clause
  if (isStreamQueryGroup(group)) {
    return buildStreamQueryClause(group);
  }

  const items: Array<{ condition: ConditionLogic; clause: Prisma.MediaItemWhereInput }> = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    const clause = ruleToWhere(rule);
    if (Object.keys(clause).length > 0) items.push({ condition: rule.condition, clause });
  }

  for (const sub of group.groups ?? []) {
    const subClause = evaluateGroup(sub, ruleToWhere);
    if (subClause) items.push({ condition: sub.condition, clause: subClause });
  }

  if (items.length === 0) return null;
  if (items.length === 1) return items[0].clause;

  let result: Prisma.MediaItemWhereInput = items[0].clause;
  for (let i = 1; i < items.length; i++) {
    const { condition, clause } = items[i];
    if (condition === "OR") {
      result = { OR: [result, clause] };
    } else {
      result = { AND: [result, clause] };
    }
  }
  return result;
}

/**
 * Reduce an array of top-level ConditionGroups (typically the rule set or
 * query definition's root `groups`) to a single Prisma WHERE clause,
 * combining each group's contribution by its own `condition` (AND | OR).
 * Returns `{}` (no constraint) when every group is null/empty.
 */
export function buildGroupConditions(
  groups: ConditionGroup[],
  ruleToWhere: RuleToWhereFn,
): Prisma.MediaItemWhereInput {
  // Rewrite group-level NOT into per-rule negation first — see negation.ts
  // for why neither phase evaluates the flag directly.
  const normalizedGroups = pushDownGroupNegation(groups);
  const groupClauses: Array<{ condition: ConditionLogic; where: Prisma.MediaItemWhereInput }> = [];

  for (const group of normalizedGroups) {
    const where = evaluateGroup(group, ruleToWhere);
    if (!where) continue;
    groupClauses.push({ condition: group.condition, where });
  }

  if (groupClauses.length === 0) return {};
  if (groupClauses.length === 1) return groupClauses[0].where;

  let result: Prisma.MediaItemWhereInput = groupClauses[0].where;
  for (let i = 1; i < groupClauses.length; i++) {
    const { condition, where } = groupClauses[i];
    if (condition === "OR") {
      result = { OR: [result, where] };
    } else {
      result = { AND: [result, where] };
    }
  }
  return result;
}


// ─── Pre-filter composition (EXTERNAL-aware) ───────────────────────────────
//
// When Phase 2 in-memory evaluation will run, the Phase 1 WHERE acts only as
// a PRE-FILTER and must be a SUPERSET of the in-memory result — dropping a
// non-DB-expressible rule from an OR branch would otherwise narrow the fetch
// and hide items Phase 2 would have matched. Rules whose clause is `{}`
// (Arr/Seerr fields, wildcards, stream counts, resolution, …) become the
// EXTERNAL_RULE placeholder, which propagates:
//
//   EXTERNAL OR  X = EXTERNAL   (the dropped branch might match anything)
//   EXTERNAL AND X = X          (a dropped conjunct is safely relaxed)

export const EXTERNAL_RULE = "EXTERNAL_RULE" as const;
export type PreFilterClause = Prisma.MediaItemWhereInput | typeof EXTERNAL_RULE;

export function combinePreFilter(
  left: PreFilterClause,
  right: PreFilterClause,
  condition: "AND" | "OR",
): PreFilterClause {
  if (condition === "OR") {
    if (left === EXTERNAL_RULE || right === EXTERNAL_RULE) return EXTERNAL_RULE;
    return { OR: [left, right] };
  } else {
    if (left === EXTERNAL_RULE) return right;
    if (right === EXTERNAL_RULE) return left;
    return { AND: [left, right] };
  }
}

function evaluateGroupPreFilter(
  group: ConditionGroup,
  ruleToWhere: RuleToWhereFn,
): PreFilterClause | null {
  if (group.enabled === false) return null;

  // Stream query groups: build DB clause if possible, EXTERNAL_RULE if it has computed/wildcard rules
  if (isStreamQueryGroup(group)) {
    const dbClause = buildStreamQueryClause(group);
    if (streamQueryNeedsInMemory(group)) {
      // `none` inverts containment: dropping a Phase-2-only conjunct ENLARGES
      // the inner match-set, so none(partial) is NARROWER than the truth and
      // would exclude items Phase 2 matches. Only the EXTERNAL placeholder is
      // a safe pre-filter there.
      if ((group.streamQuery?.quantifier ?? "any") === "none") return EXTERNAL_RULE;
      // any/all: the partial clause is a superset — keep it for performance.
      return dbClause ? combinePreFilter(dbClause, EXTERNAL_RULE, "AND") : EXTERNAL_RULE;
    }
    return dbClause ?? EXTERNAL_RULE;
  }

  const items: Array<{ condition: ConditionLogic; clause: PreFilterClause }> = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    const clause = ruleToWhere(rule);
    items.push({
      condition: rule.condition,
      clause: Object.keys(clause).length > 0 ? clause : EXTERNAL_RULE,
    });
  }

  for (const sub of group.groups ?? []) {
    const subClause = evaluateGroupPreFilter(sub, ruleToWhere);
    if (subClause === null) continue; // Disabled sub-group, truly skip
    items.push({ condition: sub.condition, clause: subClause });
  }

  if (items.length === 0) return null;
  if (items.length === 1) return items[0].clause;

  let result: PreFilterClause = items[0].clause;
  for (let i = 1; i < items.length; i++) {
    result = combinePreFilter(result, items[i].clause, items[i].condition);
  }
  return result;
}

/**
 * EXTERNAL-aware variant of buildGroupConditions for callers that will run
 * Phase 2. Returns `{}` (no constraint) when the tree resolves to "Phase 2
 * decides" — callers must only use this when in-memory evaluation runs.
 */
export function buildGroupConditionsPreFilter(
  groups: ConditionGroup[],
  ruleToWhere: RuleToWhereFn,
): Prisma.MediaItemWhereInput {
  // Rewrite group-level NOT into per-rule negation first — see negation.ts.
  const normalizedGroups = pushDownGroupNegation(groups);
  const groupClauses: Array<{ condition: ConditionLogic; clause: PreFilterClause }> = [];

  for (const group of normalizedGroups) {
    const result = evaluateGroupPreFilter(group, ruleToWhere);
    if (result === null) continue;
    groupClauses.push({ condition: group.condition, clause: result });
  }

  if (groupClauses.length === 0) return {};

  let result: PreFilterClause = groupClauses[0].clause;
  for (let i = 1; i < groupClauses.length; i++) {
    result = combinePreFilter(result, groupClauses[i].clause, groupClauses[i].condition);
  }
  return result === EXTERNAL_RULE ? {} : result;
}
