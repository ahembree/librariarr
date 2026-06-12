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
import { buildStreamQueryClause } from "./stream-query-where";

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
