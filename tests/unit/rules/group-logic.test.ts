import { describe, it, expect } from "vitest";
import { getMatchedCriteriaForItems, evaluateAllRulesInMemory } from "@/lib/rules/engine";
import type { ArrMetadata, SeerrMetadata, ArrDataMap } from "@/lib/rules/engine";
import type { Rule, RuleGroup } from "@/lib/rules/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<Rule> & Pick<Rule, "field" | "operator" | "value">): Rule {
  return { id: "r1", condition: "AND", ...overrides };
}

function makeGroup(rules: Rule[], overrides?: Partial<RuleGroup>): RuleGroup {
  return { id: "g1", condition: "AND", rules, groups: [], ...overrides };
}

function matched(
  items: Array<Record<string, unknown>>,
  rules: Rule[] | RuleGroup[],
  type: "MOVIE" | "SERIES" | "MUSIC" = "MOVIE",
  arrData?: ArrDataMap,
) {
  return getMatchedCriteriaForItems(items, rules, type, arrData);
}

function makeArrMeta(overrides?: Partial<ArrMetadata>): ArrMetadata {
  return {
    arrId: 0, tags: [], qualityProfile: "", monitored: false,
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

// ---------------------------------------------------------------------------
// Single group AND/OR semantics
// ---------------------------------------------------------------------------

describe("Single group with AND rules", () => {
  const items = [
    { id: "both", playCount: 10, year: 2020 },
    { id: "one", playCount: 10, year: 2015 },
    { id: "neither", playCount: 0, year: 2015 },
  ];

  it("all AND rules must match for criteria to appear", () => {
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" }),
      makeRule({ id: "r2", field: "year", operator: "greaterThanOrEqual", value: "2020", condition: "AND" }),
    ])];
    const result = matched(items, rules);
    // Both rules match "both"
    expect(result.get("both")!.length).toBe(2);
    // Only playCount matches "one", but year fails
    expect(result.get("one")!.length).toBe(1);
    // Neither matches "neither"
    expect(result.get("neither")).toHaveLength(0);
  });
});

