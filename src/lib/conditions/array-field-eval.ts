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
 * This is the ONLY evaluation of these fields. Prisma's `array_contains` is
 * case-sensitive with no insensitive form, so Phase 1 disagreed with everything
 * above for any value whose case differed from the stored tag — and
 * `notContains` / `notEquals` disagreed by matching EVERY row in SQL. So
 * `genreLabelsHandler` now returns `{}` for all operators and
 * `hasArrayFieldRules` forces this phase in both engines, exactly as
 * `resolution` is handled and for the same reason.
 *
 * A null / undefined / non-array value normalizes to "no assignments" (`[]`),
 * so `isNull` is true for a NULL column AND for a stored empty array — never
 * throwing on aggregated-series items, which omit the column entirely. Phase 1
 * could only ask about `Prisma.DbNull` and so read a stored `[]` as "not
 * empty"; routing the field here settles that too.
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
