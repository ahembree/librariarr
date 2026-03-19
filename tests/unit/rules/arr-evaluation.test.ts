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

function matched(
  items: Array<Record<string, unknown>>,
  rules: Rule[] | RuleGroup[],
  type: "MOVIE" | "SERIES" | "MUSIC" = "MOVIE",
  arrData?: ArrDataMap,
): Map<string, unknown[]> {
  return getMatchedCriteriaForItems(items, rules, type, arrData);
}

// Dynamic dates for inLastDays / notInLastDays tests
const recentDate = new Date();
recentDate.setDate(recentDate.getDate() - 5);
const oldDate = new Date();
oldDate.setDate(oldDate.getDate() - 60);

// Standard items keyed by external ID source
const tmdbId = "tmdb-100";
const movieItems = [{ id: "m1", externalIds: [{ source: "TMDB", externalId: tmdbId }] }];

const tvdbId = "tvdb-200";
const seriesItems = [{ id: "s1", externalIds: [{ source: "TVDB", externalId: tvdbId }] }];

const mbId = "mb-300";
const musicItems = [{ id: "mu1", externalIds: [{ source: "MUSICBRAINZ", externalId: mbId }] }];

// ===========================================================================
// 1. arrTag — text array field
// ===========================================================================

describe("arrTag (text array)", () => {
  const meta = makeArrMeta({ tags: ["Upgrade", "Keep", "4K-Movies"] });
  const arrData: ArrDataMap = { [tmdbId]: meta };

  it("equals matches when tag exists (case-insensitive)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "equals", value: "upgrade" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("equals does not match absent tag", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "equals", value: "missing" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("notEquals matches when tag is absent", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "notEquals", value: "missing" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals does not match when tag exists", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "notEquals", value: "keep" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("contains matches partial substring", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "contains", value: "grad" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("notContains does not match when substring present", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "notContains", value: "grad" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("matchesWildcard matches with pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "matchesWildcard", value: "4K-*" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("notMatchesWildcard does not match when pattern matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "notMatchesWildcard", value: "4K-*" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("returns false with empty tags", () => {
    const emptyMeta = makeArrMeta({ tags: [] });
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "equals", value: "anything" })])];
    const result = matched(movieItems, rules, "MOVIE", { [tmdbId]: emptyMeta });
    expect(result.get("m1")).toHaveLength(0);
  });

  it("returns false with no metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "equals", value: "anything" })])];
    const result = matched(movieItems, rules, "MOVIE", {});
    expect(result.get("m1")).toHaveLength(0);
  });
});

// ===========================================================================
// 2. arrQualityProfile — text field
// ===========================================================================

