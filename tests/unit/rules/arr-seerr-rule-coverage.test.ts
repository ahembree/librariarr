import { describe, it, expect, vi, afterEach } from "vitest";
import {
  evaluateArrRule,
  evaluateSeerrRule,
  lookupSeerrMeta,
  hasAnyActiveRules,
  hasArrRules,
  hasSeerrRules,
  hasStreamRules,
  hasExternalIdFieldRules,
  hasSeriesAggregateRules,
  hasCrossSystemFieldRules,
  hasWatchedByUserRules,
  hasPlayActivityRules,
  type ArrMetadata,
  type SeerrMetadata,
} from "@/lib/rules/lifecycle-engine";
import type { Condition } from "@/lib/conditions/types";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

const MB = 1024 * 1024;

function meta(overrides: Partial<ArrMetadata> = {}): ArrMetadata {
  return {
    arrId: 1,
    tags: ["keep", "4k"],
    qualityProfile: "HD-1080p",
    monitored: true,
    rating: 7.5,
    tmdbRating: 8,
    rtCriticRating: 90,
    dateAdded: "2024-01-10T00:00:00Z",
    path: "/movies/Alien (1979)",
    sizeOnDisk: 2048 * MB,
    originalLanguage: "English",
    releaseDate: "2024-02-01T00:00:00Z",
    inCinemasDate: "2023-12-01T00:00:00Z",
    runtime: 117,
    qualityName: "Bluray-1080p",
    qualityCutoffMet: true,
    customFormatScore: 100,
    downloadDate: "2024-01-11T00:00:00Z",
    firstAired: "2020-05-05T00:00:00Z",
    seasonCount: 3,
    episodeCount: 30,
    status: "ended",
    ended: true,
    seriesType: "standard",
    hasUnaired: false,
    monitoredSeasonCount: 2,
    monitoredEpisodeCount: 20,
    ...overrides,
  };
}

function nullMeta(): ArrMetadata {
  return meta({
    rating: null, tmdbRating: null, rtCriticRating: null, dateAdded: null, path: null,
    sizeOnDisk: null, originalLanguage: null, releaseDate: null, inCinemasDate: null,
    runtime: null, qualityName: null, qualityCutoffMet: null, customFormatScore: null,
    downloadDate: null, firstAired: null, seasonCount: null, episodeCount: null,
    status: null, ended: null, seriesType: null, hasUnaired: null,
    monitoredSeasonCount: null, monitoredEpisodeCount: null,
  });
}

function r(field: string, operator: string, value: string | number = "", negate?: boolean): Condition {
  return { id: "r", field, operator, value, condition: "AND", negate };
}

