/**
 * Shared WHERE-clause primitives for the lifecycle rule engine and the
 * query builder. Both engines build Prisma `MediaItemWhereInput` trees
 * from nested AND/OR rule groups; the per-field handlers diverge slightly
 * but these primitives must stay identical so the two engines produce
 * structurally equivalent WHERE clauses for equivalent rules.
 *
 * NULL semantics rationale (the core reason these helpers exist):
 *
 *   Phase 1 (Prisma WHERE) runs PostgreSQL three-valued logic — NULL rows
 *   evaluate to UNKNOWN under `{ field: { not: X } }` and `{ NOT: { field: ... } }`
 *   and are EXCLUDED from the result.
 *
 *   Phase 2 (in-memory evaluator in engine.ts) coerces NULL → default
 *   (`?? ""` or `?? 0`) before comparing, then `negate ? !match : match`
 *   flips, so NULL rows are INCLUDED for negated positive predicates.
 *
 *   Without `withNullSafety` / `applyNegateNullable`, Phase 1 drops items
 *   that Phase 2 would have matched — the engine's two phases must agree
 *   or matches and post-filters disagree on the same item.
 */
import { Prisma } from "@/generated/prisma/client";
import { isNonNullableField, isNonNullableNonTextField, isNonNullableTextField } from "./field-metadata";
import { isEnumerableField, isOperatorApplicable, isValueValidForRule } from "./helpers";
import { MB_IN_BYTES, DURATION_MS_PER_MIN, RESOLUTION_DB_VALUES } from "./constants";

export function applyNegate(clause: Prisma.MediaItemWhereInput, negate?: boolean): Prisma.MediaItemWhereInput {
  if (!negate) return clause;
  return { NOT: clause };
}

/**
 * Wrap a "not"-shaped clause (notEquals / notContains / etc.) so that NULL
 * rows are correctly INCLUDED in the result. Prisma's `{ field: { not: X } }`
 * and `{ NOT: { field: { contains: X } } }` evaluate to UNKNOWN for NULL
 * rows under PostgreSQL three-valued logic, which excludes them — but the
 * Phase 2 in-memory evaluator coerces NULL to a default (`?? ""` or `?? 0`)
 * and INCLUDES them, so without this wrapper Phase 1 drops items that
 * Phase 2 would have matched. For non-nullable columns the wrapper is a
 * no-op (no NULL rows exist).
 */
export function withNullSafety(field: string, notClause: Prisma.MediaItemWhereInput): Prisma.MediaItemWhereInput {
  if (isNonNullableField(field)) return notClause;
  return { OR: [{ [field]: null }, notClause] };
}

/**
 * Negate a *positive* Phase 1 predicate (e.g. `{ field: { lt: X } }`,
 * `{ field: { equals: Y } }`) for a specific field, applying NULL-safety on
 * negate. PostgreSQL's three-valued logic excludes NULL rows from both the
 * positive clause AND its NOT — but Phase 2 coerces NULL to a default value
 * (`?? ""` or `?? 0`), evaluates positive→false, then `negate ? !false : false`
 * flips to true. So Phase 2 INCLUDES NULL rows for negated positive predicates,
 * and Phase 1 must match.
 *
 * Use this in field handlers wherever the input clause is a positive predicate.
 * For clauses that are already null-safe (e.g. notEquals after withNullSafety),
 * sentinel constants (UNSATISFIABLE_WHERE, MATCH_ALL_WHERE), or relation
 * queries (which don't have NULL-row semantics), use plain `applyNegate`.
 */
export function applyNegateNullable(field: string, positiveClause: Prisma.MediaItemWhereInput, negate?: boolean): Prisma.MediaItemWhereInput {
  if (!negate) return positiveClause;
  return withNullSafety(field, { NOT: positiveClause });
}

/**
 * An always-false Prisma `WhereInput`. Used as a deliberate "this rule should
 * not match any item" sentinel — e.g. for unconfigured contains/notContains
 * rules where the values list is empty. The contradiction (id equals two
 * distinct literals) survives AND/OR composition without flipping to "match
 * everything", as would happen with `{ AND: [] }` (no constraint) or
 * `{ NOT: {} }` (NOT of match-everything).
 */
