import { describe, it, expect } from "vitest";
import { hasSeerrRules, getMatchedCriteriaForItems } from "@/lib/rules/engine";
import type { SeerrMetadata, SeerrDataMap } from "@/lib/rules/engine";
import { isSeerrField, isExternalField, SEERR_FIELDS } from "@/lib/rules/types";
import type { Rule, RuleGroup } from "@/lib/rules/types";

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

describe("SEERR_FIELDS", () => {
  it("contains exactly 6 seerr fields", () => {
    expect(SEERR_FIELDS).toHaveLength(6);
  });

  it("contains each expected field name", () => {
    expect(SEERR_FIELDS).toContain("seerrRequested");
    expect(SEERR_FIELDS).toContain("seerrRequestDate");
    expect(SEERR_FIELDS).toContain("seerrRequestCount");
    expect(SEERR_FIELDS).toContain("seerrRequestedBy");
    expect(SEERR_FIELDS).toContain("seerrApprovalDate");
    expect(SEERR_FIELDS).toContain("seerrDeclineDate");
  });
});

describe("isSeerrField", () => {
  it("returns true for all 6 seerr fields", () => {
    expect(isSeerrField("seerrRequested")).toBe(true);
    expect(isSeerrField("seerrRequestDate")).toBe(true);
    expect(isSeerrField("seerrRequestCount")).toBe(true);
    expect(isSeerrField("seerrRequestedBy")).toBe(true);
    expect(isSeerrField("seerrApprovalDate")).toBe(true);
    expect(isSeerrField("seerrDeclineDate")).toBe(true);
  });

  it("returns false for non-seerr fields", () => {
    expect(isSeerrField("title")).toBe(false);
    expect(isSeerrField("arrTag")).toBe(false);
    expect(isSeerrField("playCount")).toBe(false);
    expect(isSeerrField("resolution")).toBe(false);
  });
});

