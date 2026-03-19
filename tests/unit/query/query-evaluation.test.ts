import { describe, it, expect } from "vitest";
import { evaluateAllQueryRulesInMemory } from "@/lib/query/execute";
import type { QueryRule, QueryGroup } from "@/lib/query/types";
import type { ArrMetadata, SeerrMetadata } from "@/lib/rules/engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<QueryRule> & Pick<QueryRule, "field" | "operator" | "value">): QueryRule {
  return { id: "r1", condition: "AND", ...overrides };
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

function makeSeerrMeta(overrides?: Partial<SeerrMetadata>): SeerrMetadata {
  return {
    requested: false, requestCount: 0, requestDate: null,
    requestedBy: [], approvalDate: null, declineDate: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mixed standard + external rules: AND/OR correctness
// ---------------------------------------------------------------------------

describe("evaluateAllQueryRulesInMemory — mixed groups", () => {
  it("AND group with arr sub-group AND standard sub-group: both pass", () => {
    const item = { playCount: 10 };
    const arrMeta = makeArrMeta({ rating: 8 });
    const groups: QueryGroup[] = [{
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
    expect(evaluateAllQueryRulesInMemory(groups, item, arrMeta, undefined)).toBe(true);
  });

  it("AND group with arr sub-group AND standard sub-group: standard fails → false", () => {
    const item = { playCount: 1 };
    const arrMeta = makeArrMeta({ rating: 8 });
    const groups: QueryGroup[] = [{
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
    // Arr passes but standard fails → group fails
    expect(evaluateAllQueryRulesInMemory(groups, item, arrMeta, undefined)).toBe(false);
  });

  it("AND group with arr sub-group AND standard sub-group: arr fails → false", () => {
    const item = { playCount: 10 };
    const arrMeta = makeArrMeta({ rating: 3 });
    const groups: QueryGroup[] = [{
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
    expect(evaluateAllQueryRulesInMemory(groups, item, arrMeta, undefined)).toBe(false);
  });

  it("three groups: AND fails, AND fails, OR passes → true", () => {
    const item = {
      playCount: 1,
      streams: [{ streamType: 2, language: "English", codec: "aac" }],
    };
    const arrMeta = makeArrMeta({ rating: 8 });
    const seerrMeta = makeSeerrMeta({ requested: false });

    const groups: QueryGroup[] = [
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
      // Group 3 (OR): stream rule matches
      {
        id: "g3", condition: "OR", rules: [
          makeRule({ id: "r4", field: "audioLanguage", operator: "equals", value: "english" }),
        ], groups: [],
      },
    ];

    // (false AND false) OR true → true
    expect(evaluateAllQueryRulesInMemory(groups, item, arrMeta, seerrMeta)).toBe(true);
  });

  it("all three groups false → false", () => {
    const item = {
      playCount: 1,
      streams: [{ streamType: 2, language: "French", codec: "aac" }],
    };
    const arrMeta = makeArrMeta({ rating: 8 });
    const seerrMeta = makeSeerrMeta({ requested: false });

    const groups: QueryGroup[] = [
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
      {
        id: "g2", condition: "AND", rules: [
          makeRule({ id: "r3", field: "seerrRequested", operator: "equals", value: "true" }),
        ], groups: [],
      },
      {
        id: "g3", condition: "OR", rules: [
          makeRule({ id: "r4", field: "audioLanguage", operator: "equals", value: "english" }),
        ], groups: [],
      },
    ];

    // (false AND false) OR false → false
    expect(evaluateAllQueryRulesInMemory(groups, item, arrMeta, seerrMeta)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Standard field evaluation
// ---------------------------------------------------------------------------

describe("evaluateAllQueryRulesInMemory — standard fields", () => {
  it("text field equals (case-insensitive)", () => {
    const groups: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "title", operator: "equals", value: "The Matrix" })],
    }];
    expect(evaluateAllQueryRulesInMemory(groups, { title: "the matrix" }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groups, { title: "Inception" }, undefined, undefined)).toBe(false);
  });

  it("numeric field comparison", () => {
    const groups: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "playCount", operator: "greaterThanOrEqual", value: "5" })],
    }];
    expect(evaluateAllQueryRulesInMemory(groups, { playCount: 5 }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groups, { playCount: 4 }, undefined, undefined)).toBe(false);
  });

  it("date field inLastDays", () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    const old = new Date();
    old.setDate(old.getDate() - 100);
    const groups: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "addedAt", operator: "inLastDays", value: "30" })],
    }];
    expect(evaluateAllQueryRulesInMemory(groups, { addedAt: recent.toISOString() }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groups, { addedAt: old.toISOString() }, undefined, undefined)).toBe(false);
  });

  it("stream field equals with known language filter", () => {
    const groups: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "audioLanguage", operator: "equals", value: "english" })],
    }];
    const itemWithEnglish = { streams: [{ streamType: 2, language: "English", codec: "aac" }] };
    const itemWithUnknown = { streams: [{ streamType: 2, language: "Unknown", codec: "aac" }] };
    expect(evaluateAllQueryRulesInMemory(groups, itemWithEnglish, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groups, itemWithUnknown, undefined, undefined)).toBe(false);
  });

  it("isNull / isNotNull on text field", () => {
    const groupNull: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "studio", operator: "isNull", value: "" })],
    }];
    const groupNotNull: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "studio", operator: "isNotNull", value: "" })],
    }];
    expect(evaluateAllQueryRulesInMemory(groupNull, { studio: null }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groupNull, { studio: "" }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groupNull, { studio: "Fox" }, undefined, undefined)).toBe(false);
    expect(evaluateAllQueryRulesInMemory(groupNotNull, { studio: "Fox" }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groupNotNull, { studio: null }, undefined, undefined)).toBe(false);
  });

  it("wildcard operator", () => {
    const groups: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "title", operator: "matchesWildcard", value: "The *" })],
    }];
    expect(evaluateAllQueryRulesInMemory(groups, { title: "The Matrix" }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groups, { title: "Inception" }, undefined, undefined)).toBe(false);
  });

  it("genre array contains", () => {
    const groups: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "genre", operator: "contains", value: "Action" })],
    }];
    expect(evaluateAllQueryRulesInMemory(groups, { genres: ["Action", "Sci-Fi"] }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groups, { genres: ["Drama"] }, undefined, undefined)).toBe(false);
    expect(evaluateAllQueryRulesInMemory(groups, { genres: null }, undefined, undefined)).toBe(false);
  });

  it("fileSize field (MB conversion)", () => {
    const groups: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "fileSize", operator: "greaterThan", value: "1000" })],
    }];
    // 1500 MB in bytes = 1500 * 1024 * 1024
    const bigFile = { fileSize: BigInt(1500 * 1024 * 1024).toString() };
    const smallFile = { fileSize: BigInt(500 * 1024 * 1024).toString() };
    expect(evaluateAllQueryRulesInMemory(groups, bigFile, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory(groups, smallFile, undefined, undefined)).toBe(false);
  });

  it("negate flag inverts result", () => {
    const groups: QueryGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [makeRule({ field: "playCount", operator: "greaterThan", value: "5", negate: true })],
    }];
    expect(evaluateAllQueryRulesInMemory(groups, { playCount: 10 }, undefined, undefined)).toBe(false);
    expect(evaluateAllQueryRulesInMemory(groups, { playCount: 2 }, undefined, undefined)).toBe(true);
  });
});