describe("arrQualityProfile (text)", () => {
  const meta = makeArrMeta({ qualityProfile: "Ultra-HD" });
  const arrData: ArrDataMap = { [tmdbId]: meta };

  it("equals matches case-insensitively", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityProfile", operator: "equals", value: "ultra-hd" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("equals does not match different profile", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityProfile", operator: "equals", value: "SD" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("notEquals matches different profile", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityProfile", operator: "notEquals", value: "SD" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals does not match same profile", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityProfile", operator: "notEquals", value: "ultra-hd" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("contains matches substring", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityProfile", operator: "contains", value: "ultra" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("notContains matches when substring absent", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityProfile", operator: "notContains", value: "bluray" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("matchesWildcard matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityProfile", operator: "matchesWildcard", value: "Ultra*" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("notMatchesWildcard does not match when pattern matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityProfile", operator: "notMatchesWildcard", value: "Ultra*" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });
});

// ===========================================================================
// 3. arrMonitored — boolean field
// ===========================================================================

describe("arrMonitored (boolean)", () => {
  it("equals true matches monitored item", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("equals true does not match unmonitored item", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitored: false }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("notEquals true matches unmonitored item", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitored: false }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "notEquals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals false matches monitored item", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "notEquals", value: "false" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 4. arrRating, arrTmdbRating, arrRtCriticRating — numeric nullable
// ===========================================================================

describe("arrRating (numeric, nullable)", () => {
  const meta = makeArrMeta({ rating: 7.5 });
  const arrData: ArrDataMap = { [tmdbId]: meta };

  it("equals matches exact value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRating", operator: "equals", value: 7.5 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals matches different value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRating", operator: "notEquals", value: 5 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("greaterThan matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRating", operator: "greaterThan", value: 7 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("greaterThanOrEqual matches at boundary", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRating", operator: "greaterThanOrEqual", value: 7.5 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("lessThan matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRating", operator: "lessThan", value: 8 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("lessThanOrEqual matches at boundary", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRating", operator: "lessThanOrEqual", value: 7.5 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when rating is null", () => {
    const nullMeta = makeArrMeta({ rating: null });
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRating", operator: "greaterThan", value: 0 })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: nullMeta }).get("m1")).toHaveLength(0);
  });
});

describe("arrTmdbRating (numeric, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ tmdbRating: 8.2 }) };

  it("greaterThan matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTmdbRating", operator: "greaterThan", value: 8 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("lessThanOrEqual does not match above value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTmdbRating", operator: "lessThanOrEqual", value: 8 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTmdbRating", operator: "equals", value: 0 })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrRtCriticRating (numeric, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ rtCriticRating: 92 }) };

  it("greaterThanOrEqual matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRtCriticRating", operator: "greaterThanOrEqual", value: 90 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("equals does not match different value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRtCriticRating", operator: "equals", value: 50 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRtCriticRating", operator: "lessThan", value: 100 })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

// ===========================================================================
// 5. arrSizeOnDisk — numeric, bytes→MB conversion
// ===========================================================================

describe("arrSizeOnDisk (numeric, bytes→MB)", () => {
  // 500 MB = 500 * 1024 * 1024 bytes
  const sizeBytes = 500 * 1024 * 1024;
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ sizeOnDisk: sizeBytes }) };

  it("equals matches when value in MB matches converted size", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSizeOnDisk", operator: "equals", value: 500 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("greaterThan matches when size exceeds threshold", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSizeOnDisk", operator: "greaterThan", value: 400 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("greaterThan does not match when size is below", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSizeOnDisk", operator: "greaterThan", value: 600 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("lessThan matches when size is below threshold", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSizeOnDisk", operator: "lessThan", value: 600 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("lessThanOrEqual matches at exact boundary", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSizeOnDisk", operator: "lessThanOrEqual", value: 500 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals matches different size", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSizeOnDisk", operator: "notEquals", value: 999 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when sizeOnDisk is null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSizeOnDisk", operator: "greaterThan", value: 0 })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

// ===========================================================================
// 6. arrRuntime, arrSeasonCount, arrEpisodeCount,
//    arrMonitoredSeasonCount, arrMonitoredEpisodeCount — numeric nullable
// ===========================================================================

describe("arrRuntime (numeric, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ runtime: 120 }) };

  it("greaterThan matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRuntime", operator: "greaterThan", value: 90 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("lessThan does not match when value is below runtime", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRuntime", operator: "lessThan", value: 100 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("equals matches exact value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRuntime", operator: "equals", value: 120 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRuntime", operator: "greaterThan", value: 0 })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrSeasonCount (numeric, nullable)", () => {
  const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ seasonCount: 5 }) };

  it("greaterThanOrEqual matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeasonCount", operator: "greaterThanOrEqual", value: 5 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("lessThan matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeasonCount", operator: "lessThan", value: 10 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeasonCount", operator: "equals", value: 0 })])];
    expect(matched(seriesItems, rules, "SERIES", { [tvdbId]: makeArrMeta() }).get("s1")).toHaveLength(0);
  });
});

describe("arrEpisodeCount (numeric, nullable)", () => {
  const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ episodeCount: 50 }) };

  it("equals matches exact value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrEpisodeCount", operator: "equals", value: 50 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("greaterThan does not match when below", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrEpisodeCount", operator: "greaterThan", value: 100 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")).toHaveLength(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrEpisodeCount", operator: "lessThan", value: 999 })])];
    expect(matched(seriesItems, rules, "SERIES", { [tvdbId]: makeArrMeta() }).get("s1")).toHaveLength(0);
  });
});

describe("arrMonitoredSeasonCount (numeric, nullable)", () => {
  const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ monitoredSeasonCount: 3 }) };

  it("lessThanOrEqual matches at boundary", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitoredSeasonCount", operator: "lessThanOrEqual", value: 3 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("notEquals matches different value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitoredSeasonCount", operator: "notEquals", value: 10 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitoredSeasonCount", operator: "equals", value: 0 })])];
    expect(matched(seriesItems, rules, "SERIES", { [tvdbId]: makeArrMeta() }).get("s1")).toHaveLength(0);
  });
});

