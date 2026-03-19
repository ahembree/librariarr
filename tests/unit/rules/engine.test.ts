import { describe, it, expect } from "vitest";
import { hasArrRules, hasStreamRules, hasExternalIdFieldRules, groupSeriesResults, getMatchedCriteriaForItems, hasAnyActiveRules, evaluateAllRulesInMemory } from "@/lib/rules/engine";
import type { Rule, RuleGroup } from "@/lib/rules/types";

describe("hasArrRules", () => {
  it("returns false for empty rules", () => {
    expect(hasArrRules([])).toBe(false);
  });

  it("returns false for flat rules with no arr fields", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
    ];
    expect(hasArrRules(rules)).toBe(false);
  });

  it("returns true for flat rules with arr fields", () => {
    const rules: Rule[] = [
      { id: "1", field: "arrTag", operator: "contains", value: "test", condition: "AND" },
    ];
    expect(hasArrRules(rules)).toBe(true);
  });

  it("returns true for grouped rules with nested arr fields", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [
          { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
        ],
        groups: [
          {
            id: "g2",
            condition: "AND",

            rules: [
              { id: "2", field: "arrQualityProfile", operator: "equals", value: "HD-1080p", condition: "AND" },
            ],
            groups: [],
          },
        ],
      },
    ];
    expect(hasArrRules(groups)).toBe(true);
  });

  it("returns false for grouped rules without arr fields", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [
          { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
          { id: "2", field: "title", operator: "contains", value: "test", condition: "AND" },
        ],
        groups: [],
      },
    ];
    expect(hasArrRules(groups)).toBe(false);
  });
});

describe("hasStreamRules", () => {
  it("returns false for empty rules", () => {
    expect(hasStreamRules([])).toBe(false);
  });

  it("returns false for non-stream fields", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
      { id: "2", field: "audioCodec", operator: "equals", value: "aac", condition: "AND" },
    ];
    expect(hasStreamRules(rules)).toBe(false);
  });

  it("returns true for audioLanguage field", () => {
    const rules: Rule[] = [
      { id: "1", field: "audioLanguage", operator: "equals", value: "English", condition: "AND" },
    ];
    expect(hasStreamRules(rules)).toBe(true);
  });

  it("returns true for subtitleLanguage field", () => {
    const rules: Rule[] = [
      { id: "1", field: "subtitleLanguage", operator: "contains", value: "eng", condition: "AND" },
    ];
    expect(hasStreamRules(rules)).toBe(true);
  });

  it("returns true for streamAudioCodec field", () => {
    const rules: Rule[] = [
      { id: "1", field: "streamAudioCodec", operator: "equals", value: "aac", condition: "AND" },
    ];
    expect(hasStreamRules(rules)).toBe(true);
  });

  it("returns true for stream count fields", () => {
    const rules: Rule[] = [
      { id: "1", field: "audioStreamCount", operator: "greaterThan", value: 1, condition: "AND" },
    ];
    expect(hasStreamRules(rules)).toBe(true);
  });

  it("detects stream fields in nested groups", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [{ id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" }],
        groups: [
          {
            id: "g2",
            condition: "AND",

            rules: [{ id: "2", field: "audioLanguage", operator: "equals", value: "English", condition: "AND" }],
            groups: [],
          },
        ],
      },
    ];
    expect(hasStreamRules(groups)).toBe(true);
  });
});

describe("hasExternalIdFieldRules", () => {
  it("returns false for empty rules", () => {
    expect(hasExternalIdFieldRules([])).toBe(false);
  });

  it("returns false for non-externalId fields", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
    ];
    expect(hasExternalIdFieldRules(rules)).toBe(false);
  });

  it("returns true for hasExternalId field", () => {
    const rules: Rule[] = [
      { id: "1", field: "hasExternalId", operator: "equals", value: "TMDB", condition: "AND" },
    ];
    expect(hasExternalIdFieldRules(rules)).toBe(true);
  });

  it("detects hasExternalId in nested groups", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [],
        groups: [
          {
            id: "g2",
            condition: "AND",

            rules: [{ id: "1", field: "hasExternalId", operator: "equals", value: "IMDB", condition: "AND" }],
            groups: [],
          },
        ],
      },
    ];
    expect(hasExternalIdFieldRules(groups)).toBe(true);
  });
});

