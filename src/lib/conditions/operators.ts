import type { ConditionOperatorDef } from "./types";

/**
 * Single source of truth for operator definitions, shared by the rule builder
 * and the query builder. Labels are in symbolic form (`>=`, `<=`); date fields
 * fall through to `dateLabel` overrides where defined (e.g. "Is On" for `equals`).
 */
export const CONDITION_OPERATORS: ConditionOperatorDef[] = [
  { value: "equals", label: "Equals", dateLabel: "Is On", types: ["number", "text", "date", "boolean"] },
  { value: "notEquals", label: "Not Equals", dateLabel: "Is Not On", types: ["number", "text", "date", "boolean"] },
  { value: "greaterThan", label: "Greater Than", types: ["number"] },
  { value: "greaterThanOrEqual", label: ">=", types: ["number"] },
  { value: "lessThan", label: "Less Than", types: ["number"] },
  { value: "lessThanOrEqual", label: "<=", types: ["number"] },
  { value: "contains", label: "Contains", types: ["text"] },
  { value: "notContains", label: "Not Contains", types: ["text"] },
  { value: "matchesWildcard", label: "Matches Wildcard", types: ["text"] },
  { value: "notMatchesWildcard", label: "Not Matches Wildcard", types: ["text"] },
  { value: "before", label: "Is Before", types: ["date"] },
  { value: "after", label: "Is After", types: ["date"] },
  { value: "inLastDays", label: "In Last X Days", types: ["date"] },
  { value: "notInLastDays", label: "More Than X Days Ago", types: ["date"] },
  { value: "between", label: "Between", types: ["number", "date"] },
  { value: "isNull", label: "Is Empty", types: ["number", "text", "date"] },
  { value: "isNotNull", label: "Is Not Empty", types: ["number", "text", "date"] },
];

export function isValuelessOperator(op: string): boolean {
  return op === "isNull" || op === "isNotNull";
}
