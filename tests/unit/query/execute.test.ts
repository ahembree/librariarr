import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock heavy deps so we can import the types module + arr/seerr filters
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  prisma: {},
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  hasArrRules,
  hasSeerrRules,
  hasCrossSystemRules,
  isExternalQueryField,
  isCrossSystemQueryField,
} from "@/lib/query/types";
import type { QueryGroup } from "@/lib/query/types";

import { evaluateQueryArrRule } from "@/lib/query/arr-filter";
import { evaluateQuerySeerrRule } from "@/lib/query/seerr-filter";
import type { ArrMetadata, SeerrMetadata } from "@/lib/rules/lifecycle-engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGroup(overrides: Partial<QueryGroup>): QueryGroup {
  return {
    id: "g1",
    condition: "AND",
    rules: [],
    groups: [],
    ...overrides,
  };
}

function makeArrMeta(overrides?: Partial<ArrMetadata>): ArrMetadata {
  return {
    arrId: 0, tags: [], qualityProfile: "", monitored: false,
    rating: null, tmdbRating: null, rtCriticRating: null,
    dateAdded: null, path: null, sizeOnDisk: null, originalLanguage: null,
    releaseDate: null, inCinemasDate: null, runtime: null,
    qualityName: null, qualityCutoffMet: null, customFormatScore: null, downloadDate: null,
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
// Field classification helpers
// ---------------------------------------------------------------------------

describe("isExternalQueryField", () => {
  it("returns true for Arr fields", () => {
    expect(isExternalQueryField("arrTag")).toBe(true);
    expect(isExternalQueryField("arrMonitored")).toBe(true);
    expect(isExternalQueryField("foundInArr")).toBe(true);
  });

  it("returns true for Seerr fields", () => {
    expect(isExternalQueryField("seerrRequested")).toBe(true);
    expect(isExternalQueryField("seerrRequestCount")).toBe(true);
  });

  it("returns false for standard fields", () => {
    expect(isExternalQueryField("title")).toBe(false);
    expect(isExternalQueryField("playCount")).toBe(false);
  });
});

describe("isCrossSystemQueryField", () => {
  it("returns true for cross-system fields", () => {
    expect(isCrossSystemQueryField("serverCount")).toBe(true);
    expect(isCrossSystemQueryField("matchedByRuleSet")).toBe(true);
    expect(isCrossSystemQueryField("hasPendingAction")).toBe(true);
    expect(isCrossSystemQueryField("excludedInLibrariarr")).toBe(true);
  });

  it("returns false for non-cross-system fields", () => {
    expect(isCrossSystemQueryField("title")).toBe(false);
    expect(isCrossSystemQueryField("arrTag")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group tree walkers
// ---------------------------------------------------------------------------

describe("hasArrRules", () => {
  it("returns false for empty groups", () => {
    expect(hasArrRules([])).toBe(false);
  });

  it("returns true when a rule references an Arr field", () => {
    const groups: QueryGroup[] = [
      makeGroup({
        rules: [{ id: "r1", field: "arrMonitored", operator: "equals", value: "true", condition: "AND" }],
      }),
    ];
    expect(hasArrRules(groups)).toBe(true);
  });

  it("returns false when rules only reference standard fields", () => {
    const groups: QueryGroup[] = [
      makeGroup({
        rules: [{ id: "r1", field: "title", operator: "contains", value: "test", condition: "AND" }],
      }),
    ];
    expect(hasArrRules(groups)).toBe(false);
  });

  it("finds Arr rules in nested groups", () => {
    const groups: QueryGroup[] = [
      makeGroup({
        groups: [
          makeGroup({
            id: "nested",
            rules: [{ id: "r1", field: "arrRating", operator: "greaterThan", value: "7", condition: "AND" }],
          }),
        ],
      }),
    ];
    expect(hasArrRules(groups)).toBe(true);
  });

  it("skips disabled groups", () => {
    const groups: QueryGroup[] = [
      makeGroup({
        enabled: false,
        rules: [{ id: "r1", field: "arrMonitored", operator: "equals", value: "true", condition: "AND" }],
      }),
    ];
    expect(hasArrRules(groups)).toBe(false);
  });

  it("skips disabled rules", () => {
    const groups: QueryGroup[] = [
      makeGroup({
        rules: [
          { id: "r1", field: "arrMonitored", operator: "equals", value: "true", condition: "AND", enabled: false },
        ],
      }),
    ];
    expect(hasArrRules(groups)).toBe(false);
  });
});

describe("hasSeerrRules", () => {
  it("returns true for Seerr field rules", () => {
    const groups: QueryGroup[] = [
      makeGroup({
        rules: [{ id: "r1", field: "seerrRequested", operator: "equals", value: "true", condition: "AND" }],
      }),
    ];
    expect(hasSeerrRules(groups)).toBe(true);
  });

  it("returns false for non-Seerr field rules", () => {
    const groups: QueryGroup[] = [
      makeGroup({
        rules: [{ id: "r1", field: "title", operator: "contains", value: "test", condition: "AND" }],
      }),
    ];
    expect(hasSeerrRules(groups)).toBe(false);
  });
});

describe("hasCrossSystemRules", () => {
  it("returns true for cross-system field rules", () => {
    const groups: QueryGroup[] = [
      makeGroup({
        rules: [{ id: "r1", field: "serverCount", operator: "greaterThan", value: "1", condition: "AND" }],
      }),
    ];
    expect(hasCrossSystemRules(groups)).toBe(true);
  });

  it("returns false for non-cross-system rules", () => {
    expect(hasCrossSystemRules([makeGroup({ rules: [] })])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateQueryArrRule
// ---------------------------------------------------------------------------

describe("evaluateQueryArrRule", () => {
  describe("foundInArr", () => {
    it("true when meta exists and value is true", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "foundInArr", operator: "equals", value: "true", condition: "AND" },
        makeArrMeta(),
      );
      expect(result).toBe(true);
    });

    it("false when meta is undefined and value is true", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "foundInArr", operator: "equals", value: "true", condition: "AND" },
        undefined,
      );
      expect(result).toBe(false);
    });

    it("handles notEquals operator", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "foundInArr", operator: "notEquals", value: "true", condition: "AND" },
        undefined,
      );
      expect(result).toBe(true); // found=false, notEquals true → true
    });

    it("applies negate", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "foundInArr", operator: "equals", value: "true", condition: "AND", negate: true },
        makeArrMeta(),
      );
      expect(result).toBe(false);
    });
  });

  describe("arrTag", () => {
    it("equals matches tag case-insensitively", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "arrTag", operator: "equals", value: "important", condition: "AND" },
        makeArrMeta({ tags: ["Important", "Other"] }),
      );
      expect(result).toBe(true);
    });

    it("contains is list membership against the selected tag set", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "arrTag", operator: "contains", value: "important", condition: "AND" },
        makeArrMeta({ tags: ["Important"] }),
      );
      expect(result).toBe(true);
    });

    it("contains does not match a substring of an existing tag", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "arrTag", operator: "contains", value: "imp", condition: "AND" },
        makeArrMeta({ tags: ["Important"] }),
      );
      expect(result).toBe(false);
    });

    it("notContains returns false when tag is in the selected list", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "arrTag", operator: "notContains", value: "important", condition: "AND" },
        makeArrMeta({ tags: ["Important"] }),
      );
      expect(result).toBe(false);
    });

    it("matchesWildcard works with glob patterns", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "arrTag", operator: "matchesWildcard", value: "imp*", condition: "AND" },
        makeArrMeta({ tags: ["Important"] }),
      );
      expect(result).toBe(true);
    });
  });

  describe("arrMonitored", () => {
    it("equals true matches monitored items", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "arrMonitored", operator: "equals", value: "true", condition: "AND" },
        makeArrMeta({ monitored: true }),
      );
      expect(result).toBe(true);
    });

    it("notEquals handles unmonitored items", () => {
      const result = evaluateQueryArrRule(
        { id: "r1", field: "arrMonitored", operator: "notEquals", value: "true", condition: "AND" },
        makeArrMeta({ monitored: false }),
      );
      expect(result).toBe(true);
    });
  });

  describe("arrRating (numeric)", () => {
    it("greaterThan compares correctly", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrRating", operator: "greaterThan", value: "7", condition: "AND" },
        makeArrMeta({ rating: 8.5 }),
      )).toBe(true);
    });

    it("returns false when rating is null", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrRating", operator: "greaterThan", value: "7", condition: "AND" },
        makeArrMeta({ rating: null }),
      )).toBe(false);
    });

    it("lessThanOrEqual compares correctly", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrRating", operator: "lessThanOrEqual", value: "5", condition: "AND" },
        makeArrMeta({ rating: 5 }),
      )).toBe(true);
    });
  });

  describe("arrDateAdded (date)", () => {
    it("before compares correctly", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrDateAdded", operator: "before", value: "2024-06-01", condition: "AND" },
        makeArrMeta({ dateAdded: "2024-01-15" }),
      )).toBe(true);
    });

    it("isNull returns true when date is null", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrDateAdded", operator: "isNull", value: "", condition: "AND" },
        makeArrMeta({ dateAdded: null }),
      )).toBe(true);
    });

    it("isNotNull returns true when date exists", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrDateAdded", operator: "isNotNull", value: "", condition: "AND" },
        makeArrMeta({ dateAdded: "2024-01-01" }),
      )).toBe(true);
    });
  });

  describe("arrQualityCutoffMet (boolean)", () => {
    it("equals true matches", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrQualityCutoffMet", operator: "equals", value: "true", condition: "AND" },
        makeArrMeta({ qualityCutoffMet: true }),
      )).toBe(true);
    });

    it("returns false when null", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrQualityCutoffMet", operator: "equals", value: "true", condition: "AND" },
        makeArrMeta({ qualityCutoffMet: null }),
      )).toBe(false);
    });
  });

  describe("arrCustomFormatScore (number)", () => {
    it("greaterThanOrEqual matches when the score meets the threshold", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrCustomFormatScore", operator: "greaterThanOrEqual", value: 100, condition: "AND" },
        makeArrMeta({ customFormatScore: 120 }),
      )).toBe(true);
    });

    it("lessThan matches a negative score", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrCustomFormatScore", operator: "lessThan", value: 0, condition: "AND" },
        makeArrMeta({ customFormatScore: -25 }),
      )).toBe(true);
    });

    it("isNull matches a movie with no file", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrCustomFormatScore", operator: "isNull", value: "", condition: "AND" },
        makeArrMeta({ customFormatScore: null }),
      )).toBe(true);
    });

    it("between matches a score inside the range (parity with the rule engine)", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrCustomFormatScore", operator: "between", value: "50,100", condition: "AND" },
        makeArrMeta({ customFormatScore: 75 }),
      )).toBe(true);
    });

    it("between excludes a score outside the range", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrCustomFormatScore", operator: "between", value: "50,100", condition: "AND" },
        makeArrMeta({ customFormatScore: 120 }),
      )).toBe(false);
    });

    it("comparison returns false when the score is null", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrCustomFormatScore", operator: "greaterThan", value: 0, condition: "AND" },
        makeArrMeta({ customFormatScore: null }),
      )).toBe(false);
    });
  });

  describe("arrPath (text)", () => {
    it("contains checks partial match", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrPath", operator: "contains", value: "movies", condition: "AND" },
        makeArrMeta({ path: "/data/movies/some-movie" }),
      )).toBe(true);
    });

    it("isNull when path is null", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrPath", operator: "isNull", value: "", condition: "AND" },
        makeArrMeta({ path: null }),
      )).toBe(true);
    });
  });

  describe("arrSizeOnDisk (numeric in MB)", () => {
    it("greaterThan converts bytes to MB", () => {
      // 2 GB = 2048 MB
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrSizeOnDisk", operator: "greaterThan", value: "1000", condition: "AND" },
        makeArrMeta({ sizeOnDisk: 2 * 1024 * 1024 * 1024 }),
      )).toBe(true);
    });

    it("returns false when sizeOnDisk is null", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrSizeOnDisk", operator: "greaterThan", value: "100", condition: "AND" },
        makeArrMeta({ sizeOnDisk: null }),
      )).toBe(false);
    });
  });

  describe("negate flag", () => {
    it("inverts the result", () => {
      expect(evaluateQueryArrRule(
        { id: "r1", field: "arrMonitored", operator: "equals", value: "true", condition: "AND", negate: true },
        makeArrMeta({ monitored: true }),
      )).toBe(false);
    });
  });

  it("returns false for unknown fields without meta", () => {
    expect(evaluateQueryArrRule(
      { id: "r1", field: "arrUnknown", operator: "equals", value: "x", condition: "AND" },
      undefined,
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateQuerySeerrRule
// ---------------------------------------------------------------------------

describe("evaluateQuerySeerrRule", () => {
  describe("seerrRequested", () => {
    it("equals true when requested", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequested", operator: "equals", value: "true", condition: "AND" },
        makeSeerrMeta({ requested: true }),
      )).toBe(true);
    });

    it("equals false when not requested", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequested", operator: "equals", value: "true", condition: "AND" },
        makeSeerrMeta({ requested: false }),
      )).toBe(false);
    });

    it("uses default meta when undefined", () => {
      // Default has requested: false
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequested", operator: "equals", value: "false", condition: "AND" },
        undefined,
      )).toBe(true);
    });
  });

  describe("seerrRequestCount", () => {
    it("greaterThan works", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestCount", operator: "greaterThan", value: "2", condition: "AND" },
        makeSeerrMeta({ requestCount: 5 }),
      )).toBe(true);
    });

    it("equals works", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestCount", operator: "equals", value: "0", condition: "AND" },
        makeSeerrMeta({ requestCount: 0 }),
      )).toBe(true);
    });

    // Regression: the query evaluator previously had no `between` case (it
    // silently matched nothing). It now shares the canonical rule-engine
    // evaluator, so `between` works.
    it("between works (shared canonical evaluator)", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestCount", operator: "between", value: "1,5", condition: "AND" },
        makeSeerrMeta({ requestCount: 3 }),
      )).toBe(true);
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestCount", operator: "between", value: "1,5", condition: "AND" },
        makeSeerrMeta({ requestCount: 9 }),
      )).toBe(false);
    });
  });

  describe("seerrRequestDate (date)", () => {
    it("before compares correctly", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestDate", operator: "before", value: "2024-06-01", condition: "AND" },
        makeSeerrMeta({ requestDate: "2024-01-15" }),
      )).toBe(true);
    });

    it("returns false for null date", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestDate", operator: "before", value: "2024-06-01", condition: "AND" },
        makeSeerrMeta({ requestDate: null }),
      )).toBe(false);
    });

    // Regression: the query copy previously ordered isNull AFTER the null guard,
    // so `isNull` wrongly returned false when the date was null. The shared
    // canonical evaluator handles isNull/isNotNull before the guard.
    it("isNull returns true when date is null (shared canonical evaluator)", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestDate", operator: "isNull", value: "", condition: "AND" },
        makeSeerrMeta({ requestDate: null }),
      )).toBe(true);
    });

    it("isNotNull returns true when date exists", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestDate", operator: "isNotNull", value: "", condition: "AND" },
        makeSeerrMeta({ requestDate: "2024-01-01" }),
      )).toBe(true);
    });
  });

  describe("seerrRequestedBy", () => {
    it("equals matches user case-insensitively", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestedBy", operator: "equals", value: "admin", condition: "AND" },
        makeSeerrMeta({ requestedBy: ["Admin"] }),
      )).toBe(true);
    });

    it("contains matches an exact requester from the selected list", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestedBy", operator: "contains", value: "admin", condition: "AND" },
        makeSeerrMeta({ requestedBy: ["Admin", "User2"] }),
      )).toBe(true);
    });

    it("contains does not match substrings of a requester name", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestedBy", operator: "contains", value: "adm", condition: "AND" },
        makeSeerrMeta({ requestedBy: ["Admin", "User2"] }),
      )).toBe(false);
    });

    it("notContains returns true when no requester is in the selected list", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequestedBy", operator: "notContains", value: "xyz", condition: "AND" },
        makeSeerrMeta({ requestedBy: ["Admin"] }),
      )).toBe(true);
    });
  });

  describe("negate", () => {
    it("inverts the result", () => {
      expect(evaluateQuerySeerrRule(
        { id: "r1", field: "seerrRequested", operator: "equals", value: "true", condition: "AND", negate: true },
        makeSeerrMeta({ requested: true }),
      )).toBe(false);
    });
  });
});
