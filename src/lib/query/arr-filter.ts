/**
 * Phase 2 (in-memory) Arr rule evaluation for the query builder.
 *
 * The query builder and the lifecycle rule engine evaluate Arr rules against
 * the same `ArrMetadata` with identical field/operator semantics. To prevent
 * the two from drifting (the query copy had previously gone stale on
 * isNull/isNotNull fail-opens), both now delegate to the single canonical
 * implementation in the rule engine.
 */
export { evaluateArrRule as evaluateQueryArrRule } from "@/lib/rules/lifecycle-engine";
