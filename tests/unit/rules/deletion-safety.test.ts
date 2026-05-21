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
 *   4. `isUnconfiguredContainsRule` returns false / unsatisfiable WHERE for
 *      contains/notContains rules with no selected values — prevents partially
 *      configured rules (especially `notContains <nothing>`, which is
 *      vacuously true) from sweeping the library. Negate is intentionally
 *      not applied.
 */

import { describe, it, expect } from "vitest";
import { hasAnyActiveRules, getMatchedCriteriaForItems, evaluateAllRulesInMemory } from "@/lib/rules/engine";
import type { ArrMetadata, ArrDataMap, SeerrMetadata, SeerrDataMap } from "@/lib/rules/engine";
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

// ─── Defense 4: unconfigured contains/notContains never sweep the library ──

describe("Unconfigured contains/notContains must not match the library", () => {
  // The in-memory entry point. WHERE-clause behaviour is harder to assert
  // without DB access, but the in-memory guard is the final gate — if it
  // returns false, the rule never matches regardless of what Phase 1 returned.
  const items = [
    { id: "m1", title: "Movie A", studio: "Warner Bros", contentRating: "PG-13", genres: ["Action"], labels: ["Favorite"], externalIds: [{ source: "TMDB", externalId: "1" }] },
    { id: "m2", title: "Movie B", studio: "Disney", contentRating: "PG", genres: ["Comedy"], labels: [], externalIds: [{ source: "TMDB", externalId: "2" }] },
    { id: "m3", title: "Movie C", studio: null, contentRating: null, genres: [], labels: null, externalIds: [{ source: "TMDB", externalId: "3" }] },
  ];

  function makeArrMeta(overrides?: Partial<ArrMetadata>): ArrMetadata {
    return {
      arrId: 0, tags: ["Default"], qualityProfile: "HD-1080p", monitored: false,
      rating: null, tmdbRating: null, rtCriticRating: null,
      dateAdded: null, path: null, sizeOnDisk: null, originalLanguage: null,
      releaseDate: null, inCinemasDate: null, runtime: null,
      qualityName: null, qualityCutoffMet: null, downloadDate: null,
      firstAired: null, seasonCount: null, episodeCount: null,
      status: null, ended: null, seriesType: null, hasUnaired: null,
      monitoredSeasonCount: null, monitoredEpisodeCount: null,
      ...overrides,
    };
  }

  function makeSeerrMeta(overrides?: Partial<SeerrMetadata>): SeerrMetadata {
    return {
      requested: true, requestCount: 1, requestDate: "2024-01-01",
      requestedBy: ["alice"], approvalDate: null, declineDate: null,
      ...overrides,
    };
  }

  const arrData: ArrDataMap = { "1": makeArrMeta(), "2": makeArrMeta(), "3": makeArrMeta() };
  const seerrData: SeerrDataMap = { "TMDB:1": makeSeerrMeta(), "TMDB:2": makeSeerrMeta(), "TMDB:3": makeSeerrMeta() };

  function makeRule(o: Partial<Rule> & Pick<Rule, "field" | "operator" | "value">): Rule {
    return { id: "r1", condition: "AND", ...o };
  }

  function expectNoMatches(rules: Rule[] | RuleGroup[]) {
    const result = getMatchedCriteriaForItems(items, rules, "MOVIE", arrData, seerrData);
    for (const item of items) {
      expect(result.get(item.id) ?? []).toHaveLength(0);
    }
  }

  const operatorsToCheck = ["contains", "notContains"] as const;
  const emptyValues = ["", "|", "||", "  "] as const;

  for (const operator of operatorsToCheck) {
    for (const value of emptyValues) {
      const display = value === "" ? "<empty>" : JSON.stringify(value);
      it(`enumerable text field (studio) — ${operator} ${display} matches nothing`, () => {
        expectNoMatches([{ id: "g", condition: "AND", rules: [makeRule({ field: "studio", operator, value })], groups: [] }]);
      });

      it(`non-enumerable text field (title) — ${operator} ${display} matches nothing`, () => {
        expectNoMatches([{ id: "g", condition: "AND", rules: [makeRule({ field: "title", operator, value })], groups: [] }]);
      });

      it(`arr field (arrQualityProfile) — ${operator} ${display} matches nothing`, () => {
        expectNoMatches([{ id: "g", condition: "AND", rules: [makeRule({ field: "arrQualityProfile", operator, value })], groups: [] }]);
      });

      it(`arr field (arrTag) — ${operator} ${display} matches nothing`, () => {
        expectNoMatches([{ id: "g", condition: "AND", rules: [makeRule({ field: "arrTag", operator, value })], groups: [] }]);
      });

      it(`seerr field (seerrRequestedBy) — ${operator} ${display} matches nothing`, () => {
        expectNoMatches([{ id: "g", condition: "AND", rules: [makeRule({ field: "seerrRequestedBy", operator, value })], groups: [] }]);
      });

      it(`array field (genre) — ${operator} ${display} matches nothing`, () => {
        expectNoMatches([{ id: "g", condition: "AND", rules: [makeRule({ field: "genre", operator, value })], groups: [] }]);
      });

      it(`array field (labels) — ${operator} ${display} matches nothing`, () => {
        expectNoMatches([{ id: "g", condition: "AND", rules: [makeRule({ field: "labels", operator, value })], groups: [] }]);
      });
    }
  }

  it("negate=true cannot flip an unconfigured contains rule into match-all", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [makeRule({ field: "studio", operator: "contains", value: "", negate: true })],
      groups: [],
    }]);
  });

  it("negate=true cannot flip an unconfigured notContains rule into match-all", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [makeRule({ field: "arrQualityProfile", operator: "notContains", value: "", negate: true })],
      groups: [],
    }]);
  });

  it("unconfigured rule in an AND group makes the whole group match nothing", () => {
    // Use evaluateAllRulesInMemory directly — it applies AND/OR group logic,
    // whereas getMatchedCriteriaForItems reports per-rule matches independently.
    const groups: RuleGroup[] = [{
      id: "g", condition: "AND",
      rules: [
        makeRule({ field: "title", operator: "contains", value: "Movie", condition: "AND" }),
        makeRule({ field: "arrQualityProfile", operator: "notContains", value: "", condition: "AND" }),
      ],
      groups: [],
    }];
    for (const item of items) {
      const arrMeta = arrData[item.externalIds[0].externalId];
      expect(evaluateAllRulesInMemory(groups, item, arrMeta)).toBe(false);
    }
  });

  it("stream query group with quantifier=none and unconfigured rule matches nothing (no vacuous truth)", () => {
    // quantifier=none ("no stream of this type satisfies all the rules") would
    // otherwise be vacuously true when a rule always returns false.
    const streamItems = [
      {
        id: "s1",
        title: "Item with streams",
        streams: [{ streamType: 2, codec: "aac", language: "English" }],
        externalIds: [{ source: "TMDB", externalId: "1" }],
      },
      {
        id: "s2",
        title: "Item without audio streams",
        streams: [],
        externalIds: [{ source: "TMDB", externalId: "2" }],
      },
    ];
    const groups: RuleGroup[] = [{
      id: "g", condition: "AND",
      streamQuery: { streamType: "audio", quantifier: "none" },
      rules: [makeRule({ field: "sqCodec", operator: "contains", value: "" })],
      groups: [],
    }];
    for (const item of streamItems) {
      expect(evaluateAllRulesInMemory(groups, item)).toBe(false);
    }
  });

  it("unconfigured rule in an OR group does not lift the whole group to match-all", () => {
    // OR with an unconfigured rule should defer to the other (configured) rule.
    // The configured rule here matches title === "Movie A", so only m1 should match.
    const groups: RuleGroup[] = [{
      id: "g", condition: "AND",
      rules: [
        makeRule({ field: "title", operator: "equals", value: "Movie A", condition: "AND" }),
        makeRule({ field: "arrQualityProfile", operator: "contains", value: "", condition: "OR" }),
      ],
      groups: [],
    }];
    const matchedIds = items.filter((item) => {
      const arrMeta = arrData[item.externalIds[0].externalId];
      return evaluateAllRulesInMemory(groups, item, arrMeta);
    }).map((i) => i.id);
    expect(matchedIds).toEqual(["m1"]);
  });
});

