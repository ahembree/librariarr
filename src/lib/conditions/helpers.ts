import { CONDITION_FIELDS } from "./fields";
import type { ConditionGroup } from "./types";

// ─── Field-set predicates ────────────────────────────────────────────────

const ARR_FIELD_VALUES = new Set(
  CONDITION_FIELDS.filter((f) => f.requiresArr).map((f) => f.value),
);
const SEERR_FIELD_VALUES = new Set(
  CONDITION_FIELDS.filter((f) => f.requiresSeerr).map((f) => f.value),
);
const SERIES_AGGREGATE_FIELD_VALUES = new Set(
  CONDITION_FIELDS.filter((f) => f.isSeriesAggregate).map((f) => f.value),
);
const STREAM_FIELD_VALUES = new Set([
  "audioLanguage",
  "subtitleLanguage",
  "streamAudioCodec",
  "audioStreamCount",
  "subtitleStreamCount",
]);
const CROSS_SYSTEM_FIELD_VALUES = new Set([
  "serverCount",
  "matchedByRuleSet",
  "hasPendingAction",
]);

export function isArrField(field: string): boolean {
  return ARR_FIELD_VALUES.has(field);
}

export function isSeerrField(field: string): boolean {
  return SEERR_FIELD_VALUES.has(field);
}

export function isExternalField(field: string): boolean {
  return isArrField(field) || isSeerrField(field);
}

export function isStreamField(field: string): boolean {
  return STREAM_FIELD_VALUES.has(field);
}

export function isCrossSystemField(field: string): boolean {
  return CROSS_SYSTEM_FIELD_VALUES.has(field);
}

export function isSeriesAggregateField(field: string): boolean {
  return SERIES_AGGREGATE_FIELD_VALUES.has(field);
}

// Stable arrays for callers that need to enumerate
export const ARR_FIELDS = Array.from(ARR_FIELD_VALUES);
export const SEERR_FIELDS = Array.from(SEERR_FIELD_VALUES);
export const SERIES_AGGREGATE_FIELDS = Array.from(SERIES_AGGREGATE_FIELD_VALUES);
export const STREAM_FIELDS = Array.from(STREAM_FIELD_VALUES);
export const CROSS_SYSTEM_FIELDS = CROSS_SYSTEM_FIELD_VALUES;

// Constant field names used by both engines for direct comparison
export const GENRE_FIELD = "genre";
export const LABELS_FIELD = "labels";
export const EXTERNAL_ID_FIELD = "hasExternalId";

// ─── Tree walkers ────────────────────────────────────────────────────────

function anyRuleMatches(
  groups: ConditionGroup[],
  predicate: (field: string) => boolean,
): boolean {
  for (const group of groups) {
    if (group.enabled === false) continue;
    if (group.rules.some((r) => r.enabled !== false && predicate(r.field))) {
      return true;
    }
    if (group.groups?.length && anyRuleMatches(group.groups, predicate)) {
      return true;
    }
  }
  return false;
}

export function hasArrRules(groups: ConditionGroup[]): boolean {
  return anyRuleMatches(groups, isArrField);
}

export function hasSeerrRules(groups: ConditionGroup[]): boolean {
  return anyRuleMatches(groups, isSeerrField);
}

export function hasCrossSystemRules(groups: ConditionGroup[]): boolean {
  return anyRuleMatches(groups, isCrossSystemField);
}

export function hasSeriesAggregateRules(groups: ConditionGroup[]): boolean {
  return anyRuleMatches(groups, isSeriesAggregateField);
}