/** `null` = no Arr metadata (a default parameter would swallow `undefined`). */
const arr = (field: string, operator: string, value: string | number = "", m: ArrMetadata | null = meta(), negate?: boolean) =>
  evaluateArrRule(r(field, operator, value, negate), m ?? undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe("evaluateArrRule — guards", () => {
  it("refuses unconfigured, inapplicable and malformed rules even when negated", () => {
    expect(arr("arrTag", "contains", "", meta(), true)).toBe(false);
    expect(arr("arrRating", "contains", "x", meta(), true)).toBe(false);
    expect(arr("arrRating", "greaterThan", "abc", meta(), true)).toBe(false);
  });

  it("foundInArr presence checks", () => {
    expect(arr("foundInArr", "equals", "true")).toBe(true);
    expect(arr("foundInArr", "equals", "true", null)).toBe(false);
    expect(arr("foundInArr", "notEquals", "true", null)).toBe(true);
    expect(arr("foundInArr", "equals", "false", meta(), true)).toBe(true);
    expect(arr("foundInArr", "isNull", "", null)).toBe(true);
    expect(arr("foundInArr", "isNull", "", null, true)).toBe(false);
    expect(arr("foundInArr", "isNotNull", "", meta())).toBe(true);
    expect(arr("foundInArr", "isNotNull", "", meta(), true)).toBe(false);
  });

  it("any other field without metadata never matches, even negated", () => {
    expect(arr("arrMonitored", "equals", "false", null, true)).toBe(false);
  });

  it("an Arr field with no evaluator branch matches nothing", () => {
    // Not an Arr field at all — passes the type guards (number) but has no case.
    expect(arr("year", "equals", "1", meta(), true)).toBe(false);
  });
});

describe("evaluateArrRule — tags and quality profile", () => {
  it("tags use name-list semantics", () => {
    expect(arr("arrTag", "contains", "KEEP")).toBe(true);
    expect(arr("arrTag", "contains", "keep", meta(), true)).toBe(false);
    expect(arr("arrTag", "isNull", "", meta({ tags: [] }))).toBe(true);
  });

  it("quality profile operators", () => {
    expect(arr("arrQualityProfile", "isNull", "", meta({ qualityProfile: "" }))).toBe(true);
    expect(arr("arrQualityProfile", "isNotNull")).toBe(true);
    expect(arr("arrQualityProfile", "equals", "hd-1080P")).toBe(true);
    expect(arr("arrQualityProfile", "notEquals", "Any")).toBe(true);
    expect(arr("arrQualityProfile", "contains", "Any|HD-1080p")).toBe(true);
    expect(arr("arrQualityProfile", "contains", "HD")).toBe(false);
    expect(arr("arrQualityProfile", "notContains", "Any|Ultra")).toBe(true);
    expect(arr("arrQualityProfile", "matchesWildcard", "hd-*")).toBe(true);
    expect(arr("arrQualityProfile", "notMatchesWildcard", "*720p")).toBe(true);
    expect(arr("arrQualityProfile", "equals", "Any", meta(), true)).toBe(true);
  });
});

describe("evaluateArrRule — monitored", () => {
  it("non-nullable boolean semantics", () => {
    expect(arr("arrMonitored", "isNull")).toBe(false);
    expect(arr("arrMonitored", "isNotNull")).toBe(true);
    expect(arr("arrMonitored", "isNull", "", meta(), true)).toBe(true);
    expect(arr("arrMonitored", "equals", "TRUE")).toBe(true);
    expect(arr("arrMonitored", "notEquals", "true")).toBe(false);
  });
});

describe("evaluateArrRule — numeric ratings", () => {
  const fields: Array<[string, keyof ArrMetadata, number]> = [
    ["arrRating", "rating", 7.5],
    ["arrTmdbRating", "tmdbRating", 8],
    ["arrRtCriticRating", "rtCriticRating", 90],
  ];
  it.each(fields)("%s operators and nulls", (field, key, v) => {
    expect(arr(field, "equals", String(v))).toBe(true);
    expect(arr(field, "notEquals", String(v))).toBe(false);
    expect(arr(field, "greaterThan", String(v - 1))).toBe(true);
    expect(arr(field, "greaterThanOrEqual", String(v))).toBe(true);
    expect(arr(field, "lessThan", String(v))).toBe(false);
    expect(arr(field, "lessThanOrEqual", String(v))).toBe(true);
    expect(arr(field, "between", `${v - 1},${v + 1}`)).toBe(true);
    expect(arr(field, "between", `${v + 1},${v + 2}`)).toBe(false);
    expect(arr(field, "isNull")).toBe(false);
    expect(arr(field, "isNotNull")).toBe(true);
    const nm = meta({ [key]: null } as Partial<ArrMetadata>);
    expect(arr(field, "isNull", "", nm)).toBe(true);
    expect(arr(field, "isNotNull", "", nm)).toBe(false);
    // Fail-closed: a null value matches no comparison, even negated.
    expect(arr(field, "greaterThan", "0", nm, true)).toBe(false);
    expect(arr(field, "notEquals", "1", nm)).toBe(false);
  });
});

describe("evaluateArrRule — dates", () => {
  const fields = ["arrDateAdded", "arrReleaseDate", "arrInCinemasDate", "arrDownloadDate", "arrFirstAired"];
  it.each(fields)("%s null handling", (field) => {
    expect(arr(field, "isNull", "", nullMeta())).toBe(true);
    expect(arr(field, "isNotNull", "", nullMeta())).toBe(false);
    expect(arr(field, "isNull")).toBe(false);
    expect(arr(field, "isNotNull")).toBe(true);
    expect(arr(field, "before", "2030-01-01", nullMeta(), true)).toBe(false);
  });

  it("an unparseable stored date reads as empty", () => {
    expect(arr("arrDateAdded", "isNull", "", meta({ dateAdded: "garbage" }))).toBe(true);
    expect(arr("arrDateAdded", "after", "2000-01-01", meta({ dateAdded: "garbage" }))).toBe(false);
  });

  it("comparisons on arrDateAdded (2024-01-10)", () => {
    expect(arr("arrDateAdded", "before", "2024-02-01")).toBe(true);
    expect(arr("arrDateAdded", "after", "2024-02-01")).toBe(false);
    expect(arr("arrDateAdded", "equals", "2024-01-10")).toBe(true);
    expect(arr("arrDateAdded", "notEquals", "2024-01-10")).toBe(false);
    expect(arr("arrDateAdded", "between", "2024-1-1,2024-1-31")).toBe(true);
    expect(arr("arrDateAdded", "between", "2024-02-01,2024-03-01")).toBe(false);
    expect(arr("arrDateAdded", "equals", "2024-01-10", meta(), true)).toBe(false);
  });

  it("rolling windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T00:00:00Z"));
    expect(arr("arrDateAdded", "inLastDays", "30")).toBe(true);
    expect(arr("arrDateAdded", "inLastDays", "5")).toBe(false);
    expect(arr("arrDateAdded", "notInLastDays", "5")).toBe(true);
    expect(arr("arrDownloadDate", "notInLastDays", "30")).toBe(false);
  });
});