export const UNSATISFIABLE_WHERE: Prisma.MediaItemWhereInput = {
  AND: [
    { id: { equals: "__librariarr_unsatisfiable_a__" } },
    { id: { equals: "__librariarr_unsatisfiable_b__" } },
  ],
};

/**
 * An always-true Prisma `WhereInput`. Used for the semantically-correct
 * "matches every row" case — e.g. `isNotNull` on a non-nullable column.
 *
 * Empty `{}` cannot be used: evaluateGroup() at line 843 filters out empty
 * clauses, and the safety net at evaluateLifecycleRules() returns 0 when all clauses
 * collapsed to empty. A non-empty always-true predicate survives composition
 * and inverts correctly via applyNegate.
 */
export const MATCH_ALL_WHERE: Prisma.MediaItemWhereInput = {
  id: { not: "__librariarr_never_id__" },
};

/**
 * A contains/notContains/wildcard rule with no meaningful value is
 * unconfigured. Treat it as match-nothing so partially configured rules
 * can never sweep the library.
 *
 * For contains/notContains: an empty multi-select (`""`, `"|"`, whitespace-only)
 *   means no values are selected — `notContains <nothing>` would otherwise be
 *   vacuously true and match every item with a non-empty field.
 * For matchesWildcard/notMatchesWildcard: an empty pattern (`""`,
 *   whitespace-only) means no pattern was supplied. Treating it as the
 *   regex `^$` would make `notMatchesWildcard ""` match every item with a
 *   non-empty field. `*` is intentional (matches everything) and is NOT
 *   treated as unconfigured.
 */
/**
 * Run the rule-dispatcher safety guards in the canonical order:
 *
 *   1. Unconfigured contains / notContains / wildcard → match-nothing.
 *   2. Operator does not apply to the field's type → match-nothing.
 *   3. Malformed value (NaN for numerics, unparseable date, etc.) → match-nothing.
 *
 * Returns `UNSATISFIABLE_WHERE` for any guard hit; returns `null` when the
 * rule passes all guards and the dispatcher should continue to field-specific
 * routing. Each guard returns a non-`{}` clause directly so the result
 * survives composition without `applyNegate` flipping it to "match everything".
 */
export function validateRulePreamble(
  field: string,
  operator: string,
  value: string | number,
): Prisma.MediaItemWhereInput | null {
  if (isUnconfiguredContainsRule(operator, value)) return UNSATISFIABLE_WHERE;
  if (!isOperatorApplicable(operator, field)) return UNSATISFIABLE_WHERE;
  if (!isValueValidForRule(operator, value, field)) return UNSATISFIABLE_WHERE;
  return null;
}

export function isUnconfiguredContainsRule(operator: string, value: string | number): boolean {
  if (operator === "contains" || operator === "notContains") {
    return String(value).split("|").map((s) => s.trim()).filter(Boolean).length === 0;
  }
  if (operator === "matchesWildcard" || operator === "notMatchesWildcard") {
    return String(value).trim() === "";
  }
  return false;
}

// ─── Per-field WHERE-emitting handlers ───────────────────────────────────
//
// Shared by the lifecycle rule engine and the query builder. Each handler
// builds a single-rule Prisma WHERE clause for one field (or one Set of
// fields, like dates and numerics). The dispatcher in each engine selects
// the handler via FIELD_HANDLERS[field], falling back to textGenericHandler
// for unrecognized text fields.
//
// Handlers are pure: same (operator, value, field, negate) inputs always
// produce the same output. Safety guards (UNSATISFIABLE_WHERE for unknown
// operators / malformed values) are applied in the dispatcher BEFORE the
// handler runs — handlers assume valid operator/value pairs.
//
// Fields NOT covered here (kept inline in each engine's dispatcher):
//   - Stream-count fields (audioStreamCount, subtitleStreamCount) — always
//     post-filtered in Phase 2; engines skip them before the handler lookup
//   - Stream-query (sq*), cross-system, arr/seerr, series-aggregate —
//     handled at higher layers (Phase 2, group-level, enrichment)

export type FieldHandler = (
  operator: string,
  value: string | number,
  field: string,
  negate?: boolean,
) => Prisma.MediaItemWhereInput;