describe("isExternalField", () => {
  it("returns true for arr fields", () => {
    expect(isExternalField("arrTag")).toBe(true);
    expect(isExternalField("arrQualityProfile")).toBe(true);
    expect(isExternalField("arrMonitored")).toBe(true);
    expect(isExternalField("arrRating")).toBe(true);
  });

  it("returns true for seerr fields", () => {
    expect(isExternalField("seerrRequested")).toBe(true);
    expect(isExternalField("seerrRequestDate")).toBe(true);
    expect(isExternalField("seerrRequestCount")).toBe(true);
    expect(isExternalField("seerrRequestedBy")).toBe(true);
    expect(isExternalField("seerrApprovalDate")).toBe(true);
    expect(isExternalField("seerrDeclineDate")).toBe(true);
  });

  it("returns false for regular fields", () => {
    expect(isExternalField("title")).toBe(false);
    expect(isExternalField("playCount")).toBe(false);
    expect(isExternalField("resolution")).toBe(false);
    expect(isExternalField("fileSize")).toBe(false);
    expect(isExternalField("year")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasSeerrRules
// ---------------------------------------------------------------------------

describe("hasSeerrRules", () => {
  it("returns false for empty rules array", () => {
    expect(hasSeerrRules([])).toBe(false);
  });

  it("returns false for rules with only regular fields", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
      { id: "2", field: "title", operator: "contains", value: "test", condition: "AND" },
    ];
    expect(hasSeerrRules(rules)).toBe(false);
  });

  it("returns false for rules with only arr fields", () => {
    const rules: Rule[] = [
      { id: "1", field: "arrTag", operator: "contains", value: "action", condition: "AND" },
      { id: "2", field: "arrMonitored", operator: "equals", value: "true", condition: "AND" },
    ];
    expect(hasSeerrRules(rules)).toBe(false);
  });

  it("returns true when rules contain a seerr field", () => {
    const rules: Rule[] = [
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
      { id: "2", field: "seerrRequested", operator: "equals", value: "true", condition: "AND" },
    ];
    expect(hasSeerrRules(rules)).toBe(true);
  });

  it("returns true for each individual seerr field", () => {
    for (const seerrField of SEERR_FIELDS) {
      const rules: Rule[] = [
        { id: "1", field: seerrField, operator: "equals", value: "test", condition: "AND" },
      ];
      expect(hasSeerrRules(rules)).toBe(true);
    }
  });

  it("returns true when seerr field is nested inside a group", () => {
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
              { id: "2", field: "seerrRequestCount", operator: "greaterThan", value: "5", condition: "AND" },
            ],
            groups: [],
          },
        ],
      },
    ];
    expect(hasSeerrRules(groups)).toBe(true);
  });

  it("returns false for grouped rules without seerr fields", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [
          { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
          { id: "2", field: "arrTag", operator: "contains", value: "hd", condition: "AND" },
        ],
        groups: [],
      },
    ];
    expect(hasSeerrRules(groups)).toBe(false);
  });

  it("returns true when seerr field is deeply nested", () => {
    const groups: RuleGroup[] = [
      {
        id: "g1",
        condition: "AND",

        rules: [],
        groups: [
          {
            id: "g2",
            condition: "AND",

            rules: [],
            groups: [
              {
                id: "g3",
                condition: "AND",
        
                rules: [
                  { id: "1", field: "seerrApprovalDate", operator: "before", value: "2024-01-01", condition: "AND" },
                ],
                groups: [],
              },
            ],
          },
        ],
      },
    ];
    expect(hasSeerrRules(groups)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateSeerrRule — tested indirectly via getMatchedCriteriaForItems
// ---------------------------------------------------------------------------
//
// evaluateSeerrRule is not exported from engine.ts. We exercise it through
// getMatchedCriteriaForItems, which calls evaluateRuleAgainstItem, which
// delegates to evaluateSeerrRule for any seerr field.
//
// Each item needs an `externalIds` array with a TMDB entry so the engine can
// look up seerr metadata.  The seerrData map is keyed by TMDB ID for movies.
// ---------------------------------------------------------------------------

function makeItem(id: string, tmdbId: string, overrides?: Record<string, unknown>) {
  return {
    id,
    externalIds: [{ source: "TMDB", externalId: tmdbId }],
    ...overrides,
  };
}

function makeSeerrData(tmdbId: string, meta: Partial<SeerrMetadata>): SeerrDataMap {
  return {
    [tmdbId]: {
      requested: false,
      requestCount: 0,
      requestDate: null,
      requestedBy: [],
      approvalDate: null,
      declineDate: null,
      ...meta,
    },
  };
}

describe("evaluateSeerrRule (via getMatchedCriteriaForItems)", () => {
  // -- seerrRequested -------------------------------------------------------

  describe("seerrRequested", () => {
    it("matches when requested equals true", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequested", operator: "equals", value: "true", condition: "AND" },
      ];
      const items = [makeItem("item1", "123")];
      const seerrData = makeSeerrData("123", { requested: true });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      const criteria = result.get("item1")!;
      expect(criteria).toHaveLength(1);
      expect(criteria[0].field).toBe("Has Request");
    });

    it("does not match when requested is false and rule expects true", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequested", operator: "equals", value: "true", condition: "AND" },
      ];
      const items = [makeItem("item1", "123")];
      const seerrData = makeSeerrData("123", { requested: false });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });

    it("matches notEquals when requested differs from value", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequested", operator: "notEquals", value: "true", condition: "AND" },
      ];
      const items = [makeItem("item1", "123")];
      const seerrData = makeSeerrData("123", { requested: false });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("uses default metadata (requested=false) when no seerr data exists", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequested", operator: "equals", value: "false", condition: "AND" },
      ];
      const items = [makeItem("item1", "123")];
      // No seerrData provided at all

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, undefined);
      expect(result.get("item1")!).toHaveLength(1);
    });
  });

  // -- seerrRequestCount ----------------------------------------------------

  describe("seerrRequestCount", () => {
    it("matches equals operator", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestCount", operator: "equals", value: "3", condition: "AND" },
      ];
      const items = [makeItem("item1", "42")];
      const seerrData = makeSeerrData("42", { requestCount: 3 });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("matches greaterThan operator", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestCount", operator: "greaterThan", value: "2", condition: "AND" },
      ];
      const items = [makeItem("item1", "42")];
      const seerrData = makeSeerrData("42", { requestCount: 5 });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("does not match greaterThan when count is less", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestCount", operator: "greaterThan", value: "10", condition: "AND" },
      ];
      const items = [makeItem("item1", "42")];
      const seerrData = makeSeerrData("42", { requestCount: 5 });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });

    it("matches lessThan operator", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestCount", operator: "lessThan", value: "10", condition: "AND" },
      ];
      const items = [makeItem("item1", "42")];
      const seerrData = makeSeerrData("42", { requestCount: 3 });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("matches notEquals operator", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestCount", operator: "notEquals", value: "0", condition: "AND" },
      ];
      const items = [makeItem("item1", "42")];
      const seerrData = makeSeerrData("42", { requestCount: 5 });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("defaults to requestCount 0 when no seerr data exists", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestCount", operator: "equals", value: "0", condition: "AND" },
      ];
      const items = [makeItem("item1", "42")];

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, undefined);
      expect(result.get("item1")!).toHaveLength(1);
    });
  });

  // -- seerrRequestDate -----------------------------------------------------

  describe("seerrRequestDate", () => {
    it("matches before operator", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestDate", operator: "before", value: "2025-01-01", condition: "AND" },
      ];
      const items = [makeItem("item1", "10")];
      const seerrData = makeSeerrData("10", { requestDate: "2024-06-15T00:00:00Z" });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("matches after operator", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestDate", operator: "after", value: "2024-01-01", condition: "AND" },
      ];
      const items = [makeItem("item1", "10")];
      const seerrData = makeSeerrData("10", { requestDate: "2024-06-15T00:00:00Z" });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("matches equals operator by date portion only", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestDate", operator: "equals", value: "2024-06-15", condition: "AND" },
      ];
      const items = [makeItem("item1", "10")];
      const seerrData = makeSeerrData("10", { requestDate: "2024-06-15T14:30:00Z" });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("does not match when requestDate is null", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestDate", operator: "before", value: "2025-01-01", condition: "AND" },
      ];
      const items = [makeItem("item1", "10")];
      const seerrData = makeSeerrData("10", { requestDate: null });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });

    it("matches inLastDays operator", () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5);
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestDate", operator: "inLastDays", value: "10", condition: "AND" },
      ];
      const items = [makeItem("item1", "10")];
      const seerrData = makeSeerrData("10", { requestDate: recentDate.toISOString() });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("does not match inLastDays for old dates", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestDate", operator: "inLastDays", value: "10", condition: "AND" },
      ];
      const items = [makeItem("item1", "10")];
      const seerrData = makeSeerrData("10", { requestDate: "2020-01-01T00:00:00Z" });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });
  });

  // -- seerrApprovalDate ----------------------------------------------------

  describe("seerrApprovalDate", () => {
    it("matches before operator", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrApprovalDate", operator: "before", value: "2025-06-01", condition: "AND" },
      ];
      const items = [makeItem("item1", "77")];
      const seerrData = makeSeerrData("77", { approvalDate: "2024-12-01T00:00:00Z" });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("does not match when approvalDate is null", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrApprovalDate", operator: "before", value: "2025-06-01", condition: "AND" },
      ];
      const items = [makeItem("item1", "77")];
      const seerrData = makeSeerrData("77", { approvalDate: null });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });
  });

  // -- seerrDeclineDate -----------------------------------------------------

  describe("seerrDeclineDate", () => {
    it("matches after operator", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrDeclineDate", operator: "after", value: "2024-01-01", condition: "AND" },
      ];
      const items = [makeItem("item1", "88")];
      const seerrData = makeSeerrData("88", { declineDate: "2024-09-15T00:00:00Z" });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("does not match when declineDate is null", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrDeclineDate", operator: "after", value: "2024-01-01", condition: "AND" },
      ];
      const items = [makeItem("item1", "88")];
      const seerrData = makeSeerrData("88", { declineDate: null });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });
  });

  // -- seerrRequestedBy -----------------------------------------------------

  describe("seerrRequestedBy", () => {
    it("matches equals when user is in the requestedBy list", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestedBy", operator: "equals", value: "alice", condition: "AND" },
      ];
      const items = [makeItem("item1", "55")];
      const seerrData = makeSeerrData("55", { requestedBy: ["Alice", "Bob"] });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("is case-insensitive for equals", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestedBy", operator: "equals", value: "ALICE", condition: "AND" },
      ];
      const items = [makeItem("item1", "55")];
      const seerrData = makeSeerrData("55", { requestedBy: ["alice"] });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("does not match equals when user is not in the list", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestedBy", operator: "equals", value: "charlie", condition: "AND" },
      ];
      const items = [makeItem("item1", "55")];
      const seerrData = makeSeerrData("55", { requestedBy: ["Alice", "Bob"] });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });

    it("matches notEquals when user is not in the list", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestedBy", operator: "notEquals", value: "charlie", condition: "AND" },
      ];
      const items = [makeItem("item1", "55")];
      const seerrData = makeSeerrData("55", { requestedBy: ["Alice", "Bob"] });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("matches contains with partial username", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestedBy", operator: "contains", value: "ali", condition: "AND" },
      ];
      const items = [makeItem("item1", "55")];
      const seerrData = makeSeerrData("55", { requestedBy: ["Alice", "Bob"] });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("matches contains with pipe-separated values", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestedBy", operator: "contains", value: "charlie|bob", condition: "AND" },
      ];
      const items = [makeItem("item1", "55")];
      const seerrData = makeSeerrData("55", { requestedBy: ["Alice", "Bob"] });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("matches notContains when no user matches", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestedBy", operator: "notContains", value: "charlie", condition: "AND" },
      ];
      const items = [makeItem("item1", "55")];
      const seerrData = makeSeerrData("55", { requestedBy: ["Alice", "Bob"] });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("does not match notContains when a user does match", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestedBy", operator: "notContains", value: "alice", condition: "AND" },
      ];
      const items = [makeItem("item1", "55")];
      const seerrData = makeSeerrData("55", { requestedBy: ["Alice", "Bob"] });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });

    it("defaults to empty requestedBy when no seerr data exists", () => {
      // With empty requestedBy, equals should fail and notEquals should pass
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestedBy", operator: "notEquals", value: "anyone", condition: "AND" },
      ];
      const items = [makeItem("item1", "55")];

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, undefined);
      expect(result.get("item1")!).toHaveLength(1);
    });
  });

  // -- negate flag -----------------------------------------------------------

  describe("negate flag", () => {
    it("inverts seerrRequested equals result when negate is true", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequested", operator: "equals", value: "true", condition: "AND", negate: true },
      ];
      const items = [makeItem("item1", "99")];
      const seerrData = makeSeerrData("99", { requested: true });

      // Without negate this would match, but with negate it should not
      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });

    it("negate turns a non-match into a match", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequested", operator: "equals", value: "true", condition: "AND", negate: true },
      ];
      const items = [makeItem("item1", "99")];
      const seerrData = makeSeerrData("99", { requested: false });

      // Without negate this would NOT match (false !== true), but with negate it should match
      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("negate works for seerrRequestCount", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestCount", operator: "greaterThan", value: "5", condition: "AND", negate: true },
      ];
      const items = [makeItem("item1", "99")];
      const seerrData = makeSeerrData("99", { requestCount: 10 });

      // 10 > 5 is true, but negate inverts to false
      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")).toEqual([]);
    });
  });

  // -- SERIES type uses TVDB for seerr lookup --------------------------------

  describe("SERIES type uses TVDB ID for seerr lookup", () => {
    it("looks up seerr data by TVDB ID for series", () => {
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequested", operator: "equals", value: "true", condition: "AND" },
      ];
      const items = [
        {
          id: "item1",
          externalIds: [
            { source: "TMDB", externalId: "tmdb-999" },
            { source: "TVDB", externalId: "tvdb-123" },
          ],
        },
      ];
      // Seerr data keyed by TVDB ID for series
      const seerrData: SeerrDataMap = {
        "tvdb-123": {
          requested: true,
          requestCount: 2,
          requestDate: "2024-06-01T00:00:00Z",
          requestedBy: ["alice"],
          approvalDate: null,
          declineDate: null,
        },
      };

      const result = getMatchedCriteriaForItems(items, rules, "SERIES", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });
  });

  // -- default operator behavior (unsupported operators return true) ----------

  describe("default operator behavior", () => {
    it("unsupported operator for seerrRequested returns true (match)", () => {
      // "contains" is not a valid operator for seerrRequested (boolean field)
      // The switch default returns result = true
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequested", operator: "contains", value: "true", condition: "AND" },
      ];
      const items = [makeItem("item1", "50")];
      const seerrData = makeSeerrData("50", { requested: true });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });

    it("unsupported operator for seerrRequestCount returns true (match)", () => {
      // "contains" is not valid for numeric fields
      const rules: Rule[] = [
        { id: "r1", field: "seerrRequestCount", operator: "contains", value: "5", condition: "AND" },
      ];
      const items = [makeItem("item1", "50")];
      const seerrData = makeSeerrData("50", { requestCount: 5 });

      const result = getMatchedCriteriaForItems(items, rules, "MOVIE", undefined, seerrData);
      expect(result.get("item1")!).toHaveLength(1);
    });
  });
});