describe("evaluateArrRule — size on disk", () => {
  it("compares in MB", () => {
    expect(arr("arrSizeOnDisk", "equals", "2048")).toBe(true);
    expect(arr("arrSizeOnDisk", "notEquals", "2048")).toBe(false);
    expect(arr("arrSizeOnDisk", "greaterThan", "1000")).toBe(true);
    expect(arr("arrSizeOnDisk", "greaterThanOrEqual", "2048")).toBe(true);
    expect(arr("arrSizeOnDisk", "lessThan", "1000")).toBe(false);
    expect(arr("arrSizeOnDisk", "lessThanOrEqual", "2048")).toBe(true);
    expect(arr("arrSizeOnDisk", "between", "2000,3000")).toBe(true);
    expect(arr("arrSizeOnDisk", "isNull")).toBe(false);
    expect(arr("arrSizeOnDisk", "isNotNull", "", nullMeta())).toBe(false);
    expect(arr("arrSizeOnDisk", "isNull", "", nullMeta())).toBe(true);
    expect(arr("arrSizeOnDisk", "lessThan", "1", nullMeta(), true)).toBe(false);
  });
});

describe("evaluateArrRule — counts and scores", () => {
  const fields: Array<[string, number]> = [
    ["arrRuntime", 117],
    ["arrSeasonCount", 3],
    ["arrEpisodeCount", 30],
    ["arrCustomFormatScore", 100],
    ["arrMonitoredSeasonCount", 2],
    ["arrMonitoredEpisodeCount", 20],
  ];
  it.each(fields)("%s", (field, v) => {
    expect(arr(field, "equals", String(v))).toBe(true);
    expect(arr(field, "notEquals", String(v))).toBe(false);
    expect(arr(field, "greaterThan", String(v))).toBe(false);
    expect(arr(field, "greaterThanOrEqual", String(v))).toBe(true);
    expect(arr(field, "lessThan", String(v + 1))).toBe(true);
    expect(arr(field, "lessThanOrEqual", String(v - 1))).toBe(false);
    expect(arr(field, "between", `${v},${v}`)).toBe(true);
    expect(arr(field, "isNull")).toBe(false);
    expect(arr(field, "isNotNull")).toBe(true);
    expect(arr(field, "isNull", "", nullMeta())).toBe(true);
    expect(arr(field, "isNotNull", "", nullMeta())).toBe(false);
    expect(arr(field, "equals", "0", nullMeta(), true)).toBe(false);
  });
});

