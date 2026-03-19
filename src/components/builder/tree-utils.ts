import type { BaseRule, BaseGroup } from "./types";
import { generateId } from "@/lib/utils";

/** Deep-update a group anywhere in a tree by id */
export function updateGroupInTree<R extends BaseRule, G extends BaseGroup<R>>(
  groups: G[],
  groupId: string,
  updater: (g: G) => G | null,
): G[] {
  return groups
    .map((g) => {
      if (g.id === groupId) return updater(g);
      const updatedSubs = updateGroupInTree(g.groups as G[], groupId, updater);
      return { ...g, groups: updatedSubs };
    })
    .filter((g): g is G => g !== null);
}

/** Deep-clone a rule with a new id */
export function deepCloneRule<R extends BaseRule>(rule: R): R {
  return { ...rule, id: generateId() };
}

/** Deep-clone a group with new ids for the group and all its rules/sub-groups */
export function deepCloneGroup<R extends BaseRule, G extends BaseGroup<R>>(
  group: G,
): G {
  return {
    ...group,
    id: generateId(),
    rules: group.rules.map((r) => deepCloneRule(r as R)),
    groups: (group.groups ?? []).map((sg) => deepCloneGroup(sg as G)),
  } as G;
}

/** Count all enabled rules recursively */
export function countAllRules<R extends BaseRule>(
  groups: BaseGroup<R>[],
): number {
  let count = 0;
  for (const g of groups) {
    if (g.enabled === false) continue;
    count += g.rules.filter((r) => r.enabled !== false).length;
    count += countAllRules(g.groups ?? []);
  }
  return count;
}

/**
 * Validate that every enabled rule in the tree has a non-empty, type-appropriate value.
 * Accepts a getFieldType function and an optional isValuelessOperator function
 * to handle domain-specific validation (e.g. isNull/isNotNull in query builder).
 */
export function validateAllRules<R extends BaseRule>(
  groups: BaseGroup<R>[],
  getFieldType: (field: string) => "number" | "text" | "date" | "boolean",
  isValuelessOperator?: (op: string) => boolean,
): boolean {
  for (const g of groups) {
    if (g.enabled === false) continue;
    for (const rule of g.rules) {
      if (rule.enabled === false) continue;
      if (isValuelessOperator?.(rule.operator)) continue;
      const val = String(rule.value).trim();
      if (val === "") return false;
      const fieldType = getFieldType(rule.field);
      if (fieldType === "number" || rule.operator === "inLastDays" || rule.operator === "notInLastDays") {
        if (isNaN(Number(val))) return false;
      }
    }
    if (!validateAllRules(g.groups ?? [], getFieldType, isValuelessOperator))
      return false;
  }
  return true;
}

/** Find a rule in the tree by its id, returning the group id it belongs to */
export function findRuleInTree<R extends BaseRule, G extends BaseGroup<R>>(
  groups: G[],
  ruleId: string,
): { groupId: string; rule: R; index: number } | null {
  for (const g of groups) {
    const rules = g.rules as R[];
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx !== -1) return { groupId: g.id, rule: rules[idx], index: idx };
    const found = findRuleInTree<R, G>(g.groups as G[], ruleId);
    if (found) return found;
  }
  return null;
}

/** Find a sub-group in the tree, returning its parent group id */
export function findSubGroupInTree<R extends BaseRule, G extends BaseGroup<R>>(
  groups: G[],
  groupId: string,
): { parentGroupId: string; group: G; index: number } | null {
  for (const g of groups) {
    const subs = (g.groups ?? []) as G[];
    const idx = subs.findIndex((sg) => sg.id === groupId);
    if (idx !== -1)
      return { parentGroupId: g.id, group: subs[idx], index: idx };
    const found = findSubGroupInTree(subs, groupId);
    if (found) return found;
  }
  return null;
}

/** Parse a sortable item ID into its components */
export function parseItemId(
  id: string,
): {
  type: "rule" | "subgroup";
  parentGroupId: string;
  itemId: string;
} | null {
  const str = String(id);
  if (str.startsWith("sg:")) {
    const rest = str.slice(3);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) return null;
    return {
      type: "subgroup",
      parentGroupId: rest.slice(0, colonIdx),
      itemId: rest.slice(colonIdx + 1),
    };
  }
  const colonIdx = str.indexOf(":");
  if (colonIdx === -1) return null;
  return {
    type: "rule",
    parentGroupId: str.slice(0, colonIdx),
    itemId: str.slice(colonIdx + 1),
  };
}

/** Check if targetId is the group itself or any descendant */
export function isDescendantOrSelf<R extends BaseRule>(
  group: BaseGroup<R>,
  targetId: string,
): boolean {
  if (group.id === targetId) return true;
  for (const sub of group.groups ?? []) {
    if (isDescendantOrSelf(sub, targetId)) return true;
  }
  return false;
}
