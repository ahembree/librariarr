import { CONDITION_FIELDS } from "./fields";
import { isNonNullableNonTextField } from "./field-metadata";
import { CONDITION_OPERATORS } from "./operators";
import { STREAM_QUERY_FIELDS } from "./stream-query";
import type { ConditionGroup, ConditionFieldType } from "./types";

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
  "excludedInLibrariarr",
]);
const ENUMERABLE_FIELD_VALUES = new Set(
  [...CONDITION_FIELDS, ...STREAM_QUERY_FIELDS]
    .filter((f) => f.enumerable)
    .map((f) => f.value),
);

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

/**
 * A field is "enumerable" when its values are drawn from a known/finite set
 * (e.g. quality profile names, codecs, languages). The builder shows a
 * multi-select dropdown for `contains` / `notContains` on these fields, so
 * the engine MUST treat those operators as list-membership (exact match
 * against any selected value) rather than substring search — otherwise
 * selecting "Default" would also match "Default New".
 */
export function isEnumerableField(field: string): boolean {
  return ENUMERABLE_FIELD_VALUES.has(field);
}

// ─── Operator validity ──────────────────────────────────────────────────

const ALL_FIELD_TYPE_MAP = new Map<string, ConditionFieldType>(
  [...CONDITION_FIELDS, ...STREAM_QUERY_FIELDS].map((f) => [f.value, f.type]),
);

const OPERATOR_TYPE_MAP = new Map<string, ReadonlySet<ConditionFieldType>>(
  CONDITION_OPERATORS.map((o) => [o.value, new Set(o.types)]),
);

/**
 * Whether the given operator is applicable to the given field, based on the
 * operator/field type registries. Returns false when either is unknown or
 * the operator's allowed types do not include the field's type. The rule
 * engines call this at every evaluator entry point to short-circuit unknown
 * or mismatched rules to "match nothing" — otherwise `default: result = false`
 * in an operator switch would be vacuously flipped to true by negate=true and
 * sweep the library.
 *
 * Note: cross-system, stream-count, hasExternalId, and watchlisted fields
 * are evaluated outside the standard switch flow and are explicitly excluded
 * from this check (the engines handle them in branches that exit before the
 * negate flip).
 */
export function isOperatorApplicable(operator: string, field: string): boolean {
  const fieldType = ALL_FIELD_TYPE_MAP.get(field);
  if (!fieldType) return false;
  const types = OPERATOR_TYPE_MAP.get(operator);
  if (!types) return false;
  if (types.has(fieldType)) return true;
  // isNull / isNotNull are useful for nullable booleans too (e.g.
  // arrQualityCutoffMet, arrEnded). The operator registry omits boolean
  // from their type list to keep the rule builder UI tidy, but the engine
  // supports them via the field-specific null-check branches.
  if ((operator === "isNull" || operator === "isNotNull") && fieldType === "boolean") {
    return true;
  }
  return false;
}

/**
 * UI-level operator filter. Defers to isOperatorApplicable for type checking,
 * then hides isNull / isNotNull when the field is non-nullable AND not a String
 * — for those columns the engine correctly returns UNSATISFIABLE/MATCH_ALL,
 * which is technically right but produces a useless rule ("Play Count Is Empty"
 * always matches 0, "Is Not Empty" always matches all). The rule builder uses
 * this to omit those operators from the dropdown; the engine still accepts
 * them if a rule somehow contains one (e.g. from a saved rule pre-dating this
 * filter), it just returns the trivial result.
 *
 * Non-nullable String fields (title) keep isNull/isNotNull because the engine
 * substitutes empty-string semantics — "Title Is Empty" is a meaningful query.
 */
export function isOperatorVisible(operator: string, field: string): boolean {
  if (!isOperatorApplicable(operator, field)) return false;
  if ((operator === "isNull" || operator === "isNotNull") && isNonNullableNonTextField(field)) {
    return false;
  }
  return true;
}

const VALUELESS_OPERATORS = new Set(["isNull", "isNotNull"]);

/**
 * Whether the rule's value is well-formed for the given field/operator combo.
 * Returns false when the value cannot be meaningfully compared — e.g.
 * `playCount > "abc"` yields `> NaN`, which is false for every item but
 * which negate=true would then flip to true (sweeping the library).
 *
 * Validity rules:
 *  - `isNull`/`isNotNull` ignore value → always valid.
 *  - `between` requires `"a,b"` with both halves valid for the field type.
 *  - Numeric fields require finite numbers (rejects NaN / "abc" / "").
 *  - Date fields require a parseable date (`inLastDays`/`notInLastDays`
 *    expect a non-negative number of days).
 *  - Boolean fields require the literal `"true"`/`"false"`.
 *  - Text fields accept any string — text comparisons can't go vacuous.
 */
