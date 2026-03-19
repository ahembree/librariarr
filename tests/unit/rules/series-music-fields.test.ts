import { describe, it, expect } from "vitest";
import { getMatchedCriteriaForItems } from "@/lib/rules/engine";
import type { ArrMetadata, ArrDataMap } from "@/lib/rules/engine";
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
  type: "MOVIE" | "SERIES" | "MUSIC" = "SERIES",
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
// Series aggregate date fields
// ---------------------------------------------------------------------------

describe("latestEpisodeViewDate", () => {
  const items = [
    { id: "s1", latestEpisodeViewDate: "2024-08-15T10:00:00Z" },
    { id: "s2", latestEpisodeViewDate: "2023-01-01T00:00:00Z" },
    { id: "s3", latestEpisodeViewDate: null },
  ];

  it("before operator", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "before", value: "2024-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("s1")).toHaveLength(0);
    expect(result.get("s2")!.length).toBeGreaterThan(0);
  });

  it("after operator", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "after", value: "2024-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });

  it("equals (day-level comparison)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "equals", value: "2024-08-15" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });

  it("notEquals works after fix", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "notEquals", value: "2024-08-15" })])];
    const result = matched(items, rules);
    expect(result.get("s1")).toHaveLength(0);
    expect(result.get("s2")!.length).toBeGreaterThan(0);
  });

  it("inLastDays", () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    const recentItems = [
      { id: "r1", latestEpisodeViewDate: recent.toISOString() },
      { id: "r2", latestEpisodeViewDate: "2020-01-01T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "inLastDays", value: "30" })])];
    const result = matched(recentItems, rules);
    expect(result.get("r1")!.length).toBeGreaterThan(0);
    expect(result.get("r2")).toHaveLength(0);
  });

  it("notInLastDays", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "notInLastDays", value: "30" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0); // 2024-08 is more than 30 days ago
    expect(result.get("s2")!.length).toBeGreaterThan(0); // 2023-01 is more than 30 days ago
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "after", value: "2020-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("s3")).toHaveLength(0);
  });
});

describe("lastEpisodeAddedAt", () => {
  const items = [
    { id: "s1", lastEpisodeAddedAt: "2025-01-10T00:00:00Z" },
    { id: "s2", lastEpisodeAddedAt: "2022-06-15T00:00:00Z" },
    { id: "s3", lastEpisodeAddedAt: null },
  ];

  it("before operator", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAddedAt", operator: "before", value: "2024-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("s1")).toHaveLength(0);
    expect(result.get("s2")!.length).toBeGreaterThan(0);
  });

  it("after operator", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAddedAt", operator: "after", value: "2024-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });

  it("inLastDays", () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 10);
    const dynamicItems = [
      { id: "r1", lastEpisodeAddedAt: recent.toISOString() },
      { id: "r2", lastEpisodeAddedAt: "2020-01-01T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAddedAt", operator: "inLastDays", value: "30" })])];
    const result = matched(dynamicItems, rules);
    expect(result.get("r1")!.length).toBeGreaterThan(0);
    expect(result.get("r2")).toHaveLength(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAddedAt", operator: "before", value: "2030-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("s3")).toHaveLength(0);
  });
});

describe("lastEpisodeAiredAt", () => {
  // Use dynamic recent date so tests don't break as time passes
  const recentAired = new Date();
  recentAired.setDate(recentAired.getDate() - 10);
  const items = [
    { id: "s1", lastEpisodeAiredAt: recentAired.toISOString() },
    { id: "s2", lastEpisodeAiredAt: "2019-12-31T00:00:00Z" },
    { id: "s3", lastEpisodeAiredAt: null },
  ];

  it("before operator", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAiredAt", operator: "before", value: "2020-06-01" })])];
    const result = matched(items, rules);
    expect(result.get("s1")).toHaveLength(0); // recent date is NOT before 2020
    expect(result.get("s2")!.length).toBeGreaterThan(0); // 2019 IS before 2020-06
  });

  it("after operator", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAiredAt", operator: "after", value: "2024-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0); // recent date is after 2024
    expect(result.get("s2")).toHaveLength(0); // 2019 is NOT after 2024
  });

  it("inLastDays", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAiredAt", operator: "inLastDays", value: "30" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0); // 10 days ago is within 30 days
    expect(result.get("s2")).toHaveLength(0); // 2019 is NOT within 30 days
  });

  it("notInLastDays", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAiredAt", operator: "notInLastDays", value: "30" })])];
    const result = matched(items, rules);
    expect(result.get("s1")).toHaveLength(0); // 10 days ago is within 30 days, so notInLastDays is false
    expect(result.get("s2")!.length).toBeGreaterThan(0); // 2019 is more than 30 days ago
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAiredAt", operator: "after", value: "2000-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("s3")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Series aggregate numeric fields
// ---------------------------------------------------------------------------

describe("availableEpisodeCount", () => {
  const items = [
    { id: "s1", availableEpisodeCount: 50 },
    { id: "s2", availableEpisodeCount: 10 },
    { id: "s3", availableEpisodeCount: 0 },
  ];

  it("equals", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "availableEpisodeCount", operator: "equals", value: "50" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });

  it("greaterThan", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "availableEpisodeCount", operator: "greaterThan", value: "20" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });

  it("lessThan", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "availableEpisodeCount", operator: "lessThan", value: "20" })])];
    const result = matched(items, rules);
    expect(result.get("s1")).toHaveLength(0);
    expect(result.get("s2")!.length).toBeGreaterThan(0);
  });

  it("handles zero", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "availableEpisodeCount", operator: "equals", value: "0" })])];
    const result = matched(items, rules);
    expect(result.get("s3")!.length).toBeGreaterThan(0);
  });
});