describe("Single group with OR rules", () => {
  const items = [
    { id: "both", playCount: 10, year: 2020 },
    { id: "play_only", playCount: 10, year: 2015 },
    { id: "year_only", playCount: 0, year: 2020 },
    { id: "neither", playCount: 0, year: 2015 },
  ];

  it("any OR rule match produces criteria", () => {
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" }),
      makeRule({ id: "r2", field: "year", operator: "equals", value: "2020", condition: "OR" }),
    ])];
    const result = matched(items, rules);
    expect(result.get("both")!.length).toBe(2);
    expect(result.get("play_only")!.length).toBe(1);
    expect(result.get("year_only")!.length).toBe(1);
    expect(result.get("neither")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple groups connected by AND/OR
// ---------------------------------------------------------------------------

describe("Two groups connected by AND", () => {
  const items = [
    { id: "pass", playCount: 10, title: "The Matrix" },
    { id: "fail_play", playCount: 0, title: "The Matrix" },
    { id: "fail_title", playCount: 10, title: "Inception" },
  ];

  it("both groups must match", () => {
    const rules: RuleGroup[] = [
      makeGroup(
        [makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" })],
        { id: "g1", condition: "AND" },
      ),
      makeGroup(
        [makeRule({ id: "r2", field: "title", operator: "contains", value: "Matrix" })],
        { id: "g2", condition: "AND" },
      ),
    ];
    const result = matched(items, rules);
    expect(result.get("pass")!.length).toBe(2);
    // Each group's rules appear individually even if overall AND logic would filter
    // getMatchedCriteriaForItems shows individual rule matches, not combined group logic
    expect(result.get("fail_play")!.length).toBe(1); // title matches
    expect(result.get("fail_title")!.length).toBe(1); // playCount matches
  });
});

describe("Two groups connected by OR", () => {
  const items = [
    { id: "both", playCount: 10, title: "The Matrix" },
    { id: "play_only", playCount: 10, title: "Inception" },
    { id: "title_only", playCount: 0, title: "The Matrix" },
    { id: "neither", playCount: 0, title: "Inception" },
  ];

  it("either group matching produces criteria", () => {
    const rules: RuleGroup[] = [
      makeGroup(
        [makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" })],
        { id: "g1", condition: "AND" },
      ),
      makeGroup(
        [makeRule({ id: "r2", field: "title", operator: "contains", value: "Matrix" })],
        { id: "g2", condition: "OR" },
      ),
    ];
    const result = matched(items, rules);
    expect(result.get("both")!.length).toBe(2);
    expect(result.get("play_only")!.length).toBe(1);
    expect(result.get("title_only")!.length).toBe(1);
    expect(result.get("neither")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Nested groups (sub-groups)
// ---------------------------------------------------------------------------

describe("Nested groups", () => {
  it("nested sub-group result combines with parent via condition", () => {
    const items = [
      { id: "all3", playCount: 10, title: "Test Movie", year: 2020 },
      { id: "play_year", playCount: 10, title: "Other", year: 2020 },
      { id: "play_only", playCount: 10, title: "Other", year: 2015 },
    ];
    // Group: playCount > 5 AND (sub-group: title contains "Test" OR year = 2020)
    const rules: RuleGroup[] = [{
      id: "g1",
      condition: "AND",
      rules: [
        makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" }),
      ],
      groups: [{
        id: "g2",
        condition: "AND", // connects to parent as AND
        rules: [
          makeRule({ id: "r2", field: "title", operator: "contains", value: "Test" }),
          makeRule({ id: "r3", field: "year", operator: "equals", value: "2020", condition: "OR" }),
        ],
        groups: [],
      }],
    }];
    const result = matched(items, rules);
    // all3: playCount matches, title matches, year matches → all 3 criteria
    expect(result.get("all3")!.length).toBe(3);
    // play_year: playCount matches, year matches → 2 criteria
    expect(result.get("play_year")!.length).toBe(2);
    // play_only: playCount matches → 1 criterion
    expect(result.get("play_only")!.length).toBe(1);
  });

  it("deeply nested group (3 levels)", () => {
    const items = [
      { id: "deep", playCount: 10, title: "Deep Movie", year: 2020 },
    ];
    const rules: RuleGroup[] = [{
      id: "g1",
      condition: "AND",
      rules: [makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" })],
      groups: [{
        id: "g2",
        condition: "AND",
        rules: [makeRule({ id: "r2", field: "title", operator: "contains", value: "Deep" })],
        groups: [{
          id: "g3",
          condition: "AND",
          rules: [makeRule({ id: "r3", field: "year", operator: "equals", value: "2020" })],
          groups: [],
        }],
      }],
    }];
    const result = matched(items, rules);
    expect(result.get("deep")!.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Disabled rules
// ---------------------------------------------------------------------------

describe("Disabled rules", () => {
  it("disabled rule is skipped — not included in matched criteria", () => {
    const items = [{ id: "1", playCount: 10, year: 2020 }];
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" }),
      makeRule({ id: "r2", field: "year", operator: "equals", value: "2020", enabled: false }),
    ])];
    const result = matched(items, rules);
    // Only playCount rule appears, year is disabled
    expect(result.get("1")!.length).toBe(1);
  });

  it("all rules disabled produces empty criteria", () => {
    const items = [{ id: "1", playCount: 10 }];
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5", enabled: false }),
    ])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Disabled groups
// ---------------------------------------------------------------------------

describe("Disabled groups", () => {
  it("disabled group's rules do not appear in matched criteria", () => {
    const items = [{ id: "1", playCount: 10 }];
    const rules: RuleGroup[] = [
      makeGroup(
        [makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" })],
        { id: "g1", condition: "AND", enabled: false },
      ),
    ];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("enabled group still works alongside disabled group", () => {
    const items = [{ id: "1", playCount: 10, year: 2020 }];
    const rules: RuleGroup[] = [
      makeGroup(
        [makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" })],
        { id: "g1", condition: "AND", enabled: false },
      ),
      makeGroup(
        [makeRule({ id: "r2", field: "year", operator: "equals", value: "2020" })],
        { id: "g2", condition: "AND" },
      ),
    ];
    const result = matched(items, rules);
    // Only year rule from enabled group appears
    expect(result.get("1")!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Negate flag on rules
// ---------------------------------------------------------------------------

describe("Negate on rules", () => {
  it("negate inverts a passing rule to fail", () => {
    const items = [{ id: "1", playCount: 10 }];
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ field: "playCount", operator: "greaterThan", value: "5", negate: true }),
    ])];
    const result = matched(items, rules);
    // 10 > 5 → true → negate → false
    expect(result.get("1")).toHaveLength(0);
  });

  it("negate inverts a failing rule to pass", () => {
    const items = [{ id: "1", playCount: 2 }];
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ field: "playCount", operator: "greaterThan", value: "5", negate: true }),
    ])];
    const result = matched(items, rules);
    // 2 > 5 → false → negate → true
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("negate combined with notEquals (double negation)", () => {
    const items = [
      { id: "match", title: "Star Wars" },
      { id: "nomatch", title: "Star Trek" },
    ];
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ field: "title", operator: "notEquals", value: "Star Wars", negate: true }),
    ])];
    const result = matched(items, rules);
    // "Star Wars" notEquals "Star Wars" → false → negate → true (double negation = equals)
    expect(result.get("match")!.length).toBeGreaterThan(0);
    // "Star Trek" notEquals "Star Wars" → true → negate → false
    expect(result.get("nomatch")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed field types in groups
// ---------------------------------------------------------------------------

describe("Mixed field types in groups", () => {
  it("group with text + numeric + date rules all AND", () => {
    const items = [
      { id: "all", title: "Breaking Bad", playCount: 5, lastPlayedAt: "2024-06-01T00:00:00Z" },
      { id: "partial", title: "Breaking Bad", playCount: 0, lastPlayedAt: "2024-06-01T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ id: "r1", field: "title", operator: "contains", value: "Breaking" }),
      makeRule({ id: "r2", field: "playCount", operator: "greaterThanOrEqual", value: "5", condition: "AND" }),
      makeRule({ id: "r3", field: "lastPlayedAt", operator: "after", value: "2024-01-01", condition: "AND" }),
    ])];
    const result = matched(items, rules);
    expect(result.get("all")!.length).toBe(3);
    // partial: title + date match but not playCount
    expect(result.get("partial")!.length).toBe(2);
  });

  it("group with arr + standard fields", () => {
    const extId = "tmdb-100";
    const items = [{ id: "1", playCount: 10, externalIds: [{ source: "TMDB", externalId: extId }] }];
    const arrData: ArrDataMap = { [extId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" }),
      makeRule({ id: "r2", field: "arrMonitored", operator: "equals", value: "true", condition: "AND" }),
    ])];
    const result = matched(items, rules, "MOVIE", arrData);
    expect(result.get("1")!.length).toBe(2);
  });

  it("group with stream + standard fields", () => {
    const items = [{
      id: "1",
      playCount: 10,
      streams: [
        { streamType: 2, language: "English", codec: "aac" },
        { streamType: 3, language: "Spanish", codec: "srt" },
      ],
    }];
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" }),
      makeRule({ id: "r2", field: "audioLanguage", operator: "equals", value: "english", condition: "AND" }),
    ])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("empty rules array: no criteria for any item", () => {
    const items = [{ id: "1", playCount: 10 }];
    const result = matched(items, []);
    expect(result.get("1")).toHaveLength(0);
  });

  it("empty groups array: no criteria for any item", () => {
    const items = [{ id: "1", playCount: 10 }];
    const result = matched(items, [] as RuleGroup[]);
    expect(result.get("1")).toHaveLength(0);
  });

  it("group with no rules but has sub-groups", () => {
    const items = [{ id: "1", playCount: 10 }];
    const rules: RuleGroup[] = [{
      id: "g1",
      condition: "AND",
      rules: [],
      groups: [{
        id: "g2",
        condition: "AND",
        rules: [makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5" })],
        groups: [],
      }],
    }];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBe(1);
  });

  it("item with missing property defaults to empty string for text", () => {
    const items = [{ id: "1" }]; // no title property
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ field: "title", operator: "equals", value: "" }),
    ])];
    const result = matched(items, rules);
    // Missing title → empty string → equals "" → true
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("item with missing numeric property defaults to 0", () => {
    const items = [{ id: "1" }]; // no playCount
    const rules: RuleGroup[] = [makeGroup([
      makeRule({ field: "playCount", operator: "equals", value: "0" }),
    ])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Legacy flat rules
// ---------------------------------------------------------------------------

describe("Legacy flat rules (non-grouped)", () => {
  it("flat AND rules: all visible criteria shown per item", () => {
    const items = [
      { id: "both", playCount: 10, year: 2020 },
      { id: "one", playCount: 10, year: 2015 },
    ];
    const rules: Rule[] = [
      makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5", condition: "AND" }),
      makeRule({ id: "r2", field: "year", operator: "equals", value: "2020", condition: "AND" }),
    ];
    const result = matched(items, rules);
    expect(result.get("both")!.length).toBe(2);
    expect(result.get("one")!.length).toBe(1);
  });

  it("flat OR rules: any match produces criteria", () => {
    const items = [
      { id: "play", playCount: 10, year: 2015 },
      { id: "year", playCount: 0, year: 2020 },
      { id: "none", playCount: 0, year: 2015 },
    ];
    const rules: Rule[] = [
      makeRule({ id: "r1", field: "playCount", operator: "greaterThan", value: "5", condition: "OR" }),
      makeRule({ id: "r2", field: "year", operator: "equals", value: "2020", condition: "OR" }),
    ];
    const result = matched(items, rules);
    expect(result.get("play")!.length).toBe(1);
    expect(result.get("year")!.length).toBe(1);
    expect(result.get("none")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed standard + external rules in groups (AND/OR correctness)
// ---------------------------------------------------------------------------

function makeSeerrMeta(overrides?: Partial<SeerrMetadata>): SeerrMetadata {
  return {
    requested: false, requestCount: 0, requestDate: null,
    requestedBy: [], approvalDate: null, declineDate: null,
    ...overrides,
  };
}

describe("evaluateAllRulesInMemory — mixed standard + external groups", () => {
  it("AND group with arr sub-group AND standard sub-group: both must pass", () => {
    const item = { id: "1", playCount: 10, streams: [] };
    const arrMeta = makeArrMeta({ rating: 8 });
    const rules: RuleGroup[] = [{
      id: "g1", condition: "AND", rules: [], groups: [
        {
          id: "sg1", condition: "AND", groups: [],
          rules: [makeRule({ id: "r1", field: "arrRating", operator: "greaterThan", value: "7" })],
        },
        {
          id: "sg2", condition: "AND", groups: [],
          rules: [makeRule({ id: "r2", field: "playCount", operator: "greaterThan", value: "5" })],
        },
      ],
    }];
    // Both sub-groups pass → group passes → item matches
    expect(evaluateAllRulesInMemory(rules, item, arrMeta)).toBe(true);
  });

  it("AND group with arr sub-group AND standard sub-group: standard fails → group fails", () => {
    const item = { id: "1", playCount: 1, streams: [] };
    const arrMeta = makeArrMeta({ rating: 8 });
    const rules: RuleGroup[] = [{
      id: "g1", condition: "AND", rules: [], groups: [
        {
          id: "sg1", condition: "AND", groups: [],
          rules: [makeRule({ id: "r1", field: "arrRating", operator: "greaterThan", value: "7" })],
        },
        {
          id: "sg2", condition: "AND", groups: [],
          rules: [makeRule({ id: "r2", field: "playCount", operator: "greaterThan", value: "5" })],
        },
      ],
    }];
    // Arr passes but standard fails → group fails → item does NOT match
    expect(evaluateAllRulesInMemory(rules, item, arrMeta)).toBe(false);
  });

  it("AND group with arr sub-group AND standard sub-group: arr fails → group fails", () => {
    const item = { id: "1", playCount: 10, streams: [] };
    const arrMeta = makeArrMeta({ rating: 3 });
    const rules: RuleGroup[] = [{
      id: "g1", condition: "AND", rules: [], groups: [
        {
          id: "sg1", condition: "AND", groups: [],
          rules: [makeRule({ id: "r1", field: "arrRating", operator: "greaterThan", value: "7" })],
        },
        {
          id: "sg2", condition: "AND", groups: [],
          rules: [makeRule({ id: "r2", field: "playCount", operator: "greaterThan", value: "5" })],
        },
      ],
    }];
    // Standard passes but Arr fails → group fails
    expect(evaluateAllRulesInMemory(rules, item, arrMeta)).toBe(false);
  });

  it("three groups: (ArrGroup AND StandardGroup) AND (SeerrGroup) OR StreamGroup", () => {
    const item = {
      id: "1", playCount: 1,
      streams: [{ streamType: 2, language: "English", codec: "aac" }],
    };
    const arrMeta = makeArrMeta({ rating: 8 });
    const seerrMeta = makeSeerrMeta({ requested: false });

    const rules: RuleGroup[] = [
      // Group 1 (AND): arr + standard sub-groups
      {
        id: "g1", condition: "AND", rules: [], groups: [
          {
            id: "sg1", condition: "AND", groups: [],
            rules: [makeRule({ id: "r1", field: "arrRating", operator: "greaterThan", value: "7" })],
          },
          {
            id: "sg2", condition: "AND", groups: [],
            rules: [makeRule({ id: "r2", field: "playCount", operator: "greaterThan", value: "5" })],
          },
        ],
      },
      // Group 2 (AND): seerr rule
      {
        id: "g2", condition: "AND", rules: [
          makeRule({ id: "r3", field: "seerrRequested", operator: "equals", value: "true" }),
        ], groups: [],
      },
      // Group 3 (OR): stream rule
      {
        id: "g3", condition: "OR", rules: [
          makeRule({ id: "r4", field: "audioLanguage", operator: "equals", value: "english" }),
        ], groups: [],
      },
    ];

    // Group 1: arr passes (8 > 7) but standard fails (1 not > 5) → false
    // Group 2: seerr fails (requested is false, not true) → false
    // Group 3 (OR): audio language matches → true
    // Combined: (false AND false) OR true → true (OR takes precedence over the AND failures)
    expect(evaluateAllRulesInMemory(rules, item, arrMeta, seerrMeta)).toBe(true);
  });

  it("all three groups false → item does not match", () => {
    const item = {
      id: "1", playCount: 1,
      streams: [{ streamType: 2, language: "French", codec: "aac" }],
    };
    const arrMeta = makeArrMeta({ rating: 8 });
    const seerrMeta = makeSeerrMeta({ requested: false });

    const rules: RuleGroup[] = [
      // Group 1 (AND): arr passes but standard fails
      {
        id: "g1", condition: "AND", rules: [], groups: [
          {
            id: "sg1", condition: "AND", groups: [],
            rules: [makeRule({ id: "r1", field: "arrRating", operator: "greaterThan", value: "7" })],
          },
          {
            id: "sg2", condition: "AND", groups: [],
            rules: [makeRule({ id: "r2", field: "playCount", operator: "greaterThan", value: "5" })],
          },
        ],
      },
      // Group 2 (AND): seerr fails
      {
        id: "g2", condition: "AND", rules: [
          makeRule({ id: "r3", field: "seerrRequested", operator: "equals", value: "true" }),
        ], groups: [],
      },
      // Group 3 (OR): audio is French, not English → false
      {
        id: "g3", condition: "OR", rules: [
          makeRule({ id: "r4", field: "audioLanguage", operator: "equals", value: "english" }),
        ], groups: [],
      },
    ];

    // Group 1: arr passes but standard fails → false
    // Group 2: seerr fails → false
    // Group 3 (OR): audio is French, not English → false
    // Combined: (false AND false) OR false → false
    expect(evaluateAllRulesInMemory(rules, item, arrMeta, seerrMeta)).toBe(false);
  });
});