/** Strict numeric-string parser. Rejects "", "  ", "5abc" etc. — JS's
 * `Number("")` coerces to 0 and `Number.isFinite(0)` is true, which would
 * leak an empty `between` half (e.g. `"5,"`) past a naive check and produce
 * an always-false `between(5, 0)` clause that negate=true would flip to
 * match-all. */
function isStrictFiniteNumeric(input: string): boolean {
  if (input.trim() === "") return false;
  const n = Number(input);
  // Magnitude cap: unit conversions multiply user input (MB→bytes ×2^20),
  // and a finite-but-huge value like 1.7e308 overflows to Infinity, which
  // BigInt() then throws on — crashing the whole evaluation run.
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER;
}

export function isValueValidForRule(
  operator: string,
  value: string | number,
  field: string,
): boolean {
  if (VALUELESS_OPERATORS.has(operator)) return true;
  const fieldType = ALL_FIELD_TYPE_MAP.get(field);
  if (!fieldType) return false;
  const strValue = String(value);
  if (operator === "between") {
    const parts = strValue.split(",");
    if (parts.length !== 2) return false;
    if (fieldType === "number") {
      if (!isStrictFiniteNumeric(parts[0]) || !isStrictFiniteNumeric(parts[1])) return false;
      // Inverted ranges (min > max) are always-false clauses, which
      // negate=true would flip into match-everything — reject as malformed
      // so both phases treat the rule as dead (bypassing negate).
      return Number(parts[0]) <= Number(parts[1]);
    }
    if (fieldType === "date") {
      if (parts[0].trim() === "" || parts[1].trim() === "") return false;
      const from = new Date(parts[0]).getTime();
      const to = new Date(parts[1]).getTime();
      if (isNaN(from) || isNaN(to)) return false;
      return from <= to;
    }
    return false;
  }
  if (fieldType === "number") {
    return isStrictFiniteNumeric(strValue);
  }
  if (fieldType === "date") {
    if (operator === "inLastDays" || operator === "notInLastDays") {
      if (!isStrictFiniteNumeric(strValue)) return false;
      return Number(strValue) >= 0;
    }
    return strValue !== "" && !isNaN(new Date(strValue).getTime());
  }
  if (fieldType === "boolean") {
    const lower = strValue.toLowerCase();
    return lower === "true" || lower === "false";
  }
  // text — any string is comparable
  return true;
}

/**
 * Pre-negate Phase 2 result for a NULL (or absent) column value, mirroring
 * the Phase 1 clause shapes exactly:
 *
 *  - `isNull` → true, `isNotNull` → false (literal NULL checks).
 *  - Negative-shaped operators (`notEquals`, `notContains`,
 *    `notMatchesWildcard`) are `withNullSafety`-wrapped in Phase 1
 *    (`OR field IS NULL`), so NULL rows always match them.
 *  - Every positive predicate (equals, ordered comparisons, between,
 *    contains, matchesWildcard, date operators including `notInLastDays`,
 *    which is positive-shaped `< cutoff`) is `applyNegateNullable`-wrapped:
 *    NULL rows never match unless the rule itself is negated — which the
 *    caller applies AFTER this result.
 *
 * Phase 2 evaluators must use this instead of coercing NULL to 0/"" and
 * comparing: coerced comparisons make predicates like `lessThan` or
 * `equals 0` spuriously TRUE for missing values, diverging from the SQL.
 */
export function nullValueResult(operator: string): boolean {
  return (
    operator === "isNull" ||
    operator === "notEquals" ||
    operator === "notContains" ||
    operator === "notMatchesWildcard"
  );
}

// Non-nullable field metadata lives in ./field-metadata.ts. Re-exported here
// for backward compatibility with existing imports.
export {
  isNonNullableField,
  isNonNullableTextField,
  isNonNullableNonTextField,
  getNonNullableType,
  type PrismaScalarType,
} from "./field-metadata";

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

export function hasWatchedByUserRules(groups: ConditionGroup[]): boolean {
  return anyRuleMatches(groups, (f) => f === "watchedByUser");
}

/** Resolution rules are evaluated in-memory in both engines (Phase 1 cannot
 *  express normalizeResolutionLabel semantics) — see resolutionHandler. */
export function hasResolutionRules(groups: ConditionGroup[]): boolean {
  return anyRuleMatches(groups, (f) => f === "resolution");
}

/** Stream-count rules are evaluated in-memory (counts over the streams
 *  relation can't honor OR position or group negation as a hoisted SQL
 *  filter). */
export function hasStreamCountRules(groups: ConditionGroup[]): boolean {
  return anyRuleMatches(groups, (f) => f === "audioStreamCount" || f === "subtitleStreamCount");
}