export const DATE_HANDLER_FIELDS = new Set(["lastPlayedAt", "addedAt", "originallyAvailableAt"]);
export const NUMERIC_HANDLER_FIELDS = new Set([
  "playCount", "videoBitrate", "audioChannels", "year",
  "videoBitDepth", "audioSamplingRate", "audioBitrate",
  "rating", "audienceRating", "ratingCount",
]);

const fileSizeHandler: FieldHandler = (operator, value, _field, negate) => {
  let clause: Prisma.MediaItemWhereInput;
  if (operator === "isNull") return applyNegate({ fileSize: null }, negate);
  if (operator === "isNotNull") return applyNegate({ fileSize: { not: null } }, negate);
  const bytesValue = BigInt(Math.round(Number(value) * MB_IN_BYTES));
  switch (operator) {
    // Positive operators on nullable BigInt: applyNegateNullable adds OR null on negate.
    case "greaterThan":
      return applyNegateNullable("fileSize", { fileSize: { gt: bytesValue } }, negate);
    case "greaterThanOrEqual":
      return applyNegateNullable("fileSize", { fileSize: { gte: bytesValue } }, negate);
    case "lessThan":
      return applyNegateNullable("fileSize", { fileSize: { lt: bytesValue } }, negate);
    case "lessThanOrEqual":
      return applyNegateNullable("fileSize", { fileSize: { lte: bytesValue } }, negate);
    case "equals":
      return applyNegateNullable("fileSize", { fileSize: bytesValue }, negate);
    case "between": {
      const [minStr, maxStr] = String(value).split(",");
      const minBytes = BigInt(Math.round(Number(minStr) * MB_IN_BYTES));
      const maxBytes = BigInt(Math.round(Number(maxStr) * MB_IN_BYTES));
      return applyNegateNullable("fileSize", { fileSize: { gte: minBytes, lte: maxBytes } }, negate);
    }
    case "notEquals":
      clause = withNullSafety("fileSize", { fileSize: { not: bytesValue } });
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
};

const durationHandler: FieldHandler = (operator, value, _field, negate) => {
  const msValue = Number(value) * DURATION_MS_PER_MIN;
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    // Positive operators on nullable column: applyNegateNullable adds OR null
    // on negate so Phase 1 NOT(positive) matches Phase 2's NULL-included result.
    case "greaterThan": return applyNegateNullable("duration", { duration: { gt: msValue } }, negate);
    case "greaterThanOrEqual": return applyNegateNullable("duration", { duration: { gte: msValue } }, negate);
    case "lessThan": return applyNegateNullable("duration", { duration: { lt: msValue } }, negate);
    case "lessThanOrEqual": return applyNegateNullable("duration", { duration: { lte: msValue } }, negate);
    case "equals": return applyNegateNullable("duration", { duration: Math.round(msValue) }, negate);
    case "between": {
      const [minStr, maxStr] = String(value).split(",");
      return applyNegateNullable("duration", { duration: { gte: Number(minStr) * DURATION_MS_PER_MIN, lte: Number(maxStr) * DURATION_MS_PER_MIN } }, negate);
    }
    // Negative (already null-safe via withNullSafety) + isNull/isNotNull
    // (explicit NULL clauses) use plain applyNegate.
    case "notEquals": clause = withNullSafety("duration", { duration: { not: Math.round(msValue) } }); break;
    case "isNull": clause = { duration: null }; break;
    case "isNotNull": clause = { duration: { not: null } }; break;
    default: return {};
  }
  return applyNegate(clause, negate);
};

const isWatchlistedHandler: FieldHandler = (operator, value, _field, negate) => {
  // Non-nullable Boolean: every row has a value. Same semantics as the
  // generic isNull/isNotNull handler above.
  if (operator === "isNull") return applyNegate(UNSATISFIABLE_WHERE, negate);
  if (operator === "isNotNull") return applyNegate(MATCH_ALL_WHERE, negate);

  const boolVal = String(value).toLowerCase() === "true";
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
      clause = { isWatchlisted: boolVal };
      break;
    case "notEquals":
      clause = { isWatchlisted: !boolVal };
      break;
    default:
      // Unknown operator on a non-nullable column — refuse to match anything
      // (UNSATISFIABLE bypasses applyNegate so even negate=true returns nothing).
      return UNSATISFIABLE_WHERE;
  }
  return applyNegate(clause, negate);
};

