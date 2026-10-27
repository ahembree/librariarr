/**
 * Phase 2 of a stream query group: the in-memory evaluation of its rules
 * against an item's individual stream records. Shared by the lifecycle rule
 * engine and the query builder, which carried two copies of it — keep any
 * operator or NULL semantics change here, once.
 */
import { isEnumerableField, isOperatorApplicable, isValueValidForRule } from "@/lib/conditions/helpers";
import {
  isStreamQueryComputedField,
  streamQueryFieldToColumn,
  STREAM_TYPE_INT_MAP,
  type StreamQueryField,
} from "@/lib/conditions/stream-query";
import type { StreamQueryStreamType } from "@/lib/conditions/types";
import { wildcardToRegex } from "@/lib/conditions/wildcard";
import { isUnconfiguredContainsRule } from "@/lib/conditions/where-builder";
import { detectStreamAudioProfile, detectStreamDynamicRange } from "@/lib/rules/stream-detection";

interface StreamQueryRule {
  field: string;
  operator: string;
  value: string | number;
  negate?: boolean;
  enabled?: boolean;
}

interface StreamQueryGroupLike {
  streamQuery?: { streamType: StreamQueryStreamType | string; quantifier?: "any" | "none" | "all" };
  rules: StreamQueryRule[];
}

const NUMERIC_FIELDS = new Set([
  "sqChannels", "sqBitrate", "sqBitDepth", "sqWidth", "sqHeight", "sqFrameRate", "sqSamplingRate",
]);

/**
 * One stream query rule against one stream record.
 *
 * A rule that cannot be evaluated — an unconfigured contains, an operator the
 * field does not take, a malformed value, a field with no stream column — or
 * an operator this does not know matches nothing, and `negate` is not applied
 * to that: a negated "nothing" would match every stream. A numeric comparison
 * on a stream whose value is missing is false, true when negated (both engines'
 * behaviour, kept as it was).
 */
export function evaluateStreamQueryRuleAgainstStream(
  rule: StreamQueryRule,
  stream: Record<string, unknown>,
): boolean {
  if (isUnconfiguredContainsRule(rule.operator, rule.value)) return false;
  if (!isOperatorApplicable(rule.operator, rule.field)) return false;
  if (!isValueValidForRule(rule.operator, rule.value, rule.field)) return false;
  const field = rule.field as StreamQueryField;
  const { operator, value, negate } = rule;

  // The stream's value: a column, or one computed from several.
  let streamValue: unknown;
  if (field === "sqAudioProfile") {
    streamValue = detectStreamAudioProfile(stream as Record<string, string | null>);
  } else if (field === "sqDynamicRange") {
    streamValue = detectStreamDynamicRange(stream as Record<string, string | null>);
  } else {
    const column = streamQueryFieldToColumn(field);
    if (!column) return false;
    streamValue = stream[column];
  }

  // Boolean fields
  if (field === "sqIsDefault" || field === "sqForced") {
    if (operator === "isNull" || operator === "isNotNull") {
      const result = operator === "isNull" ? streamValue == null : streamValue != null;
      return negate ? !result : result;
    }
    const boolVal = String(value).toLowerCase() === "true";
    const actual = !!streamValue;
    let result: boolean;
    switch (operator) {
      case "equals": result = actual === boolVal; break;
      case "notEquals": result = actual !== boolVal; break;
      default: return false;
    }
    return negate ? !result : result;
  }

  // Numeric fields
  if (NUMERIC_FIELDS.has(field)) {
    const numValue = Number(value);
    const actual = streamValue != null ? Number(streamValue) : null;
    let result: boolean;
    switch (operator) {
      case "isNull": result = actual == null; break;
      case "isNotNull": result = actual != null; break;
      default: {
        if (actual == null) return negate ? true : false;
        switch (operator) {
          case "equals": result = actual === numValue; break;
          case "notEquals": result = actual !== numValue; break;
          case "greaterThan": result = actual > numValue; break;
          case "greaterThanOrEqual": result = actual >= numValue; break;
          case "lessThan": result = actual < numValue; break;
          case "lessThanOrEqual": result = actual <= numValue; break;
          case "between": {
            const [minStr, maxStr] = String(value).split(",");
            result = actual >= Number(minStr) && actual <= Number(maxStr);
            break;
          }
          default: return false;
        }
      }
    }
    return negate ? !result : result;
  }

  // Text fields (including computed)
  const strActual = streamValue != null ? String(streamValue).toLowerCase() : "";
  const strValue = String(value).toLowerCase();
  const streamEnumerable = isEnumerableField(field);

  let result: boolean;
  switch (operator) {
    case "isNull": result = streamValue == null || strActual === ""; break;
    case "isNotNull": result = streamValue != null && strActual !== ""; break;
    case "equals": result = strActual === strValue; break;
    case "notEquals": result = strActual !== strValue; break;
    case "contains": {
      if (streamEnumerable) {
        const parts = strValue.split("|").filter(Boolean);
        result = parts.length > 0 ? parts.some((p) => strActual === p) : strActual === strValue;
      } else {
        result = strActual.includes(strValue);
      }
      break;
    }
    case "notContains": {
      if (streamEnumerable) {
        const parts = strValue.split("|").filter(Boolean);
        result = parts.length > 0 ? !parts.some((p) => strActual === p) : strActual !== strValue;
      } else {
        result = !strActual.includes(strValue);
      }
      break;
    }
    case "matchesWildcard": result = wildcardToRegex(strValue).test(strActual); break;
    case "notMatchesWildcard": result = !wildcardToRegex(strValue).test(strActual); break;
    default: return false;
  }
  return negate ? !result : result;
}

/**
 * A stream query group in memory: whether ANY (default), NONE or ALL of the
 * item's streams of the group's type satisfy every active rule. A group with
 * no active rule, or with a rule that cannot be evaluated, matches nothing —
 * otherwise "none" would be vacuously true and sweep the library (the mirror
 * of `buildStreamQueryClause` answering UNSATISFIABLE_WHERE). "all" over no
 * stream of the type is false.
 */
export function evaluateStreamQueryGroupInMemory(
  group: StreamQueryGroupLike,
  item: Record<string, unknown>,
): boolean {
  if (!group.streamQuery) return false;
  const streamTypeInt = STREAM_TYPE_INT_MAP[group.streamQuery.streamType as StreamQueryStreamType];
  const streams = (item.streams as Array<Record<string, unknown>>) ?? [];
  const matchingStreams = streams.filter((s) => s.streamType === streamTypeInt);

  const activeRules = group.rules.filter((r) => r.enabled !== false);
  if (activeRules.length === 0) return false;

  if (activeRules.some((rule) =>
    isUnconfiguredContainsRule(rule.operator, rule.value) ||
    !isOperatorApplicable(rule.operator, rule.field) ||
    !isValueValidForRule(rule.operator, rule.value, rule.field) ||
    (!isStreamQueryComputedField(rule.field) && !streamQueryFieldToColumn(rule.field as StreamQueryField))
  )) {
    return false;
  }

  const quantifier = group.streamQuery.quantifier ?? "any";
  const streamMatches = (stream: Record<string, unknown>) =>
    activeRules.every((rule) => evaluateStreamQueryRuleAgainstStream(rule, stream));

  if (quantifier === "none") return !matchingStreams.some(streamMatches);
  if (quantifier === "all") return matchingStreams.length > 0 && matchingStreams.every(streamMatches);
  return matchingStreams.some(streamMatches);
}
