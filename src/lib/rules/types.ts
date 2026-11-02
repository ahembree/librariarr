/**
 * Backward-compat shim. The canonical metadata lives in `@/lib/conditions/`.
 * Existing imports from `@/lib/rules/types` keep working through this file;
 * new code should import from `@/lib/conditions/` directly.
 */

import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  CONDITION_SECTIONS,
  ARR_FIELDS as _ARR_FIELDS,
  SEERR_FIELDS as _SEERR_FIELDS,
  STREAM_FIELDS as _STREAM_FIELDS,
  isArrField as _isArrField,
  isSeerrField as _isSeerrField,
  isStreamField as _isStreamField,
  isExternalField as _isExternalField,
  isCrossSystemField as _isCrossSystemField,
  isSeriesAggregateField as _isSeriesAggregateField,
  isArrayField as _isArrayField,
  type Condition,
  type ConditionGroup,
  type ConditionLogic,
} from "@/lib/conditions";

export type { StreamQueryField } from "@/lib/conditions";
export {
  STREAM_QUERY_FIELDS,
  STREAM_TYPE_INT_MAP,
  isStreamQueryField,
  isStreamQueryGroup,
  isStreamQueryComputedField,
  streamQueryFieldToColumn,
} from "@/lib/conditions";

// ─── Type aliases ───────────────────────────────────────────────────────
// `RuleField` was historically a strict union; treat it as `string` going
// forward (matches `QueryRule.field: string` and the runtime reality).
export type RuleField = string;
export type LifecycleRuleCondition = ConditionLogic;
export type LifecycleRule = Condition;
export type LifecycleRuleGroup = ConditionGroup;

// ─── Re-exported registries ─────────────────────────────────────────────
export const RULE_FIELDS = CONDITION_FIELDS;
export const RULE_OPERATORS = CONDITION_OPERATORS;
export const FIELD_SECTIONS = CONDITION_SECTIONS;

// ─── Re-exported field-set arrays / sets ─────────────────────────────────
export const ARR_FIELDS = _ARR_FIELDS;
export const SEERR_FIELDS = _SEERR_FIELDS;
export const STREAM_FIELDS = _STREAM_FIELDS;

// ─── Re-exported predicates ─────────────────────────────────────────────
export const isArrField = _isArrField;
export const isSeerrField = _isSeerrField;
export const isStreamField = _isStreamField;
export const isExternalField = _isExternalField;
export const isCrossSystemField = _isCrossSystemField;
export const isSeriesAggregateField = _isSeriesAggregateField;
export const isArrayField = _isArrayField;