describe("groupSeriesResults", () => {
  it("returns empty array for empty input", () => {
    expect(groupSeriesResults([])).toEqual([]);
  });

  it("groups episodes by parentTitle and libraryId", () => {
    const items = [
      { id: "ep1", title: "S01E01", parentTitle: "Breaking Bad", libraryId: "lib1", playCount: 2, fileSize: "1073741824", lastPlayedAt: "2024-01-15T00:00:00Z" },
      { id: "ep2", title: "S01E02", parentTitle: "Breaking Bad", libraryId: "lib1", playCount: 3, fileSize: "1073741824", lastPlayedAt: "2024-02-15T00:00:00Z" },
      { id: "ep3", title: "S01E01", parentTitle: "Better Call Saul", libraryId: "lib1", playCount: 1, fileSize: "2147483648", lastPlayedAt: "2024-01-10T00:00:00Z" },
    ];

    const result = groupSeriesResults(items);
    expect(result).toHaveLength(2);

    const bb = result.find((r) => r.title === "Breaking Bad");
    expect(bb).toBeDefined();
    expect(bb!.parentTitle).toBeNull();
    expect(bb!.matchedEpisodes).toBe(2);
    expect(bb!.playCount).toBe(5);
    expect(bb!.fileSize).toBe(BigInt(2147483648).toString());
    expect(bb!.memberIds).toEqual(["ep1", "ep2"]);

    const bcs = result.find((r) => r.title === "Better Call Saul");
    expect(bcs).toBeDefined();
    expect(bcs!.parentTitle).toBeNull();
    expect(bcs!.matchedEpisodes).toBe(1);
    expect(bcs!.playCount).toBe(1);
    expect(bcs!.memberIds).toEqual(["ep3"]);
  });

  it("tracks the latest played date", () => {
    const items = [
      { id: "ep1", title: "S01E01", parentTitle: "Show", libraryId: "lib1", playCount: 1, fileSize: "100", lastPlayedAt: "2024-01-01T00:00:00Z" },
      { id: "ep2", title: "S01E02", parentTitle: "Show", libraryId: "lib1", playCount: 1, fileSize: "100", lastPlayedAt: "2024-06-01T00:00:00Z" },
    ];

    const result = groupSeriesResults(items);
    expect(result[0].lastPlayedAt).toBe("2024-06-01T00:00:00.000Z");
  });

  it("handles null lastPlayedAt", () => {
    const items = [
      { id: "ep1", title: "S01E01", parentTitle: "Show", libraryId: "lib1", playCount: 0, fileSize: "100", lastPlayedAt: null },
      { id: "ep2", title: "S01E02", parentTitle: "Show", libraryId: "lib1", playCount: 0, fileSize: "200", lastPlayedAt: null },
    ];

    const result = groupSeriesResults(items);
    expect(result[0].lastPlayedAt).toBeNull();
  });

  it("separates same parentTitle from different libraries", () => {
    const items = [
      { id: "ep1", title: "S01E01", parentTitle: "Show", libraryId: "lib1", playCount: 1, fileSize: "100" },
      { id: "ep2", title: "S01E01", parentTitle: "Show", libraryId: "lib2", playCount: 2, fileSize: "200" },
    ];

    const result = groupSeriesResults(items);
    expect(result).toHaveLength(2);
  });
});

