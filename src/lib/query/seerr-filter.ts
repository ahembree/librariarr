/**
 * Phase 2 (in-memory) Seerr rule evaluation for the query builder.
 *
 * Delegates to the single canonical implementation in the rule engine — the
 * query copy had drifted (it was missing `seerrRequestCount between`, date
 * `notEquals`/`between`, and ordered date `isNull`/`isNotNull` after the
 * null-guard). Both engines now share one evaluator.
 */
export { evaluateSeerrRule as evaluateQuerySeerrRule } from "@/lib/rules/lifecycle-engine";
