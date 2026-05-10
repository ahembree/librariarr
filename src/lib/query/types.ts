/**
 * Backward-compat shim. The canonical metadata lives in `@/lib/conditions/`.
 * Existing imports from `@/lib/query/types` keep working through this file;
 * new code should import from `@/lib/conditions/` directly.
 */

import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  CONDITION_SECTIONS,
  ARR_FIELDS,
  SEERR_FIELDS,
  CROSS_SYSTEM_FIELDS,
  STREAM_FIELDS as STREAM_FIELDS_ARRAY,
  GENRE_FIELD as _GENRE_FIELD,
  LABELS_FIELD as _LABELS_FIELD,
  EXTERNAL_ID_FIELD as _EXTERNAL_ID_FIELD,
  isArrField,
  isSeerrField,
  isCrossSystemField,
  hasArrRules as _hasArrRules,
  hasSeerrRules as _hasSeerrRules,
  hasCrossSystemRules as _hasCrossSystemRules,
  hasSeriesAggregateRules as _hasSeriesAggregateRules,
  isSeriesAggregateField as _isSeriesAggregateField,
  type Condition,
  type ConditionGroup,
  type ConditionField,
  type ConditionLogic,
  type ConditionSection,
} from "@/lib/conditions";

// ─── Type aliases ───────────────────────────────────────────────────────
export type RuleOperator = string;
export type RuleCondition = ConditionLogic;
export type QueryRule = Condition;
export type QueryGroup = ConditionGroup;
export type QueryFieldSection = ConditionSection;
export type QueryFieldDef = ConditionField;

// ─── Re-exported registries ─────────────────────────────────────────────
export const QUERY_FIELDS = CONDITION_FIELDS;
export const QUERY_OPERATORS = CONDITION_OPERATORS;
export const QUERY_FIELD_SECTIONS = CONDITION_SECTIONS;

// ─── Field-set sets ──────────────────────────────────────────────────────
// The query module historically used Sets for these; preserve that shape.
export const ARR_QUERY_FIELDS = new Set<string>(ARR_FIELDS);
export const SEERR_QUERY_FIELDS = new Set<string>(SEERR_FIELDS);
export const CROSS_SYSTEM_QUERY_FIELDS = CROSS_SYSTEM_FIELDS;
export const STREAM_FIELDS = new Set<string>(STREAM_FIELDS_ARRAY);

export const GENRE_FIELD = _GENRE_FIELD;
export const LABELS_FIELD = _LABELS_FIELD;
export const EXTERNAL_ID_FIELD = _EXTERNAL_ID_FIELD;

// ─── Predicates ──────────────────────────────────────────────────────────
export function isCrossSystemQueryField(field: string): boolean {
  return isCrossSystemField(field);
}

export function isExternalQueryField(field: string): boolean {
  return isArrField(field) || isSeerrField(field);
}

export const hasArrRules = _hasArrRules;
export const hasSeerrRules = _hasSeerrRules;
export const hasCrossSystemRules = _hasCrossSystemRules;
export const hasSeriesAggregateRules = _hasSeriesAggregateRules;
export const isSeriesAggregateField = _isSeriesAggregateField;

// ─── Query definition shape ──────────────────────────────────────────────
export interface QueryDefinition {
  mediaTypes: ("MOVIE" | "SERIES" | "MUSIC")[];
  serverIds: string[];
  groups: QueryGroup[];
  sortBy: string;
  sortOrder: "asc" | "desc";
  includeEpisodes?: boolean;
  arrServerIds?: {
    radarr?: string;
    sonarr?: string;
    lidarr?: string;
  };
  seerrInstanceId?: string;
}
