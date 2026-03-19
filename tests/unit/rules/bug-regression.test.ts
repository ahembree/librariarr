import { describe, it, expect } from "vitest";
import { getMatchedCriteriaForItems } from "@/lib/rules/engine";
import type { ArrMetadata, ArrDataMap, SeerrMetadata, SeerrDataMap } from "@/lib/rules/engine";
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
  seerrData?: SeerrDataMap,
): Map<string, unknown[]> {
  return getMatchedCriteriaForItems(items, rules, type, arrData, seerrData);
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
// Bug 1: genre notEquals should work in-memory
// (Prisma WHERE bug is not testable here since ruleToWhereClause is internal)
// ---------------------------------------------------------------------------

describe("Bug 1: genre notEquals in-memory evaluation", () => {
  const items = [
    { id: "1", genres: ["Action", "Drama"] },
    { id: "2", genres: ["Comedy", "Romance"] },
    { id: "3", genres: [] },
  ];

  it("genre notEquals excludes items that have the genre", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "notEquals", value: "Action" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });

  it("genre notEquals is case-insensitive", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "notEquals", value: "action" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bug 2: date notEquals should work in-memory
// ---------------------------------------------------------------------------

describe("Bug 2: date notEquals in-memory evaluation", () => {
  const items = [
    { id: "match", lastPlayedAt: "2024-06-15T10:00:00Z" },
    { id: "nomatch", lastPlayedAt: "2024-01-15T14:30:00Z" },
    { id: "nulldate", lastPlayedAt: null },
  ];

  it("lastPlayedAt notEquals matches item with different date", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "notEquals", value: "2024-01-15" })])];
    const result = matched(items, rules);
    expect(result.get("match")!.length).toBeGreaterThan(0);
  });

  it("lastPlayedAt notEquals does not match item with same date", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "notEquals", value: "2024-01-15" })])];
    const result = matched(items, rules);
    expect(result.get("nomatch")).toHaveLength(0);
  });

  it("lastPlayedAt notEquals returns false for null dates", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "notEquals", value: "2024-01-15" })])];
    const result = matched(items, rules);
    expect(result.get("nulldate")).toHaveLength(0);
  });

  it("addedAt notEquals matches item with different date", () => {
    const addedItems = [
      { id: "a1", addedAt: "2024-03-01T00:00:00Z" },
      { id: "a2", addedAt: "2024-06-01T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "addedAt", operator: "notEquals", value: "2024-03-01" })])];
    const result = matched(addedItems, rules);
    expect(result.get("a1")).toHaveLength(0);
    expect(result.get("a2")!.length).toBeGreaterThan(0);
  });

  it("originallyAvailableAt notEquals works", () => {
    const releaseItems = [
      { id: "r1", originallyAvailableAt: "2020-05-20T00:00:00Z" },
      { id: "r2", originallyAvailableAt: "2021-12-25T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "originallyAvailableAt", operator: "notEquals", value: "2020-05-20" })])];
    const result = matched(releaseItems, rules);
    expect(result.get("r1")).toHaveLength(0);
    expect(result.get("r2")!.length).toBeGreaterThan(0);
  });

  it("latestEpisodeViewDate notEquals works (series aggregate)", () => {
    const seriesItems = [
      { id: "s1", latestEpisodeViewDate: "2024-08-10T00:00:00Z" },
      { id: "s2", latestEpisodeViewDate: "2024-01-01T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "notEquals", value: "2024-01-01" })])];
    const result = matched(seriesItems, rules, "SERIES");
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });

  it("lastEpisodeAddedAt notEquals works (series aggregate)", () => {
    const seriesItems = [
      { id: "s1", lastEpisodeAddedAt: "2024-09-01T00:00:00Z" },
      { id: "s2", lastEpisodeAddedAt: "2024-03-15T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAddedAt", operator: "notEquals", value: "2024-03-15" })])];
    const result = matched(seriesItems, rules, "SERIES");
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });

  it("lastEpisodeAiredAt notEquals works (series aggregate)", () => {
    const seriesItems = [
      { id: "s1", lastEpisodeAiredAt: "2025-01-20T00:00:00Z" },
      { id: "s2", lastEpisodeAiredAt: "2024-06-01T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAiredAt", operator: "notEquals", value: "2024-06-01" })])];
    const result = matched(seriesItems, rules, "SERIES");
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bug 3: Arr date notEquals should NOT default to true
// ---------------------------------------------------------------------------

describe("Bug 3: Arr date notEquals evaluation", () => {
  const extId = "tmdb-123";
  const items = [{ id: "1", externalIds: [{ source: "TMDB", externalId: extId }] }];

  it("arrDateAdded notEquals matches when dates differ", () => {
    const arrData: ArrDataMap = { [extId]: makeArrMeta({ dateAdded: "2024-01-15T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "notEquals", value: "2024-06-01" })])];
    const result = matched(items, rules, "MOVIE", arrData);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("arrDateAdded notEquals does NOT match same date", () => {
    const arrData: ArrDataMap = { [extId]: makeArrMeta({ dateAdded: "2024-01-15T10:30:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "notEquals", value: "2024-01-15" })])];
    const result = matched(items, rules, "MOVIE", arrData);
    expect(result.get("1")).toHaveLength(0);
  });

  it("arrReleaseDate notEquals does NOT match same date", () => {
    const arrData: ArrDataMap = { [extId]: makeArrMeta({ releaseDate: "2023-07-04T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrReleaseDate", operator: "notEquals", value: "2023-07-04" })])];
    const result = matched(items, rules, "MOVIE", arrData);
    expect(result.get("1")).toHaveLength(0);
  });

  it("arrInCinemasDate notEquals matches when dates differ", () => {
    const arrData: ArrDataMap = { [extId]: makeArrMeta({ inCinemasDate: "2023-03-01T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrInCinemasDate", operator: "notEquals", value: "2023-06-15" })])];
    const result = matched(items, rules, "MOVIE", arrData);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("arrDownloadDate notEquals does NOT match same date", () => {
    const arrData: ArrDataMap = { [extId]: makeArrMeta({ downloadDate: "2024-02-20T12:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDownloadDate", operator: "notEquals", value: "2024-02-20" })])];
    const result = matched(items, rules, "MOVIE", arrData);
    expect(result.get("1")).toHaveLength(0);
  });

  it("arrFirstAired notEquals matches when dates differ (SERIES)", () => {
    const tvdbId = "tvdb-456";
    const seriesItems = [{ id: "1", externalIds: [{ source: "TVDB", externalId: tvdbId }] }];
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ firstAired: "2020-01-01T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrFirstAired", operator: "notEquals", value: "2021-05-05" })])];
    const result = matched(seriesItems, rules, "SERIES", arrData);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bug 4: Seerr date notEquals should NOT default to true
// ---------------------------------------------------------------------------

describe("Bug 4: Seerr date notEquals evaluation", () => {
  const extId = "tmdb-789";
  const items = [{ id: "1", externalIds: [{ source: "TMDB", externalId: extId }] }];

  it("seerrRequestDate notEquals matches when dates differ", () => {
    const seerrData: SeerrDataMap = { [extId]: makeSeerrMeta({ requestDate: "2024-03-01T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestDate", operator: "notEquals", value: "2024-06-01" })])];
    const result = matched(items, rules, "MOVIE", undefined, seerrData);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequestDate notEquals does NOT match same date", () => {
    const seerrData: SeerrDataMap = { [extId]: makeSeerrMeta({ requestDate: "2024-03-01T10:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestDate", operator: "notEquals", value: "2024-03-01" })])];
    const result = matched(items, rules, "MOVIE", undefined, seerrData);
    expect(result.get("1")).toHaveLength(0);
  });

  it("seerrApprovalDate notEquals does NOT match same date", () => {
    const seerrData: SeerrDataMap = { [extId]: makeSeerrMeta({ approvalDate: "2024-04-10T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrApprovalDate", operator: "notEquals", value: "2024-04-10" })])];
    const result = matched(items, rules, "MOVIE", undefined, seerrData);
    expect(result.get("1")).toHaveLength(0);
  });

  it("seerrDeclineDate notEquals matches when dates differ", () => {
    const seerrData: SeerrDataMap = { [extId]: makeSeerrMeta({ declineDate: "2024-05-20T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrDeclineDate", operator: "notEquals", value: "2024-12-25" })])];
    const result = matched(items, rules, "MOVIE", undefined, seerrData);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bug 5: genre case sensitivity (in-memory should be case-insensitive)
// ---------------------------------------------------------------------------

describe("Bug 5: genre case sensitivity in-memory", () => {
  const items = [{ id: "1", genres: ["Action", "Sci-Fi"] }];

  it("genre equals is case-insensitive", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "equals", value: "action" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("genre contains is case-insensitive", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "contains", value: "sci-fi" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("genre notContains is case-insensitive", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "notContains", value: "ACTION" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
  });
});
