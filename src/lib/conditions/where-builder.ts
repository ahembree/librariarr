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
import { isNonNullableField } from "./field-metadata";

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
 * clauses, and the safety net at evaluateRules() returns 0 when all clauses
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
export function isUnconfiguredContainsRule(operator: string, value: string | number): boolean {
  if (operator === "contains" || operator === "notContains") {
    return String(value).split("|").map((s) => s.trim()).filter(Boolean).length === 0;
  }
  if (operator === "matchesWildcard" || operator === "notMatchesWildcard") {
    return String(value).trim() === "";
  }
  return false;
}
