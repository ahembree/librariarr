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
import { escapeLike, UNSATISFIABLE_WHERE, isUnconfiguredContainsRule } from "./where-builder";
import { isEnumerableField, isOperatorApplicable, isValueValidForRule } from "./helpers";
import {
  isStreamQueryComputedField,
  streamQueryFieldToColumn,
  STREAM_TYPE_INT_MAP,
  type StreamQueryField,
} from "./stream-query";

/**
 * Whether a stream-query group needs Phase 2 in-memory re-evaluation.
 * Returns true when the group either:
 *   - uses the `all` quantifier (Phase 1 emits a superset clause — see
 *     `buildStreamQueryClause` for the NULL-column reasoning), or
 *   - contains a computed stream field (sqAudioProfile, sqDynamicRange,
 *     etc.), or
 *   - contains a wildcard operator (matchesWildcard / notMatchesWildcard).
 */
export function streamQueryNeedsInMemory(group: ConditionGroup): boolean {
  if (!group.streamQuery) return false;
  if ((group.streamQuery.quantifier ?? "any") === "all") return true;
  return group.rules.some((r) =>
    r.enabled !== false && (
      isStreamQueryComputedField(r.field) ||
      r.operator === "matchesWildcard" ||
      r.operator === "notMatchesWildcard"
    ),
  );
}

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
    // A field that doesn't map to a stream column doesn't belong in a stream
    // query — fail the group rather than silently dropping the constraint
    // (a dropped conjunct widens `any`, and makes `none` vacuously true).
    if (!column) return UNSATISFIABLE_WHERE;

    const { operator, value, negate } = rule;
    let cond: Prisma.MediaStreamWhereInput | null = null;
    // How `negate` applies, mirroring Phase 2's NULL coalescing per shape:
    //  - "positive": Phase 2 evaluates the coalesced/early-NULL predicate to
    //    false for NULL streams, so its negation matches them — the SQL NOT
    //    needs an `OR column IS NULL` union.
    //  - "selfsafe": the clause already encodes its own NULL behavior
    //    (notEquals/notContains OR-null shapes, isNull/isNotNull) and a plain
    //    NOT inverts it exactly.
    //  - "handled": negate already folded into the clause (booleans below).
    let negateShape: "positive" | "selfsafe" | "handled" = "positive";

    // Boolean fields — Phase 2 coerces `!!streamValue`, so NULL ≡ false.
    // equals/notEquals/negate all reduce to "matches the true side or the
    // false side"; the false side includes NULL rows.
    if (field === "sqIsDefault" || field === "sqForced") {
      const boolVal = String(value).toLowerCase() === "true";
      if (operator === "isNull") {
        cond = { [column]: null };
        negateShape = "selfsafe";
      } else if (operator === "isNotNull") {
        cond = { [column]: { not: null } };
        negateShape = "selfsafe";
      } else if (operator === "equals" || operator === "notEquals") {
        let matchesTrue = operator === "equals" ? boolVal : !boolVal;
        if (negate) matchesTrue = !matchesTrue;
        cond = matchesTrue
          ? { [column]: true }
          : { OR: [{ [column]: false }, { [column]: null }] };
        negateShape = "handled";
      }
    }
    // Numeric fields — Phase 2 short-circuits NULL → (negate ? true : false)
    // for every comparison including notEquals, so they are all "positive".
    else if (["sqChannels", "sqBitrate", "sqBitDepth", "sqWidth", "sqHeight", "sqFrameRate", "sqSamplingRate"].includes(field)) {
      const numValue = Number(value);
      switch (operator) {
        case "equals": cond = { [column]: numValue }; break;
        case "notEquals": cond = { [column]: { not: numValue } }; break;
        case "greaterThan": cond = { [column]: { gt: numValue } }; break;
        case "greaterThanOrEqual": cond = { [column]: { gte: numValue } }; break;
        case "lessThan": cond = { [column]: { lt: numValue } }; break;
        case "lessThanOrEqual": cond = { [column]: { lte: numValue } }; break;
        case "isNull": cond = { [column]: null }; negateShape = "selfsafe"; break;
        case "isNotNull": cond = { [column]: { not: null } }; negateShape = "selfsafe"; break;
        case "between": {
          const [minStr, maxStr] = String(value).split(",");
          cond = { [column]: { gte: Number(minStr), lte: Number(maxStr) } };
          break;
        }
      }
    }
    // Text fields — Phase 2 coalesces NULL → "".
    else {
      const strValue = String(value);
      const enumerable = isEnumerableField(field);
      switch (operator) {
        case "equals": cond = { [column]: { equals: escapeLike(strValue), mode: "insensitive" } }; break;
        case "notEquals":
          // Stream column is nullable; include NULL-language/codec streams to
          // match Phase 2's `String(streamValue ?? "")` coalesce behavior.
          cond = { OR: [{ [column]: null }, { [column]: { not: escapeLike(strValue), mode: "insensitive" } }] };
          negateShape = "selfsafe";
          break;
        case "contains": {
          if (enumerable) {
            const parts = strValue.split("|").filter(Boolean);
            const matchValues = parts.length > 0 ? parts : [strValue];
            cond = { OR: matchValues.map((v) => ({ [column]: { equals: escapeLike(v), mode: "insensitive" as const } })) };
          } else {
            cond = { [column]: { contains: escapeLike(strValue), mode: "insensitive" } };
          }
          break;
        }
        case "notContains": {
          let notCond: Prisma.MediaStreamWhereInput;
          if (enumerable) {
            const parts = strValue.split("|").filter(Boolean);
            const matchValues = parts.length > 0 ? parts : [strValue];
            notCond = { AND: matchValues.map((v) => ({ NOT: { [column]: { equals: escapeLike(v), mode: "insensitive" as const } } })) };
          } else {
            notCond = { NOT: { [column]: { contains: escapeLike(strValue), mode: "insensitive" } } };
          }
          // Include NULL stream rows for the same Phase 2 parity reason.
          cond = { OR: [{ [column]: null }, notCond] };
          negateShape = "selfsafe";
          break;
        }
        // Phase 2 treats coalesced "" as empty too — match both forms.
        case "isNull": cond = { OR: [{ [column]: null }, { [column]: "" }] }; negateShape = "selfsafe"; break;
        case "isNotNull": cond = { AND: [{ [column]: { not: null } }, { NOT: { [column]: "" } }] }; negateShape = "selfsafe"; break;
      }
    }

    if (cond) {
      if (!negate || negateShape === "handled") {
        conditions.push(cond);
      } else if (negateShape === "selfsafe") {
        conditions.push({ NOT: cond });
      } else {
        conditions.push({ OR: [{ [column]: null }, { NOT: cond }] });
      }
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