describe("arrMonitoredEpisodeCount (numeric, nullable)", () => {
  const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ monitoredEpisodeCount: 25 }) };

  it("greaterThan matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitoredEpisodeCount", operator: "greaterThan", value: 20 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("equals does not match different value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitoredEpisodeCount", operator: "equals", value: 30 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")).toHaveLength(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitoredEpisodeCount", operator: "greaterThan", value: 0 })])];
    expect(matched(seriesItems, rules, "SERIES", { [tvdbId]: makeArrMeta() }).get("s1")).toHaveLength(0);
  });
});

// ===========================================================================
// 7. Date fields — arrDateAdded, arrReleaseDate, arrInCinemasDate,
//    arrDownloadDate, arrFirstAired
// ===========================================================================

describe("arrDateAdded (date, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ dateAdded: "2024-06-15T10:00:00Z" }) };

  it("before matches when date is before value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "before", value: "2024-12-01" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("after matches when date is after value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "after", value: "2024-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("after does not match when date is before value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "after", value: "2025-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("equals matches same calendar day", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "equals", value: "2024-06-15" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals matches different day", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "notEquals", value: "2024-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals does not match same day", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "notEquals", value: "2024-06-15" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("inLastDays matches recent date", () => {
    const recentArr: ArrDataMap = { [tmdbId]: makeArrMeta({ dateAdded: recentDate.toISOString() }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "inLastDays", value: 10 })])];
    expect(matched(movieItems, rules, "MOVIE", recentArr).get("m1")!.length).toBeGreaterThan(0);
  });

  it("inLastDays does not match old date", () => {
    const oldArr: ArrDataMap = { [tmdbId]: makeArrMeta({ dateAdded: oldDate.toISOString() }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "inLastDays", value: 10 })])];
    expect(matched(movieItems, rules, "MOVIE", oldArr).get("m1")).toHaveLength(0);
  });

  it("notInLastDays matches old date", () => {
    const oldArr: ArrDataMap = { [tmdbId]: makeArrMeta({ dateAdded: oldDate.toISOString() }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "notInLastDays", value: 30 })])];
    expect(matched(movieItems, rules, "MOVIE", oldArr).get("m1")!.length).toBeGreaterThan(0);
  });

  it("notInLastDays does not match recent date", () => {
    const recentArr: ArrDataMap = { [tmdbId]: makeArrMeta({ dateAdded: recentDate.toISOString() }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "notInLastDays", value: 30 })])];
    expect(matched(movieItems, rules, "MOVIE", recentArr).get("m1")).toHaveLength(0);
  });

  it("returns false when dateAdded is null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "after", value: "2020-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrReleaseDate (date, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ releaseDate: "2023-07-04T00:00:00Z" }) };

  it("before matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrReleaseDate", operator: "before", value: "2024-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("after does not match when date is before", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrReleaseDate", operator: "after", value: "2024-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("equals matches same day", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrReleaseDate", operator: "equals", value: "2023-07-04" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrReleaseDate", operator: "before", value: "2030-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrInCinemasDate (date, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ inCinemasDate: "2023-03-01T00:00:00Z" }) };

  it("after matches when date is after value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrInCinemasDate", operator: "after", value: "2023-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals matches different day", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrInCinemasDate", operator: "notEquals", value: "2023-06-15" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrInCinemasDate", operator: "equals", value: "2023-03-01" })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrDownloadDate (date, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ downloadDate: "2024-02-20T12:00:00Z" }) };

  it("before matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDownloadDate", operator: "before", value: "2024-06-01" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("equals matches same day", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDownloadDate", operator: "equals", value: "2024-02-20" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("inLastDays matches recent download", () => {
    const recentArr: ArrDataMap = { [tmdbId]: makeArrMeta({ downloadDate: recentDate.toISOString() }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDownloadDate", operator: "inLastDays", value: 10 })])];
    expect(matched(movieItems, rules, "MOVIE", recentArr).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDownloadDate", operator: "after", value: "2020-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrFirstAired (date, nullable)", () => {
  const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ firstAired: "2020-01-15T00:00:00Z" }) };

  it("before matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrFirstAired", operator: "before", value: "2021-01-01" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("after does not match when date is before value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrFirstAired", operator: "after", value: "2022-01-01" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")).toHaveLength(0);
  });

  it("notInLastDays matches old date", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrFirstAired", operator: "notInLastDays", value: 30 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrFirstAired", operator: "before", value: "2030-01-01" })])];
    expect(matched(seriesItems, rules, "SERIES", { [tvdbId]: makeArrMeta() }).get("s1")).toHaveLength(0);
  });
});