const dateHandler: FieldHandler = (operator, value, field, negate) => {
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    // Positive operators on nullable date column: applyNegateNullable wraps
    // with OR null on negate so Phase 1 matches Phase 2's NULL-included path.
    case "before":
      return applyNegateNullable(field, { [field]: { lt: new Date(String(value)) } }, negate);
    case "after":
      return applyNegateNullable(field, { [field]: { gt: new Date(String(value)) } }, negate);
    case "inLastDays": {
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - Number(value));
      return applyNegateNullable(field, { [field]: { gte: daysAgo } }, negate);
    }
    case "notInLastDays": {
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - Number(value));
      return applyNegateNullable(field, { [field]: { lt: daysAgo } }, negate);
    }
    case "equals": {
      const dayStart = new Date(String(value));
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      return applyNegateNullable(field, { [field]: { gte: dayStart, lt: dayEnd } }, negate);
    }
    case "between": {
      const [fromStr, toStr] = String(value).split(",");
      const endDate = new Date(toStr);
      endDate.setDate(endDate.getDate() + 1);
      return applyNegateNullable(field, { [field]: { gte: new Date(fromStr), lt: endDate } }, negate);
    }
    // Negative (already null-safe via withNullSafety).
    case "notEquals": {
      const dayStart = new Date(String(value));
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      clause = withNullSafety(field, { OR: [{ [field]: { lt: dayStart } }, { [field]: { gte: dayEnd } }] });
      break;
    }
    case "isNull":
      clause = { [field]: null };
      break;
    case "isNotNull":
      clause = { [field]: { not: null } };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
};

const numericHandler: FieldHandler = (operator, value, field, negate) => {
  const numValue = Number(value);
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    // Positive operators on nullable column: applyNegateNullable wraps with
    // OR null on negate. For non-nullable columns (playCount) the helper is
    // a no-op so behavior is unchanged.
    case "equals":
      return applyNegateNullable(field, { [field]: numValue }, negate);
    case "greaterThan":
      return applyNegateNullable(field, { [field]: { gt: numValue } }, negate);
    case "greaterThanOrEqual":
      return applyNegateNullable(field, { [field]: { gte: numValue } }, negate);
    case "lessThan":
      return applyNegateNullable(field, { [field]: { lt: numValue } }, negate);
    case "lessThanOrEqual":
      return applyNegateNullable(field, { [field]: { lte: numValue } }, negate);
    case "between": {
      const [minStr, maxStr] = String(value).split(",");
      return applyNegateNullable(field, { [field]: { gte: Number(minStr), lte: Number(maxStr) } }, negate);
    }
    // Negative (already null-safe via withNullSafety) + isNull/isNotNull
    // (explicit NULL clauses or sentinels for non-nullable columns).
    case "notEquals":
      clause = withNullSafety(field, { [field]: { not: numValue } });
      break;
    case "isNull":
      if (isNonNullableNonTextField(field)) {
        clause = UNSATISFIABLE_WHERE;
        break;
      }
      clause = { [field]: null };
      break;
    case "isNotNull":
      if (isNonNullableNonTextField(field)) {
        clause = MATCH_ALL_WHERE;
        break;
      }
      clause = { [field]: { not: null } };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
};

