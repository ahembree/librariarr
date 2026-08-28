import { wildcardToRegex } from "./wildcard";

/**
 * Phase-2 (in-memory) evaluation for `hasExternalId`. SHARED by the lifecycle
 * rule engine and the query engine so their results can't drift — the two
 * previously carried byte-identical inline copies, which is how the
 * isNull/isNotNull defect below came to exist in duplicate.
 *
 * Returns the PRE-negate result for a known operator, or `null` for an
 * unknown one (the caller must then match nothing WITHOUT applying `negate` —
 * a `default: false` fed through `negate` would fail open to match-all).
 *
 * Operator semantics. The value is an external-id SOURCE name (TMDB, TVDB,
 * IMDB, MUSICBRAINZ), and `equals` / `contains` / `matchesWildcard` and their
 * negations all ask a per-source question.
 *
 * `isNull` / `isNotNull` are the exception: they are VALUELESS operators —
 * the rule builder clears the value when one is selected — so they ask about
 * the id LIST, not about a source:
 *
 *   isNull    → the item has no external ids at all
 *   isNotNull → the item has at least one
 *
 * This matches every other list-shaped field (`arrTag`, `seerrRequestedBy`,
 * `watchedByUser`, `matchedByRuleSet`). They were previously aliased onto
 * `notEquals` / `equals`, which compared against the cleared value: `isNull`
 * became `no row has source ""` — true for EVERY item, so "Has External ID Is
 * Empty" matched the entire library (a destructive rule set would arm on all
 * of it), and `isNotNull` matched nothing. Phase 1 built the mirror-image
 * vacuous clause, so the two phases agreed and nothing detected the sweep.
 */
export function matchExternalIdField(
  externalIds: unknown,
  operator: string,
  ruleValue: string,
): boolean | null {
  const list = Array.isArray(externalIds)
    ? (externalIds as Array<{ source?: unknown }>).map((e) => String(e?.source ?? ""))
    : [];
  const sources = ruleValue.split("|").map((v) => v.trim()).filter(Boolean);

  switch (operator) {
    case "isNull":
      return list.length === 0;
    case "isNotNull":
      return list.length > 0;
    case "equals":
      return list.includes(ruleValue);
    case "notEquals":
      return !list.includes(ruleValue);
    case "contains":
      return list.some((s) => sources.includes(s));
    case "notContains":
      return !list.some((s) => sources.includes(s));
    case "matchesWildcard": {
      const re = wildcardToRegex(ruleValue.toLowerCase());
      return list.some((s) => re.test(s.toLowerCase()));
    }
    case "notMatchesWildcard": {
      const re = wildcardToRegex(ruleValue.toLowerCase());
      return !list.some((s) => re.test(s.toLowerCase()));
    }
    default:
      // Unknown operator → signal "match nothing" so the caller bypasses negate.
      return null;
  }
}
