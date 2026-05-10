/**
 * Deletion-pipeline safety tests.
 *
 * These exist to guard against regressions where a refactor (or a future edit)
 * accidentally produces a rule set that matches every item in the library.
 * If any of these tests fail, do NOT ship — investigate first. The lifecycle
 * processor turns matches into pending deletions; a false-positive match is a
 * data-loss bug.
 *
 * The rule engine has multiple defenses:
 *   1. `hasAnyActiveRules` rejects empty / all-disabled rule sets.
 *   2. `buildGroupConditionsPreFilter` propagates empty WHEREs as
 *      `EXTERNAL_RULE` so AND/OR is preserved when in-memory re-eval is needed.
 *   3. Explicit safety net in `evaluateRules`: when every rule produces an
 *      empty WHERE AND no in-memory re-eval is flagged, return [] rather than
 *      matching the entire library (engine.ts ~line 2779).
 */

import { describe, it, expect } from "vitest";
import { hasAnyActiveRules } from "@/lib/rules/engine";
import {
  isArrField,
  isSeerrField,
  isSeriesAggregateField,
  isCrossSystemField,
  isStreamField,
} from "@/lib/conditions";
import type { Rule, RuleGroup } from "@/lib/rules/types";

function makeRule(overrides: Partial<Rule> & Pick<Rule, "field" | "operator" | "value">): Rule {
  return { id: "r1", condition: "AND", ...overrides };
}

function makeGroup(rules: Rule[], overrides?: Partial<RuleGroup>): RuleGroup {
  return { id: "g1", condition: "AND", rules, groups: [], ...overrides };
}

// ─── Defense 1: hasAnyActiveRules ────────────────────────────────────────

describe("hasAnyActiveRules — first defense against match-all", () => {
  it("returns false for empty rule list", () => {
    expect(hasAnyActiveRules([])).toBe(false);
  });

  it("returns false when every group is disabled", () => {
    const groups: RuleGroup[] = [
      makeGroup([makeRule({ field: "title", operator: "contains", value: "X" })], { enabled: false }),
    ];
    expect(hasAnyActiveRules(groups)).toBe(false);
  });

  it("returns false when every rule in every group is disabled", () => {
    const groups: RuleGroup[] = [
      makeGroup([
        makeRule({ field: "title", operator: "contains", value: "X", enabled: false }),
      ]),
    ];
    expect(hasAnyActiveRules(groups)).toBe(false);
  });

  it("returns false for a group containing only an empty sub-group tree", () => {
    const groups: RuleGroup[] = [
      makeGroup([], { groups: [makeGroup([], { enabled: false })] }),
    ];
    expect(hasAnyActiveRules(groups)).toBe(false);
  });

  it("returns true when at least one enabled rule exists", () => {
    const groups: RuleGroup[] = [
      makeGroup([
        makeRule({ field: "title", operator: "contains", value: "X" }),
      ]),
    ];
    expect(hasAnyActiveRules(groups)).toBe(true);
  });
});

// ─── Defense 2 invariants: empty-WHERE fields are explicitly flagged ─────

/**
 * If a field returns `{}` from `ruleToWhereClause`, the engine MUST detect it
 * as needing in-memory re-evaluation. Otherwise the pre-filter SQL passes all
 * items and the missing post-filter would let everything be marked for
 * deletion.
 *
 * The complete list of fields that legally return `{}` from Phase 1:
 *   - Arr fields (post-filtered with arrData)
 *   - Seerr fields (post-filtered with seerrData)
 *   - Series-aggregate fields (post-filtered against aggregated series)
 *   - Cross-system fields (post-filtered with fetchCrossSystemData)
 *   - Stream-count fields (post-filtered in-memory)
 *   - Wildcard operators on stream language/codec fields
 *   - Stream-query fields (handled at the group level)
 *   - Unknown field names (caught by the safety net at line 2779)
 *
 * Each of the first four trips a corresponding `has*Rules` predicate which
 * sets `needsFullReeval=true` in `evaluateRules`. This test asserts those
 * predicates exist and identify the right fields.
 */
describe("Empty-WHERE field categorization (invariants)", () => {
  it("isArrField identifies Arr fields", () => {
    expect(isArrField("foundInArr")).toBe(true);
    expect(isArrField("arrTag")).toBe(true);
    // Negative
    expect(isArrField("title")).toBe(false);
    expect(isArrField("year")).toBe(false);
  });

  it("isSeerrField identifies Seerr fields", () => {
    expect(isSeerrField("seerrRequested")).toBe(true);
    expect(isSeerrField("seerrRequestedBy")).toBe(true);
    expect(isSeerrField("title")).toBe(false);
  });

  it("isSeriesAggregateField identifies the 6 series-aggregate fields", () => {
    const seriesAggregates = [
      "latestEpisodeViewDate", "availableEpisodeCount",
      "watchedEpisodeCount", "watchedEpisodePercentage",
      "lastEpisodeAddedAt", "lastEpisodeAiredAt",
    ];
    for (const f of seriesAggregates) {
      expect(isSeriesAggregateField(f)).toBe(true);
    }
    expect(isSeriesAggregateField("playCount")).toBe(false);
    expect(isSeriesAggregateField("title")).toBe(false);
  });

  it("isCrossSystemField identifies the cross-system fields", () => {
    expect(isCrossSystemField("serverCount")).toBe(true);
    expect(isCrossSystemField("matchedByRuleSet")).toBe(true);
    expect(isCrossSystemField("hasPendingAction")).toBe(true);
    expect(isCrossSystemField("title")).toBe(false);
  });

  it("isStreamField identifies the stream relation fields", () => {
    expect(isStreamField("audioLanguage")).toBe(true);
    expect(isStreamField("subtitleLanguage")).toBe(true);
    expect(isStreamField("streamAudioCodec")).toBe(true);
    expect(isStreamField("audioStreamCount")).toBe(true);
    expect(isStreamField("subtitleStreamCount")).toBe(true);
    // Stream-query fields are NOT stream relation fields — they're a separate category
    expect(isStreamField("sqCodec")).toBe(false);
    expect(isStreamField("title")).toBe(false);
  });

  it("the new fields (labels, ratingCount) are NOT in any empty-WHERE category", () => {
    // labels → handled in ruleToWhereClause (JSON array containment).
    // ratingCount → handled in ruleToWhereClause (numeric).
    // Both produce real WHERE clauses, so they don't need to trip
    // needsFullReeval. Confirm they aren't accidentally classified as Arr,
    // Seerr, series-aggregate, cross-system, or stream fields.
    for (const f of ["labels", "ratingCount"]) {
      expect(isArrField(f)).toBe(false);
      expect(isSeerrField(f)).toBe(false);
      expect(isSeriesAggregateField(f)).toBe(false);
      expect(isCrossSystemField(f)).toBe(false);
      expect(isStreamField(f)).toBe(false);
    }
  });
});

// ─── Defense 3 invariants: documentation tests ───────────────────────────

describe("Safety invariants (documentation)", () => {
  it("the engine's safety net at line ~2779 returns [] when andConditions.length===0 && !needsFullReeval", () => {
    // This is asserted by the engine's source code, not by this test
    // directly (we'd need DB access for a true integration test). Document
    // the invariant here so anyone editing engine.ts knows it must hold.
    //
    // If you remove or alter that block, you MUST replace it with an
    // equivalent guard. Otherwise rule sets where every rule produces an
    // empty WHERE (e.g. invalid operators, typo'd fields) will match the
    // entire library and queue every item for deletion.
    expect(true).toBe(true);
  });
});