const resolutionHandler: FieldHandler = (operator, value, _field, negate) => {
  const strVal = String(value);
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals": {
      const dbValues = RESOLUTION_DB_VALUES[strVal];
      const positive: Prisma.MediaItemWhereInput = dbValues
        ? { resolution: { in: dbValues, mode: "insensitive" } }
        : { resolution: { equals: strVal, mode: "insensitive" } };
      return applyNegateNullable("resolution", positive, negate);
    }
    case "notEquals": {
      const dbValues = RESOLUTION_DB_VALUES[strVal];
      const notClause: Prisma.MediaItemWhereInput = dbValues
        ? { NOT: { resolution: { in: dbValues, mode: "insensitive" } } }
        : { resolution: { not: strVal, mode: "insensitive" } };
      clause = withNullSafety("resolution", notClause);
      break;
    }
    case "contains": {
      // Resolution is enumerable — `contains` is multi-select list membership.
      // Each display label maps to one or more DB values; combine them via `in`.
      const parts = strVal.split("|").filter(Boolean);
      const allDbValues = parts.flatMap((p) => RESOLUTION_DB_VALUES[p] ?? [p]);
      return applyNegateNullable("resolution", { resolution: { in: allDbValues, mode: "insensitive" } }, negate);
    }
    case "notContains": {
      const parts = strVal.split("|").filter(Boolean);
      const allDbValues = parts.flatMap((p) => RESOLUTION_DB_VALUES[p] ?? [p]);
      clause = withNullSafety("resolution", { NOT: { resolution: { in: allDbValues, mode: "insensitive" } } });
      break;
    }
    case "isNull":
      clause = { OR: [{ resolution: null }, { resolution: "" }] };
      break;
    case "isNotNull":
      clause = { AND: [{ resolution: { not: null } }, { NOT: { resolution: "" } }] };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
};

const genreLabelsHandler: FieldHandler = (operator, value, field, negate) => {
  const column = field === "labels" ? "labels" : "genres";
  const strValue = String(value);
  const parts = (operator === "contains" || operator === "notContains")
    ? strValue.split("|").filter(Boolean)
    : [strValue];
  const matchValues = parts.length > 0 ? parts : [strValue];
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
      clause = { [column]: { array_contains: strValue } };
      break;
    case "contains":
      clause = matchValues.length === 1
        ? { [column]: { array_contains: matchValues[0] } }
        : { OR: matchValues.map((v) => ({ [column]: { array_contains: v } })) };
      break;
    case "notEquals":
      // JSON column NULL needs Prisma.DbNull, not SQL null. The withNullSafety
      // helper uses `{ [col]: null }` which targets SQL NULL — for JSON arrays
      // we inline the Prisma.DbNull form directly.
      clause = {
        OR: [
          { [column]: { equals: Prisma.DbNull } },
          { NOT: { [column]: { array_contains: strValue } } },
        ],
      };
      break;
    case "notContains": {
      const notClause: Prisma.MediaItemWhereInput = matchValues.length === 1
        ? { NOT: { [column]: { array_contains: matchValues[0] } } }
        : { AND: matchValues.map((v) => ({ NOT: { [column]: { array_contains: v } } })) };
      clause = { OR: [{ [column]: { equals: Prisma.DbNull } }, notClause] };
      break;
    }
    case "isNull":
      clause = { [column]: { equals: Prisma.DbNull } };
      break;
    case "isNotNull":
      clause = { NOT: { [column]: { equals: Prisma.DbNull } } };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
};

/**
 * Fallback handler for text fields (parentTitle, albumTitle, videoProfile,
 * videoFrameRate, aspectRatio, scanType, contentRating, studio, videoCodec,
 * audioCodec, container, etc.). For enumerable fields, `contains`/`notContains`
 * are presented in the UI as multi-select dropdowns — semantics is list
 * membership, not substring search.
 *
 * The dispatcher calls this when FIELD_HANDLERS has no entry for the field.
 */