describe("evaluateArrRule — nullable booleans", () => {
  const fields: Array<[string, boolean]> = [
    ["arrQualityCutoffMet", true],
    ["arrEnded", true],
    ["arrHasUnaired", false],
  ];
  it.each(fields)("%s", (field, v) => {
    expect(arr(field, "equals", String(v))).toBe(true);
    expect(arr(field, "notEquals", String(v))).toBe(false);
    expect(arr(field, "equals", String(v), meta(), true)).toBe(false);
    expect(arr(field, "isNull")).toBe(false);
    expect(arr(field, "isNotNull")).toBe(true);
    expect(arr(field, "isNull", "", nullMeta())).toBe(true);
    expect(arr(field, "isNotNull", "", nullMeta(), true)).toBe(true);
    expect(arr(field, "equals", "true", nullMeta(), true)).toBe(false);
  });
});

describe("evaluateArrRule — text fields", () => {
  it("free-text arrPath is substring for contains", () => {
    expect(arr("arrPath", "contains", "alien")).toBe(true);
    expect(arr("arrPath", "notContains", "alien|predator")).toBe(false);
    expect(arr("arrPath", "equals", "/movies/alien (1979)")).toBe(true);
    expect(arr("arrPath", "notEquals", "/x")).toBe(true);
    expect(arr("arrPath", "matchesWildcard", "/movies/*")).toBe(true);
    expect(arr("arrPath", "notMatchesWildcard", "/tv/*")).toBe(true);
  });

  it("enumerable arrStatus is list membership", () => {
    expect(arr("arrStatus", "contains", "ended|continuing")).toBe(true);
    expect(arr("arrStatus", "contains", "end")).toBe(false);
    expect(arr("arrStatus", "notContains", "continuing")).toBe(true);
    expect(arr("arrSeriesType", "equals", "STANDARD")).toBe(true);
    expect(arr("arrOriginalLanguage", "contains", "english")).toBe(true);
    expect(arr("arrQualityName", "matchesWildcard", "bluray*")).toBe(true);
  });

  it("null text: only isNull matches, nothing else even negated", () => {
    for (const f of ["arrPath", "arrOriginalLanguage", "arrQualityName", "arrStatus", "arrSeriesType"]) {
      expect(arr(f, "isNull", "", nullMeta())).toBe(true);
      expect(arr(f, "isNotNull", "", nullMeta())).toBe(false);
      expect(arr(f, "isNull")).toBe(false);
      expect(arr(f, "equals", "x", nullMeta(), true)).toBe(false);
    }
  });
});

const seerrMeta = (o: Partial<SeerrMetadata> = {}): SeerrMetadata => ({
  requested: true,
  requestCount: 2,
  requestDate: "2024-03-10T00:00:00Z",
  requestedBy: ["alice"],
  approvalDate: "2024-03-11T00:00:00Z",
  declineDate: null,
  ...o,
});

const seerr = (field: string, operator: string, value: string | number = "", m: SeerrMetadata | null = seerrMeta(), negate?: boolean) =>
  evaluateSeerrRule(r(field, operator, value, negate), m ?? undefined);