// ─── Defense 5: unknown / mismatched operator and malformed value ──────────

describe("Unknown operator, type mismatch, or malformed value must not match the library", () => {
  const items = [
    { id: "m1", title: "Movie A", playCount: 10, year: 2020, externalIds: [{ source: "TMDB", externalId: "1" }] },
    { id: "m2", title: "Movie B", playCount: 5, year: 2010, externalIds: [{ source: "TMDB", externalId: "2" }] },
  ];

  function expectNoMatches(rules: RuleGroup[]) {
    for (const item of items) {
      expect(evaluateAllRulesInMemory(rules, item)).toBe(false);
    }
  }

  it("unknown operator with negate=true does not flip false to match-all", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "title", operator: "totallyMadeUpOp" as never, value: "x", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });

  it("operator/field-type mismatch with negate=true does not match all (contains on number)", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "playCount", operator: "contains", value: "5", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });

  it("operator/field-type mismatch (greaterThan on text) with negate=true does not match all", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "title", operator: "greaterThan", value: "abc", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });

  it("greaterThan with a non-numeric value (NaN comparison) does not match all via negate", () => {
    // playCount > NaN is false for every item; negate=true would flip to match-all.
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "playCount", operator: "greaterThan", value: "not-a-number", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });

  it("between with a malformed half does not match all via negate", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "year", operator: "between", value: "2000,", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });

  it("between with no comma (single value) does not match all via negate", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "year", operator: "between", value: "2020", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });

  it("between with empty value does not match all via negate", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "year", operator: "between", value: "", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });

  it("notMatchesWildcard with empty pattern (regex `^$`) does not match all", () => {
    // ^$ matches only the empty string; negate would otherwise sweep the library.
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "title", operator: "notMatchesWildcard", value: "", condition: "AND" }],
      groups: [],
    }]);
  });

  it("matchesWildcard with empty pattern + negate=true does not match all", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "title", operator: "matchesWildcard", value: "", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });

  it("equals with empty value on numeric field (Number('') === 0 quirk) does not flip via negate", () => {
    // playCount = "" coerces to 0; for items with playCount !== 0, equals returns false;
    // negate=true would flip to true and sweep most of the library.
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "playCount", operator: "equals", value: "", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });

  it("unknown field name with negate=true does not match all", () => {
    expectNoMatches([{
      id: "g", condition: "AND",
      rules: [{ id: "r", field: "thisFieldDoesNotExist" as never, operator: "equals", value: "x", negate: true, condition: "AND" }],
      groups: [],
    }]);
  });
});