export const textGenericHandler: FieldHandler = (operator, value, field, negate) => {
  const enumerable = isEnumerableField(field);
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
      // Positive: applyNegateNullable adds OR null on negate.
      return applyNegateNullable(field, { [field]: { equals: String(value), mode: "insensitive" } }, negate);
    case "notEquals":
      clause = withNullSafety(field, { [field]: { not: String(value), mode: "insensitive" } });
      break;
    case "contains": {
      const values = String(value).split("|").filter(Boolean);
      let positive: Prisma.MediaItemWhereInput;
      if (enumerable) {
        positive = values.length === 0
          ? { [field]: { equals: String(value), mode: "insensitive" } }
          : { OR: values.map((v) => ({ [field]: { equals: v, mode: "insensitive" as const } })) };
      } else if (values.length > 1) {
        positive = { OR: values.map((v) => ({ [field]: { contains: v, mode: "insensitive" as const } })) };
      } else {
        positive = { [field]: { contains: String(value), mode: "insensitive" } };
      }
      return applyNegateNullable(field, positive, negate);
    }
    case "notContains": {
      const values = String(value).split("|").filter(Boolean);
      let notClause: Prisma.MediaItemWhereInput;
      if (enumerable) {
        notClause = values.length === 0
          ? { NOT: { [field]: { equals: String(value), mode: "insensitive" } } }
          : { AND: values.map((v) => ({ NOT: { [field]: { equals: v, mode: "insensitive" as const } } })) };
      } else if (values.length > 1) {
        notClause = { AND: values.map((v) => ({ NOT: { [field]: { contains: v, mode: "insensitive" as const } } })) };
      } else {
        notClause = { NOT: { [field]: { contains: String(value), mode: "insensitive" } } };
      }
      clause = withNullSafety(field, notClause);
      break;
    }
    case "isNull":
      // Prisma 7 rejects `{ field: null }` on non-nullable columns. Branch
      // by Prisma scalar type from field-metadata.ts:
      //   - non-nullable String: "no value" = empty string
      //   - non-nullable non-String (Int/Float/Boolean/DateTime/BigInt):
      //     column can never be null → UNSATISFIABLE (matches 0 rows).
      //     applyNegate inverts to match-all correctly when negate=true.
      //   - nullable: legacy clause covers SQL NULL OR empty string
      if (isNonNullableNonTextField(field)) {
        clause = UNSATISFIABLE_WHERE;
        break;
      }
      clause = isNonNullableTextField(field)
        ? { [field]: "" }
        : { OR: [{ [field]: null }, { [field]: "" }] };
      break;
    case "isNotNull":
      // Symmetric to isNull. Non-nullable non-String columns always have a
      // value → MATCH_ALL_WHERE (an always-true non-empty clause).
      // applyNegate(MATCH_ALL, true) correctly produces match-none.
      if (isNonNullableNonTextField(field)) {
        clause = MATCH_ALL_WHERE;
        break;
      }
      clause = isNonNullableTextField(field)
        ? { NOT: { [field]: "" } }
        : { AND: [{ [field]: { not: null } }, { NOT: { [field]: "" } }] };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
};

/**
 * hasExternalId presence check via the `externalIds` relation. The "value"
 * is the source name (TMDB, TVDB, IMDB, MUSICBRAINZ); isNotNull is an alias
 * for equals (has a row for that source) and isNull is an alias for
 * notEquals (no row for that source).
 */
const hasExternalIdHandler: FieldHandler = (operator, value, _field, negate) => {
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
    case "isNotNull":
      clause = { externalIds: { some: { source: String(value) } } };
      break;
    case "notEquals":
    case "isNull":
      clause = { externalIds: { none: { source: String(value) } } };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
};

/**
 * Stream relation handler for audioLanguage, subtitleLanguage, and
 * streamAudioCodec — fields backed by the `streams` Prisma relation.
 * Wildcard operators (matchesWildcard, notMatchesWildcard) return `{}`
 * unchanged so Phase 2 can do the regex match in-memory.
 *
 * For language fields the handler excludes streams whose language is
 * NULL / "" / "Unknown" via `knownLangFilter`; the database stores those
 * placeholders but the rule UI treats them as no value. Codec fields
 * don't carry that placeholder set, so the filter is empty.
 */