describe("getMatchedCriteriaForItems", () => {
  it("returns empty map for empty items", () => {
    const result = getMatchedCriteriaForItems([], [], "MOVIE");
    expect(result.size).toBe(0);
  });

  it("returns matched criteria for flat rules", () => {
    const rules: Rule[] = [
      { id: "r1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
    ];
    const items = [
      { id: "item1", playCount: 10, externalIds: [] },
    ];

    const result = getMatchedCriteriaForItems(items, rules, "MOVIE");
    expect(result.size).toBe(1);
    const criteria = result.get("item1");
    expect(criteria).toBeDefined();
    expect(criteria!.length).toBe(1);
    expect(criteria![0].field).toBe("Play Count");
  });

  it("does not match rules that fail", () => {
    const rules: Rule[] = [
      { id: "r1", field: "playCount", operator: "greaterThan", value: 100, condition: "AND" },
    ];
    const items = [
      { id: "item1", playCount: 5, externalIds: [] },
    ];

    const result = getMatchedCriteriaForItems(items, rules, "MOVIE");
    const criteria = result.get("item1");
    expect(criteria).toEqual([]);
  });

  it("handles grouped rules", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [
          { id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" },
          { id: "r2", field: "year", operator: "lessThan", value: 2020, condition: "AND" },
        ],
        groups: [],
      },
    ];
    const items = [
      { id: "item1", playCount: 0, year: 2018, externalIds: [] },
    ];

    const result = getMatchedCriteriaForItems(items, groups, "MOVIE");
    const criteria = result.get("item1");
    expect(criteria).toBeDefined();
    expect(criteria!.length).toBe(2);
  });

  it("matches genre rules against item genres array", () => {
    const rules: Rule[] = [
      { id: "r1", field: "genre", operator: "contains", value: "Action", condition: "AND" },
    ];
    const items = [
      { id: "item1", genres: ["Action", "Drama"], externalIds: [] },
    ];

    const result = getMatchedCriteriaForItems(items, rules, "MOVIE");
    const criteria = result.get("item1");
    expect(criteria).toBeDefined();
    expect(criteria!.length).toBe(1);
    expect(criteria![0].field).toBe("Genre");
  });

  it("matches hasExternalId rules", () => {
    const rules: Rule[] = [
      { id: "r1", field: "hasExternalId", operator: "equals", value: "TMDB", condition: "AND" },
    ];
    const items = [
      { id: "item1", externalIds: [{ source: "TMDB", externalId: "12345" }] },
    ];

    const result = getMatchedCriteriaForItems(items, rules, "MOVIE");
    const criteria = result.get("item1");
    expect(criteria).toBeDefined();
    expect(criteria!.length).toBe(1);
    expect(criteria![0].field).toBe("Has External ID");
  });

  it("matches stream language rules", () => {
    const rules: Rule[] = [
      { id: "r1", field: "audioLanguage", operator: "equals", value: "English", condition: "AND" },
    ];
    const items = [
      { id: "item1", streams: [{ streamType: 2, language: "English", codec: "aac" }], externalIds: [] },
    ];

    const result = getMatchedCriteriaForItems(items, rules, "MOVIE");
    const criteria = result.get("item1");
    expect(criteria).toBeDefined();
    expect(criteria!.length).toBe(1);
    expect(criteria![0].field).toBe("Audio Language");
  });

  it("matches duration rules (minutes to ms)", () => {
    const rules: Rule[] = [
      { id: "r1", field: "duration", operator: "greaterThan", value: 120, condition: "AND" },
    ];
    const items = [
      { id: "item1", duration: 9000000, externalIds: [] }, // 150 minutes in ms
    ];

    const result = getMatchedCriteriaForItems(items, rules, "MOVIE");
    const criteria = result.get("item1");
    expect(criteria).toBeDefined();
    expect(criteria!.length).toBe(1);
    expect(criteria![0].field).toBe("Duration (min)");
  });
});