// ===========================================================================
// 8. Boolean nullable fields — arrQualityCutoffMet, arrEnded, arrHasUnaired
// ===========================================================================

describe("arrQualityCutoffMet (boolean, nullable)", () => {
  it("equals true matches when cutoff is met", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ qualityCutoffMet: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityCutoffMet", operator: "equals", value: "true" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("equals true does not match when cutoff is not met", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ qualityCutoffMet: false }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityCutoffMet", operator: "equals", value: "true" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("notEquals true matches when cutoff is not met", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ qualityCutoffMet: false }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityCutoffMet", operator: "notEquals", value: "true" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityCutoffMet", operator: "equals", value: "true" })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrEnded (boolean, nullable)", () => {
  it("equals true matches ended series", () => {
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ ended: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrEnded", operator: "equals", value: "true" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("notEquals false matches ended series", () => {
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ ended: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrEnded", operator: "notEquals", value: "false" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrEnded", operator: "equals", value: "true" })])];
    expect(matched(seriesItems, rules, "SERIES", { [tvdbId]: makeArrMeta() }).get("s1")).toHaveLength(0);
  });
});

describe("arrHasUnaired (boolean, nullable)", () => {
  it("equals true matches when has unaired", () => {
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ hasUnaired: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrHasUnaired", operator: "equals", value: "true" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("equals false matches when no unaired", () => {
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ hasUnaired: false }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrHasUnaired", operator: "equals", value: "false" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrHasUnaired", operator: "equals", value: "false" })])];
    expect(matched(seriesItems, rules, "SERIES", { [tvdbId]: makeArrMeta() }).get("s1")).toHaveLength(0);
  });
});

// ===========================================================================
// 9. Text nullable fields — arrPath, arrOriginalLanguage, arrQualityName,
//    arrStatus, arrSeriesType
// ===========================================================================

