/**
 * Shared condition / criterion module — single source of truth for the
 * lifecycle rule builder and the query builder.
 *
 * Both systems build nested AND/OR trees over media items. Their UI is
 * already shared via `BaseBuilder`; this module dedupes the metadata layer
 * (fields, operators, sections, helpers) and the small utilities that both
 * engines use (wildcard, resolution map, byte/duration constants).
 *
 * ─── Deletion-pipeline safety invariants ─────────────────────────────────
 *
 * The lifecycle rule engine turns rule matches into pending deletions, so a
 * false-positive match is a data-loss bug. When adding a new field to
 * `CONDITION_FIELDS`, you MUST keep these invariants intact:
 *
 *   1. Either the rule engine's `ruleToWhereClause` produces a non-empty
 *      Prisma WHERE for the field, OR the field is in one of these
 *      categories so that the engine's `evaluateLifecycleRules` knows to fall back
 *      to in-memory post-filter:
 *        - `requiresArr: true`     → caught by `hasArrRules`
 *        - `requiresSeerr: true`   → caught by `hasSeerrRules`
 *        - `isSeriesAggregate: true` → handled in `evaluateSeriesScope`
 *        - cross-system fields (serverCount/matchedByRuleSet/hasPendingAction)
 *        - stream-relation fields (audioLanguage/...) with wildcard ops
 *        - stream-query fields (sq*)
 *
 *   2. If neither is true, the engine's safety net at the bottom of
 *      `evaluateLifecycleRules` (look for "Safety net: if all rules produced empty
 *      WHERE clauses") returns `[]` rather than matching the whole library.
 *      Do not remove that block. The unit tests in
 *      `tests/unit/rules/deletion-safety.test.ts` document why.
 *
 *   3. New fields default to `availability: "both"` — they show up in both
 *      the rule builder and the query builder. Verify both engines handle
 *      the field before exposing it. A field that the rule engine can't
 *      filter is a deletion-correctness risk; a field that the query engine
 *      can't filter is just a UX bug.
 */

export * from "./types";
export * from "./fields";
export * from "./operators";
export * from "./sections";
export * from "./helpers";
export * from "./stream-query";
export * from "./constants";
export * from "./wildcard";
export * from "./series-aggregates";
export * from "./library-type-guard";