describe("hasAnyActiveRules", () => {
  // ---- Flat rules (Rule[]) ----

  it("returns false for empty rules array", () => {
    expect(hasAnyActiveRules([])).toBe(false);
  });

  it("returns true for flat rule with no enabled flag (defaults to enabled)", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
    ];
    expect(hasAnyActiveRules(rules)).toBe(true);
  });

  it("returns true for flat rule with enabled: true", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND", enabled: true },
    ];
    expect(hasAnyActiveRules(rules)).toBe(true);
  });

  it("returns false when all flat rules are disabled", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND", enabled: false },
      { id: "2", field: "year", operator: "lessThan", value: 2020, condition: "AND", enabled: false },
    ];
    expect(hasAnyActiveRules(rules)).toBe(false);
  });

  it("returns true when at least one flat rule is enabled among disabled ones", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND", enabled: false },
      { id: "2", field: "year", operator: "lessThan", value: 2020, condition: "AND", enabled: true },
    ];
    expect(hasAnyActiveRules(rules)).toBe(true);
  });

  // ---- Rule groups (RuleGroup[]) ----

  it("returns false when all groups are disabled", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        enabled: false,
        rules: [
          { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
        ],
        groups: [],
      },
    ];
    expect(hasAnyActiveRules(groups)).toBe(false);
  });

  it("returns false when group is enabled but all its rules are disabled", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [
          { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND", enabled: false },
        ],
        groups: [],
      },
    ];
    expect(hasAnyActiveRules(groups)).toBe(false);
  });

  it("returns true when group has at least one enabled rule", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [
          { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND", enabled: false },
          { id: "2", field: "year", operator: "lessThan", value: 2020, condition: "AND" },
        ],
        groups: [],
      },
    ];
    expect(hasAnyActiveRules(groups)).toBe(true);
  });

  it("returns true when enabled rule is in a nested sub-group", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [],
        groups: [
          {
            id: "g2",
            condition: "AND",

            rules: [
              { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
            ],
            groups: [],
          },
        ],
      },
    ];
    expect(hasAnyActiveRules(groups)).toBe(true);
  });

  it("returns false when deeply nested sub-groups are all disabled", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [],
        groups: [
          {
            id: "g2",
            condition: "AND",

            enabled: false,
            rules: [
              { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
            ],
            groups: [],
          },
        ],
      },
    ];
    expect(hasAnyActiveRules(groups)).toBe(false);
  });

  it("returns true with mixed enabled/disabled groups", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        enabled: false,
        rules: [{ id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" }],
        groups: [],
      },
      {
        id: "g2",
        condition: "AND",
        rules: [{ id: "2", field: "year", operator: "lessThan", value: 2020, condition: "AND" }],
        groups: [],
      },
    ];
    expect(hasAnyActiveRules(groups)).toBe(true);
  });
});

// ─── Safety guard tests: evaluateAllRulesInMemory defaults to false ───

describe("evaluateAllRulesInMemory — safety defaults", () => {
  const dummyItem = { id: "1", title: "Test Movie", playCount: 5, streams: [] };

  it("returns false for empty rules array", () => {
    expect(evaluateAllRulesInMemory([], dummyItem)).toBe(false);
  });

  it("returns false when all flat rules are disabled", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 0, condition: "AND", enabled: false },
      { id: "2", field: "title", operator: "contains", value: "Test", condition: "AND", enabled: false },
    ];
    expect(evaluateAllRulesInMemory(rules, dummyItem)).toBe(false);
  });

  it("returns false when all groups are disabled", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",
        enabled: false,
        rules: [
          { id: "1", field: "playCount", operator: "greaterThan", value: 0, condition: "AND" },
        ],
        groups: [],
      },
    ];
    expect(evaluateAllRulesInMemory(groups, dummyItem)).toBe(false);
  });

  it("returns false when all rules within enabled groups are disabled", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",
        rules: [
          { id: "1", field: "playCount", operator: "greaterThan", value: 0, condition: "AND", enabled: false },
        ],
        groups: [],
      },
    ];
    expect(evaluateAllRulesInMemory(groups, dummyItem)).toBe(false);
  });

  it("skips disabled groups without affecting active groups", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",
        enabled: false,
        rules: [
          // This rule would NOT match, but it's disabled so it should be skipped
          { id: "1", field: "playCount", operator: "lessThan", value: 0, condition: "AND" },
        ],
        groups: [],
      },
      {
        id: "g2",
        condition: "AND",
        rules: [
          // This rule DOES match
          { id: "2", field: "playCount", operator: "greaterThan", value: 0, condition: "AND" },
        ],
        groups: [],
      },
    ];
    // Disabled group is skipped, active group matches → result is true
    expect(evaluateAllRulesInMemory(groups, dummyItem)).toBe(true);
  });

  it("skips empty sub-groups without affecting active sibling rules", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",
        rules: [
          { id: "1", field: "playCount", operator: "greaterThan", value: 0, condition: "AND" },
        ],
        groups: [
          {
            id: "g2",
            condition: "AND",
            rules: [], // Empty sub-group
            groups: [],
          },
        ],
      },
    ];
    // Empty sub-group is skipped, active rule matches → result is true
    expect(evaluateAllRulesInMemory(groups, dummyItem)).toBe(true);
  });
});