describe("arrPath (text, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ path: "/movies/Action/The Matrix (1999)" }) };

  it("equals matches exact path (case-insensitive)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrPath", operator: "equals", value: "/movies/action/the matrix (1999)" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals matches different path", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrPath", operator: "notEquals", value: "/movies/comedy" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("contains matches substring", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrPath", operator: "contains", value: "matrix" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("matchesWildcard matches pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrPath", operator: "matchesWildcard", value: "/movies/*/The*" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrPath", operator: "contains", value: "anything" })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrOriginalLanguage (text, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ originalLanguage: "English" }) };

  it("equals matches case-insensitively", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrOriginalLanguage", operator: "equals", value: "english" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("notEquals matches different language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrOriginalLanguage", operator: "notEquals", value: "french" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("contains matches substring", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrOriginalLanguage", operator: "contains", value: "eng" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("notContains matches when substring absent", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrOriginalLanguage", operator: "notContains", value: "fre" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrOriginalLanguage", operator: "equals", value: "english" })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrQualityName (text, nullable)", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ qualityName: "Bluray-2160p Remux" }) };

  it("equals matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityName", operator: "equals", value: "bluray-2160p remux" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("contains matches substring", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityName", operator: "contains", value: "2160p" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("matchesWildcard matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityName", operator: "matchesWildcard", value: "Bluray*Remux" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityName", operator: "contains", value: "bluray" })])];
    expect(matched(movieItems, rules, "MOVIE", { [tmdbId]: makeArrMeta() }).get("m1")).toHaveLength(0);
  });
});

describe("arrStatus (text, nullable)", () => {
  const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ status: "Continuing" }) };

  it("equals matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrStatus", operator: "equals", value: "continuing" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("notEquals matches different status", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrStatus", operator: "notEquals", value: "ended" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("contains matches substring", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrStatus", operator: "contains", value: "contin" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("matchesWildcard matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrStatus", operator: "matchesWildcard", value: "Cont*" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrStatus", operator: "equals", value: "continuing" })])];
    expect(matched(seriesItems, rules, "SERIES", { [tvdbId]: makeArrMeta() }).get("s1")).toHaveLength(0);
  });
});

describe("arrSeriesType (text, nullable)", () => {
  const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ seriesType: "Standard" }) };

  it("equals matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeriesType", operator: "equals", value: "standard" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("notEquals matches different type", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeriesType", operator: "notEquals", value: "anime" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("contains matches substring", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeriesType", operator: "contains", value: "stand" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("matchesWildcard matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeriesType", operator: "matchesWildcard", value: "St?ndard" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")!.length).toBeGreaterThan(0);
  });

  it("returns false when null", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeriesType", operator: "equals", value: "standard" })])];
    expect(matched(seriesItems, rules, "SERIES", { [tvdbId]: makeArrMeta() }).get("s1")).toHaveLength(0);
  });
});

// ===========================================================================
// 10. External ID source by type — SERIES uses TVDB, MUSIC uses MUSICBRAINZ
// ===========================================================================

describe("External ID source by type", () => {
  it("SERIES uses TVDB for arr lookup", () => {
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(seriesItems, rules, "SERIES", arrData);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
  });

  it("SERIES does not use TMDB for arr lookup", () => {
    // arrData keyed by TMDB ID should not match for series items that only have TVDB
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(seriesItems, rules, "SERIES", arrData);
    expect(result.get("s1")).toHaveLength(0);
  });

  it("MUSIC uses MUSICBRAINZ for arr lookup", () => {
    const arrData: ArrDataMap = { [mbId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(musicItems, rules, "MUSIC", arrData);
    expect(result.get("mu1")!.length).toBeGreaterThan(0);
  });

  it("MUSIC does not use TMDB for arr lookup", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(musicItems, rules, "MUSIC", arrData);
    expect(result.get("mu1")).toHaveLength(0);
  });

  it("MOVIE uses TMDB for arr lookup", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitored: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 11. No arr metadata → all arr rules return false
// ===========================================================================

describe("No arr metadata", () => {
  it("returns false for any arr rule when arrData is undefined", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", undefined);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("returns false for any arr rule when arrData is empty map", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRating", operator: "greaterThan", value: 0 })])];
    const result = matched(movieItems, rules, "MOVIE", {});
    expect(result.get("m1")).toHaveLength(0);
  });

  it("returns false for arr text rule when no metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrPath", operator: "contains", value: "movies" })])];
    const result = matched(movieItems, rules, "MOVIE", {});
    expect(result.get("m1")).toHaveLength(0);
  });

  it("returns false for arr date rule when no metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "after", value: "2020-01-01" })])];
    const result = matched(movieItems, rules, "MOVIE", {});
    expect(result.get("m1")).toHaveLength(0);
  });

  it("returns false for arr boolean rule when no metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityCutoffMet", operator: "equals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", {});
    expect(result.get("m1")).toHaveLength(0);
  });
});

// ===========================================================================
// 12. Negate flag
// ===========================================================================

describe("Negate flag on arr fields", () => {
  const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitored: true, rating: 8, path: "/movies/Test" }) };

  it("negate inverts arrMonitored equals true → false", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true", negate: true })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("negate inverts arrMonitored equals false → true (item is monitored)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "false", negate: true })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("negate inverts arrRating greaterThan", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRating", operator: "greaterThan", value: 5, negate: true })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    // Rating 8 > 5 is true, negate makes it false
    expect(result.get("m1")).toHaveLength(0);
  });

  it("negate inverts arrPath contains", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrPath", operator: "contains", value: "movies", negate: true })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    // Path contains "movies" is true, negate makes it false
    expect(result.get("m1")).toHaveLength(0);
  });

  it("negate inverts arrTag equals absent tag → true", () => {
    const tagData: ArrDataMap = { [tmdbId]: makeArrMeta({ tags: ["Keep"] }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrTag", operator: "equals", value: "Delete", negate: true })])];
    const result = matched(movieItems, rules, "MOVIE", tagData);
    // "Delete" not in tags → false, negate → true
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("negate on arrQualityCutoffMet", () => {
    const cutoffData: ArrDataMap = { [tmdbId]: makeArrMeta({ qualityCutoffMet: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrQualityCutoffMet", operator: "equals", value: "true", negate: true })])];
    const result = matched(movieItems, rules, "MOVIE", cutoffData);
    // true === true → true, negate → false
    expect(result.get("m1")).toHaveLength(0);
  });

  it("negate on arr date field", () => {
    const dateData: ArrDataMap = { [tmdbId]: makeArrMeta({ dateAdded: "2024-01-15T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDateAdded", operator: "before", value: "2025-01-01", negate: true })])];
    const result = matched(movieItems, rules, "MOVIE", dateData);
    // 2024-01-15 < 2025-01-01 → true, negate → false
    expect(result.get("m1")).toHaveLength(0);
  });

  it("negate on arrSizeOnDisk", () => {
    const sizeData: ArrDataMap = { [tmdbId]: makeArrMeta({ sizeOnDisk: 1000 * 1024 * 1024 }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSizeOnDisk", operator: "greaterThan", value: 500, negate: true })])];
    const result = matched(movieItems, rules, "MOVIE", sizeData);
    // 1000 MB > 500 → true, negate → false
    expect(result.get("m1")).toHaveLength(0);
  });
});

// ===========================================================================
// foundInArr — boolean presence check
// ===========================================================================

describe("foundInArr (boolean presence check)", () => {
  const meta = makeArrMeta({ arrId: 42 });
  const arrData: ArrDataMap = { [tmdbId]: meta };

  it("equals true matches when item has Arr metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "equals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("equals true does NOT match when item has no Arr metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "equals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", {});
    expect(result.get("m1")).toHaveLength(0);
  });

  it("equals false matches when item has no Arr metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "equals", value: "false" })])];
    const result = matched(movieItems, rules, "MOVIE", {});
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("equals false does NOT match when item has Arr metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "equals", value: "false" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("notEquals true does NOT match when item has Arr metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "notEquals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    expect(result.get("m1")).toHaveLength(0);
  });

  it("notEquals true matches when item has no Arr metadata", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "notEquals", value: "true" })])];
    const result = matched(movieItems, rules, "MOVIE", {});
    expect(result.get("m1")!.length).toBeGreaterThan(0);
  });

  it("negate inverts the result", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "equals", value: "true", negate: true })])];
    const result = matched(movieItems, rules, "MOVIE", arrData);
    // found=true matches equals true, but negate inverts → false
    expect(result.get("m1")).toHaveLength(0);
  });

  it("works for series items via TVDB", () => {
    const seriesArrData: ArrDataMap = { [tvdbId]: meta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "equals", value: "true" })])];
    const result = matched(seriesItems, rules, "SERIES", seriesArrData);
    expect(result.get("s1")!.length).toBeGreaterThan(0);
  });

  it("works for music items via MUSICBRAINZ", () => {
    const musicArrData: ArrDataMap = { [mbId]: meta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "equals", value: "true" })])];
    const result = matched(musicItems, rules, "MUSIC", musicArrData);
    expect(result.get("mu1")!.length).toBeGreaterThan(0);
  });

  it("item without external IDs is not found in Arr", () => {
    const noExternalIdItems = [{ id: "n1", externalIds: [] }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "foundInArr", operator: "equals", value: "false" })])];
    const result = matched(noExternalIdItems, rules, "MOVIE", arrData);
    expect(result.get("n1")!.length).toBeGreaterThan(0);
  });
});
