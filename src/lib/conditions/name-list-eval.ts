import { wildcardToRegex } from "./wildcard";

/**
 * Phase-2 (in-memory) evaluation for the NAME-LIST fields — `arrTag`,
 * `seerrRequestedBy`, `watchedByUser`, `matchedByRuleSet`. Each holds an
 * always-present list of names (tags, requester usernames, viewer usernames,
 * rule-set names), and every operator asks a question about that list.
 *
 * SHARED by the lifecycle rule engine and the query engine, for the same reason
 * `array-field-eval.ts` and `external-id-eval.ts` exist: the four fields
 * previously carried four hand-written operator switches (two of them
 * duplicated byte-for-byte across both engines), and they drifted.
 * `matchedByRuleSet` and `seerrRequestedBy` were missing `matchesWildcard` /
 * `notMatchesWildcard` entirely while `arrTag` and `watchedByUser` had them —
 * the rule and query builders offer the operators on all four (they are text
 * fields), so those two rules fell through to the `default` and matched
 * NOTHING, in both directions and with no error. "Requested By does not match
 * *service-account*" silently returned an empty set instead of nearly the whole
 * library.
 *
 * Returns the PRE-negate result for a known operator, or `null` for an unknown
 * one (the caller must then match nothing WITHOUT applying `negate` — a
 * `default: false` fed through `negate` would fail open to match-all). Callers
 * apply `negate` to a non-null result themselves.
 *
 * Case-sensitivity: ALL operators are case-INsensitive, matching
 * `matchArrayField` and the scalar-text convention. Both sides are lowercased;
 * `wildcardToRegex` is independently case-insensitive.
 *
 * `contains` / `notContains` treat a pipe-separated value as multi-select list
 * membership ("any selected value is present"), matching the enumerable
 * dropdown — not substring search. `isNull` / `isNotNull` are VALUELESS
 * operators (the builder clears the value) and therefore ask about list
 * emptiness: "carries no tags / no requesters / no viewers / matched by no rule
 * set".
 *
 * A null / undefined / non-array value normalizes to the empty list, so an item
 * the caller never enriched reads as "no names" rather than throwing.
 */
export function matchNameListField(
  names: unknown,
  operator: string,
  ruleValue: string | number,
): boolean | null {
  const list = Array.isArray(names) ? names.map((n) => String(n ?? "").toLowerCase()) : [];
  const rv = String(ruleValue).toLowerCase();
  switch (operator) {
    case "equals":
      return list.includes(rv);
    case "notEquals":
      return !list.includes(rv);
    case "contains": {
      const values = rv.split("|").filter(Boolean);
      return values.some((v) => list.includes(v));
    }
    case "notContains": {
      const values = rv.split("|").filter(Boolean);
      return !values.some((v) => list.includes(v));
    }
    case "matchesWildcard": {
      const re = wildcardToRegex(rv);
      return list.some((n) => re.test(n));
    }
    case "notMatchesWildcard": {
      const re = wildcardToRegex(rv);
      return !list.some((n) => re.test(n));
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
