/**
 * Shared Phase 1 WHERE-clause builder for stream-query groups, used by both
 * the lifecycle rule engine and the query builder.
 *
 * A "stream query group" is a `ConditionGroup` with `streamQuery: { streamType,
 * quantifier }` set — its rules apply to individual `MediaStream` rows rather
 * than `MediaItem` fields. The three supported quantifiers map to:
 *
 *   any  → `streams: { some: { streamType, AND: conditions } }`
 *   none → `streams: { none: { streamType, AND: conditions } }`
 *   all  → `streams.some { streamType }` AND `streams.none { streamType,
 *           NOT: AND: conditions }`. The `some` precondition prevents the
 *           `none-of-failing` clause from vacuously matching items with zero
 *           streams of the requested type.
 *
 * `all` is a SUPERSET clause: when the column is nullable, Postgres's
 * `NOT (col = X)` is UNKNOWN for NULL rows, so a NULL-column stream is not
 * counted as "failing". Callers must run Phase 2's
 * `matchingStreams.every(streamMatches)` to get the precise answer — see
 * `streamQueryNeedsInMemory`, which always returns `true` for `all`.
 *
 * Wildcards (`matchesWildcard`, `notMatchesWildcard`) and computed fields
 * (`sqAudioProfile`, `sqDynamicRange`, etc.) are skipped here and left for
 * Phase 2.
 */
import { Prisma } from "@/generated/prisma/client";
import type { ConditionGroup } from "./types";
import { UNSATISFIABLE_WHERE, isUnconfiguredContainsRule } from "./where-builder";
import { isEnumerableField, isOperatorApplicable, isValueValidForRule } from "./helpers";
import {
  isStreamQueryComputedField,
  streamQueryFieldToColumn,
  STREAM_TYPE_INT_MAP,
  type StreamQueryField,
} from "./stream-query";

export function buildStreamQueryClause(group: ConditionGroup): Prisma.MediaItemWhereInput | null {
  if (!group.streamQuery) return null;
  const streamTypeInt = STREAM_TYPE_INT_MAP[group.streamQuery.streamType];
  const conditions: Prisma.MediaStreamWhereInput[] = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    const field = rule.field as StreamQueryField;
    if (isStreamQueryComputedField(field)) continue; // Phase 2 only
    if (rule.operator === "matchesWildcard" || rule.operator === "notMatchesWildcard") continue; // Phase 2

    // Safety: unconfigured contains/notContains must never match anything.
    // An unsatisfiable inner condition makes the surrounding `streams.some`
    // / `streams.none` clause vacuously false / true, which fails the group.
    if (isUnconfiguredContainsRule(rule.operator, rule.value)) {
      return UNSATISFIABLE_WHERE;
    }
    // Safety: operator/field-type mismatch (e.g. `contains` on a boolean
    // stream attribute) — fail the group rather than silently dropping
    // the constraint.
    if (!isOperatorApplicable(rule.operator, rule.field)) {
      return UNSATISFIABLE_WHERE;
    }
    // Safety: malformed value → fail the group.
    if (!isValueValidForRule(rule.operator, rule.value, rule.field)) {
      return UNSATISFIABLE_WHERE;
    }

    const column = streamQueryFieldToColumn(field);
    if (!column) continue;

    const { operator, value, negate } = rule;
    let cond: Prisma.MediaStreamWhereInput | null = null;

    // Boolean fields
    if (field === "sqIsDefault" || field === "sqForced") {
      const boolVal = String(value).toLowerCase() === "true";
      switch (operator) {
        case "equals": cond = { [column]: boolVal }; break;
        case "notEquals": cond = { [column]: !boolVal }; break;
      }
    }
    // Numeric fields
    else if (["sqChannels", "sqBitrate", "sqBitDepth", "sqWidth", "sqHeight", "sqFrameRate", "sqSamplingRate"].includes(field)) {
      const numValue = Number(value);
      switch (operator) {
        case "equals": cond = { [column]: numValue }; break;
        case "notEquals": cond = { [column]: { not: numValue } }; break;
        case "greaterThan": cond = { [column]: { gt: numValue } }; break;
        case "greaterThanOrEqual": cond = { [column]: { gte: numValue } }; break;
        case "lessThan": cond = { [column]: { lt: numValue } }; break;
        case "lessThanOrEqual": cond = { [column]: { lte: numValue } }; break;
        case "isNull": cond = { [column]: null }; break;
        case "isNotNull": cond = { [column]: { not: null } }; break;
        case "between": {
          const [minStr, maxStr] = String(value).split(",");
          cond = { [column]: { gte: Number(minStr), lte: Number(maxStr) } };
          break;
        }
      }
    }
    // Text fields
    else {
      const strValue = String(value);
      const enumerable = isEnumerableField(field);
      switch (operator) {
        case "equals": cond = { [column]: { equals: strValue, mode: "insensitive" } }; break;
        case "notEquals":
          // Stream column is nullable; include NULL-language/codec streams to
          // match Phase 2's `String(streamValue ?? "")` coalesce behavior.
          cond = { OR: [{ [column]: null }, { [column]: { not: strValue, mode: "insensitive" } }] };
          break;
        case "contains": {
          if (enumerable) {
            const parts = strValue.split("|").filter(Boolean);
            const matchValues = parts.length > 0 ? parts : [strValue];
            cond = { OR: matchValues.map((v) => ({ [column]: { equals: v, mode: "insensitive" as const } })) };
          } else {
            cond = { [column]: { contains: strValue, mode: "insensitive" } };
          }
          break;
        }
        case "notContains": {
          let notCond: Prisma.MediaStreamWhereInput;
          if (enumerable) {
            const parts = strValue.split("|").filter(Boolean);
            const matchValues = parts.length > 0 ? parts : [strValue];
            notCond = { AND: matchValues.map((v) => ({ NOT: { [column]: { equals: v, mode: "insensitive" as const } } })) };
          } else {
            notCond = { NOT: { [column]: { contains: strValue, mode: "insensitive" } } };
          }
          // Include NULL stream rows for the same Phase 2 parity reason.
          cond = { OR: [{ [column]: null }, notCond] };
          break;
        }
        case "isNull": cond = { [column]: null }; break;
        case "isNotNull": cond = { [column]: { not: null } }; break;
      }
    }

    if (cond) {
      conditions.push(negate ? { NOT: cond } : cond);
    }
  }

  if (conditions.length === 0) return null;

  const quantifier = group.streamQuery.quantifier ?? "any";
  const streamCondition = { streamType: streamTypeInt, AND: conditions };

  if (quantifier === "none") {
    return { streams: { none: streamCondition } };
  }
  if (quantifier === "all") {
    // "all streams of this type match" = at least one such stream EXISTS AND
    // no such stream fails to match. The `some streamType` precondition guards
    // against vacuous truth on items with 0 streams of this type — Phase 2's
    // `matchingStreams.length > 0 && ...every(...)` requires the same.
    return {
      AND: [
        { streams: { some: { streamType: streamTypeInt } } },
        { streams: { none: { streamType: streamTypeInt, NOT: { AND: conditions } } } },
      ],
    };
  }
  // Default: "any" (EXISTS)
  return { streams: { some: streamCondition } };
}