describe("evaluateSeerrRule", () => {
  it("guards", () => {
    expect(seerr("seerrRequestedBy", "contains", "|", seerrMeta(), true)).toBe(false);
    expect(seerr("seerrRequested", "greaterThan", "1", seerrMeta(), true)).toBe(false);
    expect(seerr("seerrRequestCount", "equals", "x", seerrMeta(), true)).toBe(false);
    expect(seerr("year", "equals", "1", seerrMeta(), true)).toBe(false);
  });

  it("seerrRequested falls back to not-requested without metadata", () => {
    expect(seerr("seerrRequested", "equals", "true")).toBe(true);
    expect(seerr("seerrRequested", "notEquals", "true")).toBe(false);
    expect(seerr("seerrRequested", "equals", "false", null)).toBe(true);
    expect(seerr("seerrRequested", "isNull")).toBe(false);
    expect(seerr("seerrRequested", "isNotNull")).toBe(true);
    expect(seerr("seerrRequested", "isNotNull", "", null, true)).toBe(false);
  });

  it("seerrRequestCount", () => {
    expect(seerr("seerrRequestCount", "equals", "2")).toBe(true);
    expect(seerr("seerrRequestCount", "notEquals", "2")).toBe(false);
    expect(seerr("seerrRequestCount", "greaterThan", "1")).toBe(true);
    expect(seerr("seerrRequestCount", "greaterThanOrEqual", "3")).toBe(false);
    expect(seerr("seerrRequestCount", "lessThan", "3")).toBe(true);
    expect(seerr("seerrRequestCount", "lessThanOrEqual", "1")).toBe(false);
    expect(seerr("seerrRequestCount", "between", "1,2")).toBe(true);
    expect(seerr("seerrRequestCount", "isNull")).toBe(false);
    expect(seerr("seerrRequestCount", "isNotNull")).toBe(true);
    expect(seerr("seerrRequestCount", "equals", "0", null)).toBe(true);
  });

  it("dates with values", () => {
    expect(seerr("seerrRequestDate", "before", "2024-04-01")).toBe(true);
    expect(seerr("seerrRequestDate", "after", "2024-04-01")).toBe(false);
    expect(seerr("seerrApprovalDate", "equals", "2024-03-11")).toBe(true);
    expect(seerr("seerrApprovalDate", "notEquals", "2024-03-11")).toBe(false);
    expect(seerr("seerrRequestDate", "between", "2024-3-1,2024-3-31")).toBe(true);
    expect(seerr("seerrRequestDate", "isNull")).toBe(false);
    expect(seerr("seerrRequestDate", "isNotNull")).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-20T00:00:00Z"));
    expect(seerr("seerrRequestDate", "inLastDays", "30")).toBe(true);
    expect(seerr("seerrRequestDate", "notInLastDays", "30")).toBe(false);
  });

  it("missing dates: only notEquals is true, and negate applies", () => {
    expect(seerr("seerrDeclineDate", "isNull")).toBe(true);
    expect(seerr("seerrDeclineDate", "isNotNull")).toBe(false);
    expect(seerr("seerrDeclineDate", "notEquals", "2024-01-01")).toBe(true);
    expect(seerr("seerrDeclineDate", "equals", "2024-01-01")).toBe(false);
    expect(seerr("seerrDeclineDate", "inLastDays", "90", seerrMeta(), true)).toBe(true);
    expect(seerr("seerrDeclineDate", "notEquals", "2024-01-01", seerrMeta(), true)).toBe(false);
  });

  it("requestedBy uses name-list semantics", () => {
    expect(seerr("seerrRequestedBy", "equals", "ALICE")).toBe(true);
    expect(seerr("seerrRequestedBy", "matchesWildcard", "al*")).toBe(true);
    expect(seerr("seerrRequestedBy", "isNull", "", null)).toBe(true);
    expect(seerr("seerrRequestedBy", "contains", "bob", seerrMeta(), true)).toBe(true);
  });
});

describe("lookupSeerrMeta", () => {
  const data = { "TMDB:1": seerrMeta({ requestCount: 1 }), "TVDB:2": seerrMeta({ requestCount: 2 }), "TMDB:3": seerrMeta({ requestCount: 3 }) };
  it("movies use TMDB only, series prefer TVDB then TMDB, music nothing", () => {
    expect(lookupSeerrMeta([{ source: "TMDB", externalId: "1" }], data, "MOVIE")?.requestCount).toBe(1);
    expect(lookupSeerrMeta([{ source: "TVDB", externalId: "2" }], data, "MOVIE")).toBeUndefined();
    expect(lookupSeerrMeta([{ source: "TVDB", externalId: "2" }, { source: "TMDB", externalId: "3" }], data, "SERIES")?.requestCount).toBe(2);
    expect(lookupSeerrMeta([{ source: "TVDB", externalId: "99" }, { source: "TMDB", externalId: "3" }], data, "SERIES")?.requestCount).toBe(3);
    expect(lookupSeerrMeta([{ source: "TMDB", externalId: "1" }], data, "MUSIC")).toBeUndefined();
    expect(lookupSeerrMeta([{ source: "TMDB", externalId: "1" }], undefined, "MOVIE")).toBeUndefined();
  });
});

