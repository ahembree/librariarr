import { wildcardToRegex } from "./wildcard";

/**
 * Phase-2 (in-memory) evaluation for JSON-array fields — `genre`, `labels`,
 * `country`. SHARED by the lifecycle rule engine and the query engine so their
 * in-memory results can't drift; this is the same parity contract the rest of
 * `conditions/` exists to protect (the two engines previously carried separate
 * inline copies that disagreed on case-sensitivity).
 *
 * Returns the PRE-negate result for a known operator, or `null` for an unknown
 * operator (the caller must then match nothing WITHOUT applying `negate` — a
 * `default: false` fed through `negate` would fail open to match-all). Callers
 * apply `negate` to a non-null result themselves.
 *
 * Case-sensitivity: ALL operators are case-INsensitive. This is the deliberate,
 * regression-tested behavior (see "Bug 5: genre case sensitivity in-memory" in
 * tests/unit/rules/bug-regression.test.ts) and matches how scalar text fields
 * compare (`mode: "insensitive"` in Phase 1, lowercased in Phase 2). The query
 * engine previously compared these fields case-SENSITIVELY here, so the same
 * rule matched different items in each engine — this shared implementation
 * removes that drift.
 *
 * (The Phase 1 SQL `array_contains` is case-sensitive and Prisma cannot express
 * it otherwise, so in `needsInMemoryEval` pre-filter mode it is only a true
 * superset of this post-filter for consistently-cased data — which is what
 * Plex/Jellyfin emit. That residual is pre-existing and identical across both
 * engines; fixing it would mean routing these fields fully through Phase 2 like
 * `resolution`, at a performance cost.)
 *
 * A null / undefined / non-array value normalizes to "no assignments" (`[]`),
 * matching Phase 1's `Prisma.DbNull` semantics — and never throwing on
 * aggregated-series items, which omit the column entirely.
 *
 * `contains` / `notContains` treat a pipe-separated value as multi-select list
 * membership ("any selected value is present"), matching the enumerable dropdown.
 */
export function matchArrayField(
  value: unknown,
  operator: string,
  ruleValue: string,
): boolean | null {
  const list = Array.isArray(value) ? value.map((v) => String(v).toLowerCase()) : [];
  const rv = ruleValue.toLowerCase();
  switch (operator) {
    case "equals":
      return list.includes(rv);
    case "notEquals":
      return !list.includes(rv);
    case "contains": {
      const parts = rv.split("|").filter(Boolean);
      const matchValues = parts.length > 0 ? parts : [rv];
      return matchValues.some((v) => list.includes(v));
    }
    case "notContains": {
      const parts = rv.split("|").filter(Boolean);
      const matchValues = parts.length > 0 ? parts : [rv];
      return !matchValues.some((v) => list.includes(v));
    }
    case "matchesWildcard": {
      const re = wildcardToRegex(rv);
      return list.some((v) => re.test(v));
    }
    case "notMatchesWildcard": {
      const re = wildcardToRegex(rv);
      return !list.some((v) => re.test(v));
    }
    case "isNull":
      return list.length === 0;
    case "isNotNull":
      return list.length > 0;
    default:
      // Unknown operator → signal "match nothing" so the caller bypasses negate.
      return null;
  }
}