describe("watchedEpisodeCount", () => {
  const items = [
    { id: "s1", watchedEpisodeCount: 25 },
    { id: "s2", watchedEpisodeCount: 0 },
  ];

  it("equals 0 for unwatched series", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodeCount", operator: "equals", value: "0" })])];
    const result = matched(items, rules);
    expect(result.get("s1")).toHaveLength(0);
    expect(result.get("s2")!.length).toBeGreaterThan(0);
  });

  it("greaterThan", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodeCount", operator: "greaterThan", value: "10" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });

  it("lessThanOrEqual", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodeCount", operator: "lessThanOrEqual", value: "25" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")!.length).toBeGreaterThan(0);
  });
});

describe("watchedEpisodePercentage", () => {
  const items = [
    { id: "s1", watchedEpisodePercentage: 100 },
    { id: "s2", watchedEpisodePercentage: 50 },
    { id: "s3", watchedEpisodePercentage: 0 },
  ];

  it("equals 100 for fully watched", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodePercentage", operator: "equals", value: "100" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
  });

  it("greaterThan 50", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodePercentage", operator: "greaterThan", value: "50" })])];
    const result = matched(items, rules);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
    expect(result.get("s2")).toHaveLength(0);
    expect(result.get("s3")).toHaveLength(0);
  });

  it("lessThan 25", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodePercentage", operator: "lessThan", value: "25" })])];
    const result = matched(items, rules);
    expect(result.get("s1")).toHaveLength(0);
    expect(result.get("s2")).toHaveLength(0);
    expect(result.get("s3")!.length).toBeGreaterThan(0);
  });

  it("equals 0 for unwatched", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodePercentage", operator: "equals", value: "0" })])];
    const result = matched(items, rules);
    expect(result.get("s3")!.length).toBeGreaterThan(0);
    expect(result.get("s1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SERIES type uses TVDB for Arr lookup
// ---------------------------------------------------------------------------

describe("SERIES type Arr lookup uses TVDB", () => {
  it("looks up arr data by TVDB ID for SERIES", () => {
    const tvdbId = "tvdb-42";
    const items = [{ id: "s1", externalIds: [{ source: "TVDB", externalId: tvdbId }] }];
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(items, rules, "SERIES", arrData);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
  });

  it("does not match TMDB ID for SERIES type", () => {
    const items = [{ id: "s1", externalIds: [{ source: "TMDB", externalId: "tmdb-99" }] }];
    const arrData: ArrDataMap = { "tmdb-99": makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(items, rules, "SERIES", arrData);
    // SERIES uses TVDB, not TMDB, so arr data won't be found
    expect(result.get("s1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MUSIC type uses MUSICBRAINZ for Arr lookup
// ---------------------------------------------------------------------------

describe("MUSIC type Arr lookup uses MUSICBRAINZ", () => {
  it("looks up arr data by MUSICBRAINZ ID for MUSIC", () => {
    const mbId = "mb-abc-123";
    const items = [{ id: "m1", externalIds: [{ source: "MUSICBRAINZ", externalId: mbId }] }];
    const arrData: ArrDataMap = { [mbId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(items, rules, "MUSIC", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("does not match TMDB ID for MUSIC type", () => {
    const items = [{ id: "m1", externalIds: [{ source: "TMDB", externalId: "tmdb-55" }] }];
    const arrData: ArrDataMap = { "tmdb-55": makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(items, rules, "MUSIC", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Negate flag on series aggregate fields
// ---------------------------------------------------------------------------

describe("Negate flag on series aggregate fields", () => {
  it("negate inverts watchedEpisodePercentage greaterThan", () => {
    const items = [{ id: "s1", watchedEpisodePercentage: 80 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodePercentage", operator: "greaterThan", value: "50", negate: true })])];
    const result = matched(items, rules);
    // 80 > 50 is true, negate makes it false
    expect(result.get("s1")).toHaveLength(0);
  });

  it("negate inverts latestEpisodeViewDate before", () => {
    const items = [{ id: "s1", latestEpisodeViewDate: "2020-01-01T00:00:00Z" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "before", value: "2024-01-01", negate: true })])];
    const result = matched(items, rules);
    // 2020 < 2024 is true, negate makes it false
    expect(result.get("s1")).toHaveLength(0);
  });

  it("negate makes failing rule pass", () => {
    const items = [{ id: "s1", watchedEpisodePercentage: 20 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodePercentage", operator: "greaterThan", value: "50", negate: true })])];
    const result = matched(items, rules);
    // 20 > 50 is false, negate makes it true
    expect(result.get("s1")!.length).toBeGreaterThan(0);
  });
});