describe("rule-tree detectors", () => {
  const rule = (field: string, extra: Partial<LifecycleRule> = {}): LifecycleRule =>
    ({ id: field, field, operator: "equals", value: "x", condition: "AND", ...extra }) as LifecycleRule;
  const group = (rules: LifecycleRule[], groups: LifecycleRuleGroup[] = [], extra: Partial<LifecycleRuleGroup> = {}): LifecycleRuleGroup =>
    ({ id: "g", condition: "AND", rules, groups, ...extra }) as LifecycleRuleGroup;

  it("flat legacy rules", () => {
    expect(hasArrRules([rule("arrTag")])).toBe(true);
    expect(hasArrRules([rule("arrTag", { enabled: false })])).toBe(false);
    expect(hasSeerrRules([rule("seerrRequested")])).toBe(true);
    expect(hasStreamRules([rule("audioLanguage")])).toBe(true);
    expect(hasExternalIdFieldRules([rule("hasExternalId")])).toBe(true);
    expect(hasSeriesAggregateRules([rule("watchedEpisodeCount")])).toBe(true);
    expect(hasCrossSystemFieldRules([rule("serverCount")])).toBe(true);
    expect(hasWatchedByUserRules([rule("watchedByUser")])).toBe(true);
    expect(hasPlayActivityRules([rule("playCount")])).toBe(true);
    expect(hasPlayActivityRules([rule("title")])).toBe(false);
    expect(hasAnyActiveRules([rule("title")])).toBe(true);
    expect(hasAnyActiveRules([rule("title", { enabled: false })])).toBe(false);
  });

  it("empty input is never a match", () => {
    for (const fn of [hasArrRules, hasSeerrRules, hasStreamRules, hasExternalIdFieldRules, hasSeriesAggregateRules,
      hasCrossSystemFieldRules, hasWatchedByUserRules, hasPlayActivityRules, hasAnyActiveRules]) {
      expect(fn([])).toBe(false);
    }
  });

  it("grouped rules skip disabled groups and recurse into children", () => {
    const nested = [group([rule("title")], [group([rule("arrTag"), rule("seerrRequested"), rule("hasExternalId"),
      rule("watchedEpisodeCount"), rule("serverCount"), rule("watchedByUser"), rule("lastPlayedAt")])])];
    expect(hasArrRules(nested)).toBe(true);
    expect(hasSeerrRules(nested)).toBe(true);
    expect(hasExternalIdFieldRules(nested)).toBe(true);
    expect(hasSeriesAggregateRules(nested)).toBe(true);
    expect(hasCrossSystemFieldRules(nested)).toBe(true);
    expect(hasWatchedByUserRules(nested)).toBe(true);
    expect(hasPlayActivityRules(nested)).toBe(true);

    const disabled = [group([rule("arrTag"), rule("seerrRequested"), rule("hasExternalId"), rule("watchedEpisodeCount"),
      rule("serverCount"), rule("audioLanguage")], [], { enabled: false })];
    expect(hasArrRules(disabled)).toBe(false);
    expect(hasSeerrRules(disabled)).toBe(false);
    expect(hasExternalIdFieldRules(disabled)).toBe(false);
    expect(hasSeriesAggregateRules(disabled)).toBe(false);
    expect(hasCrossSystemFieldRules(disabled)).toBe(false);
    expect(hasStreamRules(disabled)).toBe(false);
  });

  it("stream detection includes stream-query groups at any depth", () => {
    const sq = group([rule("sqCodec")], [], { streamQuery: { streamType: "audio" } } as Partial<LifecycleRuleGroup>);
    expect(hasStreamRules([group([rule("title")], [sq])])).toBe(true);
    expect(hasStreamRules([group([rule("title")])])).toBe(false);
  });
});