const streamRelationHandler: FieldHandler = (operator, value, field, negate) => {
  if (operator === "matchesWildcard" || operator === "notMatchesWildcard") return {};
  const streamType = field === "subtitleLanguage" ? 3 : 2;
  const streamField = field === "streamAudioCodec" ? "codec" : "language";
  const isLangField = field === "audioLanguage" || field === "subtitleLanguage";
  const knownLangFilter = isLangField
    ? { language: { not: null, notIn: ["", "Unknown"] } }
    : {};
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
      clause = { streams: { some: { streamType, ...knownLangFilter, [streamField]: { equals: String(value), mode: "insensitive" } } } };
      break;
    case "notEquals":
      clause = { NOT: { streams: { some: { streamType, ...knownLangFilter, [streamField]: { equals: String(value), mode: "insensitive" } } } } };
      break;
    case "contains": {
      // Stream language/codec fields are enumerable — `contains` is multi-select
      // list membership, not substring search.
      const parts = String(value).split("|").filter(Boolean);
      const matchValues = parts.length > 0 ? parts : [String(value)];
      clause = { OR: matchValues.map((v) => ({ streams: { some: { streamType, ...knownLangFilter, [streamField]: { equals: v, mode: "insensitive" as const } } } })) };
      break;
    }
    case "notContains": {
      const parts = String(value).split("|").filter(Boolean);
      const matchValues = parts.length > 0 ? parts : [String(value)];
      clause = { AND: matchValues.map((v) => ({ NOT: { streams: { some: { streamType, ...knownLangFilter, [streamField]: { equals: v, mode: "insensitive" as const } } } } })) };
      break;
    }
    case "isNull": {
      // "Is Empty" — no stream of this type has a known value
      const hasValueFilter = isLangField
        ? knownLangFilter
        : { [streamField]: { not: null } };
      clause = { NOT: { streams: { some: { streamType, ...hasValueFilter } } } };
      break;
    }
    case "isNotNull": {
      // "Is Not Empty" — at least one stream of this type has a known value
      const hasValueFilter = isLangField
        ? knownLangFilter
        : { [streamField]: { not: null } };
      clause = { streams: { some: { streamType, ...hasValueFilter } } };
      break;
    }
    default:
      return {};
  }
  return applyNegate(clause, negate);
};

/**
 * WatchHistory relation handler for `watchedByUser`. Translates rules like
 * `watchedByUser equals "alice"` or `watchedByUser contains "alice|bob"` into
 * Prisma `watchHistory: { some/none: { serverUsername: ... } }` filters.
 *
 * The username comparison is case-insensitive (mirrors Phase 2 in-memory
 * evaluation) and is matched against `WatchHistory.serverUsername`, which
 * stores the per-server (Plex/Jellyfin/Emby) username that played the item.
 * "Any play by that user" semantics — a single matching row satisfies the
 * positive predicate.
 */
const watchedByUserHandler: FieldHandler = (operator, value, _field, negate) => {
  // Wildcard operators defer to Phase 2 — Prisma can't express regex against
  // a relation column, and `hasWildcardRules` already triggers in-memory re-eval.
  if (operator === "matchesWildcard" || operator === "notMatchesWildcard") return {};
  const strVal = String(value);
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
      clause = { watchHistory: { some: { serverUsername: { equals: strVal, mode: "insensitive" } } } };
      break;
    case "notEquals":
      clause = { watchHistory: { none: { serverUsername: { equals: strVal, mode: "insensitive" } } } };
      break;
    case "contains": {
      // Enumerable multi-select — exact list membership against any user.
      const parts = strVal.split("|").filter(Boolean);
      const matchValues = parts.length > 0 ? parts : [strVal];
      clause = { watchHistory: { some: { serverUsername: { in: matchValues, mode: "insensitive" } } } };
      break;
    }
    case "notContains": {
      const parts = strVal.split("|").filter(Boolean);
      const matchValues = parts.length > 0 ? parts : [strVal];
      clause = { watchHistory: { none: { serverUsername: { in: matchValues, mode: "insensitive" } } } };
      break;
    }
    case "isNull":
      clause = { watchHistory: { none: {} } };
      break;
    case "isNotNull":
      clause = { watchHistory: { some: {} } };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
};

/**
 * Map of field name → handler. The dispatcher in each engine looks up the
 * handler here; misses fall back to `textGenericHandler`. Date and numeric
 * field sets are expanded so every member field maps to the same handler.
 */
export const FIELD_HANDLERS: Record<string, FieldHandler> = (() => {
  const handlers: Record<string, FieldHandler> = {
    fileSize: fileSizeHandler,
    duration: durationHandler,
    isWatchlisted: isWatchlistedHandler,
    resolution: resolutionHandler,
    genre: genreLabelsHandler,
    labels: genreLabelsHandler,
    hasExternalId: hasExternalIdHandler,
    audioLanguage: streamRelationHandler,
    subtitleLanguage: streamRelationHandler,
    streamAudioCodec: streamRelationHandler,
    watchedByUser: watchedByUserHandler,
  };
  for (const f of DATE_HANDLER_FIELDS) handlers[f] = dateHandler;
  for (const f of NUMERIC_HANDLER_FIELDS) handlers[f] = numericHandler;
  return handlers;
})();
