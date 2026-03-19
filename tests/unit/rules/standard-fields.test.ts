import { describe, it, expect } from "vitest";
import { getMatchedCriteriaForItems } from "@/lib/rules/engine";
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
): Map<string, unknown[]> {
  return getMatchedCriteriaForItems(items, rules, type);
}

// ---------------------------------------------------------------------------
// 1. Text fields
// ---------------------------------------------------------------------------

describe("Text fields (title as representative)", () => {
  const items = [
    { id: "1", title: "The Matrix" },
    { id: "2", title: "Inception" },
    { id: "3", title: null },
    { id: "4", title: "" },
  ];

  it("equals matches case-insensitively", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "equals", value: "the matrix" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("equals does not match different title", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "equals", value: "Interstellar" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("notEquals matches items with different title", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "notEquals", value: "The Matrix" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("contains matches substring", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "contains", value: "matrix" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("contains with pipe-separated values matches any", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "contains", value: "matrix|inception" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("notContains excludes matching substring", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "notContains", value: "matrix" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("notContains with pipe-separated values excludes any match", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "notContains", value: "matrix|inception" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("matchesWildcard with * pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "matchesWildcard", value: "The *" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("matchesWildcard with ? pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "matchesWildcard", value: "?nception" })])];
    const result = matched(items, rules);
    expect(result.get("2")!.length).toBeGreaterThan(0);
    expect(result.get("1")).toHaveLength(0);
  });

  it("notMatchesWildcard excludes matching items", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "notMatchesWildcard", value: "The *" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("null title treated as empty string for text operators", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "equals", value: "" })])];
    const result = matched(items, rules);
    expect(result.get("3")!.length).toBeGreaterThan(0);
    expect(result.get("4")!.length).toBeGreaterThan(0);
  });

  it("empty string title matches equals empty", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "notEquals", value: "" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("3")).toHaveLength(0);
    expect(result.get("4")).toHaveLength(0);
  });
});

describe("Text fields spot-check (other text fields)", () => {
  it("parentTitle equals", () => {
    const items = [{ id: "1", parentTitle: "Breaking Bad" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "parentTitle", operator: "equals", value: "breaking bad" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("albumTitle contains", () => {
    const items = [{ id: "1", albumTitle: "Dark Side of the Moon" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "albumTitle", operator: "contains", value: "dark side" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("contentRating equals", () => {
    const items = [{ id: "1", contentRating: "PG-13" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "contentRating", operator: "equals", value: "pg-13" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("studio notContains", () => {
    const items = [{ id: "1", studio: "Warner Bros" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "studio", operator: "notContains", value: "disney" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("resolution equals", () => {
    const items = [{ id: "1", resolution: "4K" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "resolution", operator: "equals", value: "4K" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoCodec matchesWildcard", () => {
    const items = [{ id: "1", videoCodec: "hevc" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoCodec", operator: "matchesWildcard", value: "h*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audioCodec notEquals", () => {
    const items = [{ id: "1", audioCodec: "aac" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioCodec", operator: "notEquals", value: "dts" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("dynamicRange equals", () => {
    const items = [{ id: "1", dynamicRange: "Dolby Vision" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "dynamicRange", operator: "equals", value: "dolby vision" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audioProfile contains", () => {
    const items = [{ id: "1", audioProfile: "Dolby Atmos" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioProfile", operator: "contains", value: "atmos" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoProfile notMatchesWildcard", () => {
    const items = [{ id: "1", videoProfile: "main 10" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoProfile", operator: "notMatchesWildcard", value: "high*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoFrameRate equals", () => {
    const items = [{ id: "1", videoFrameRate: "24p" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoFrameRate", operator: "equals", value: "24p" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("aspectRatio contains", () => {
    const items = [{ id: "1", aspectRatio: "2.39:1" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "aspectRatio", operator: "contains", value: "2.39" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("scanType equals", () => {
    const items = [{ id: "1", scanType: "progressive" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "scanType", operator: "equals", value: "progressive" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("container equals", () => {
    const items = [{ id: "1", container: "mkv" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "container", operator: "equals", value: "mkv" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- parentTitle: additional operators ---

  it("parentTitle notEquals", () => {
    const items = [{ id: "1", parentTitle: "Breaking Bad" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "parentTitle", operator: "notEquals", value: "Better Call Saul" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("parentTitle matchesWildcard", () => {
    const items = [{ id: "1", parentTitle: "Breaking Bad" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "parentTitle", operator: "matchesWildcard", value: "Break*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- albumTitle: additional operators ---

  it("albumTitle notEquals", () => {
    const items = [{ id: "1", albumTitle: "Dark Side of the Moon" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "albumTitle", operator: "notEquals", value: "The Wall" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("albumTitle matchesWildcard", () => {
    const items = [{ id: "1", albumTitle: "Dark Side of the Moon" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "albumTitle", operator: "matchesWildcard", value: "Dark *" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- contentRating: additional operators ---

  it("contentRating notEquals", () => {
    const items = [{ id: "1", contentRating: "PG-13" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "contentRating", operator: "notEquals", value: "R" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("contentRating matchesWildcard", () => {
    const items = [{ id: "1", contentRating: "PG-13" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "contentRating", operator: "matchesWildcard", value: "PG*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- studio: additional operators ---

  it("studio notEquals", () => {
    const items = [{ id: "1", studio: "Warner Bros" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "studio", operator: "notEquals", value: "Disney" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("studio matchesWildcard", () => {
    const items = [{ id: "1", studio: "Warner Bros" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "studio", operator: "matchesWildcard", value: "Warner*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- resolution: additional operators ---

  it("resolution notEquals", () => {
    const items = [{ id: "1", resolution: "4K" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "resolution", operator: "notEquals", value: "1080P" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("resolution matchesWildcard", () => {
    const items = [{ id: "1", resolution: "4K" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "resolution", operator: "matchesWildcard", value: "4?" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- videoCodec: additional operators ---

  it("videoCodec notEquals", () => {
    const items = [{ id: "1", videoCodec: "hevc" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoCodec", operator: "notEquals", value: "h264" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoCodec matchesWildcard", () => {
    const items = [{ id: "1", videoCodec: "hevc" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoCodec", operator: "matchesWildcard", value: "he*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- audioCodec: additional operators ---

  it("audioCodec notEquals already tested above, testing non-match", () => {
    const items = [{ id: "1", audioCodec: "aac" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioCodec", operator: "notEquals", value: "aac" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("audioCodec matchesWildcard", () => {
    const items = [{ id: "1", audioCodec: "aac" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioCodec", operator: "matchesWildcard", value: "a?c" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- dynamicRange: additional operators ---

  it("dynamicRange notEquals", () => {
    const items = [{ id: "1", dynamicRange: "Dolby Vision" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "dynamicRange", operator: "notEquals", value: "HDR10" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("dynamicRange matchesWildcard", () => {
    const items = [{ id: "1", dynamicRange: "Dolby Vision" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "dynamicRange", operator: "matchesWildcard", value: "Dolby*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- audioProfile: additional operators ---

  it("audioProfile notEquals", () => {
    const items = [{ id: "1", audioProfile: "Dolby Atmos" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioProfile", operator: "notEquals", value: "DTS-HD MA" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audioProfile matchesWildcard", () => {
    const items = [{ id: "1", audioProfile: "Dolby Atmos" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioProfile", operator: "matchesWildcard", value: "Dolby*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- videoProfile: additional operators ---

  it("videoProfile notEquals", () => {
    const items = [{ id: "1", videoProfile: "main 10" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoProfile", operator: "notEquals", value: "high" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoProfile matchesWildcard", () => {
    const items = [{ id: "1", videoProfile: "main 10" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoProfile", operator: "matchesWildcard", value: "main*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- videoFrameRate: additional operators ---

  it("videoFrameRate notEquals", () => {
    const items = [{ id: "1", videoFrameRate: "24p" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoFrameRate", operator: "notEquals", value: "60p" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoFrameRate matchesWildcard", () => {
    const items = [{ id: "1", videoFrameRate: "24p" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoFrameRate", operator: "matchesWildcard", value: "2?p" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- aspectRatio: additional operators ---

  it("aspectRatio notEquals", () => {
    const items = [{ id: "1", aspectRatio: "2.39:1" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "aspectRatio", operator: "notEquals", value: "16:9" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("aspectRatio matchesWildcard", () => {
    const items = [{ id: "1", aspectRatio: "2.39:1" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "aspectRatio", operator: "matchesWildcard", value: "2.*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- scanType: additional operators ---

  it("scanType notEquals", () => {
    const items = [{ id: "1", scanType: "progressive" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "scanType", operator: "notEquals", value: "interlaced" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("scanType matchesWildcard", () => {
    const items = [{ id: "1", scanType: "progressive" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "scanType", operator: "matchesWildcard", value: "pro*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- container: additional operators ---

  it("container notEquals", () => {
    const items = [{ id: "1", container: "mkv" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "container", operator: "notEquals", value: "mp4" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("container matchesWildcard", () => {
    const items = [{ id: "1", container: "mkv" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "container", operator: "matchesWildcard", value: "m?v" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Numeric fields
// ---------------------------------------------------------------------------

describe("Numeric fields (playCount as representative)", () => {
  const items = [
    { id: "1", playCount: 10 },
    { id: "2", playCount: 0 },
    { id: "3", playCount: null },
  ];

  it("equals matches exact value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "playCount", operator: "equals", value: 10 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("notEquals matches items with different value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "playCount", operator: "notEquals", value: 10 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("greaterThan matches items above threshold", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "playCount", operator: "greaterThan", value: 5 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("greaterThanOrEqual matches items at or above threshold", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "playCount", operator: "greaterThanOrEqual", value: 10 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("lessThan matches items below threshold", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "playCount", operator: "lessThan", value: 10 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("lessThanOrEqual matches items at or below threshold", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "playCount", operator: "lessThanOrEqual", value: 0 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("null defaults to 0", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "playCount", operator: "equals", value: 0 })])];
    const result = matched(items, rules);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });
});

describe("Numeric fields spot-check (other numeric fields)", () => {
  it("year greaterThan", () => {
    const items = [{ id: "1", year: 2023 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "year", operator: "greaterThan", value: 2020 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("rating lessThanOrEqual", () => {
    const items = [{ id: "1", rating: 7.5 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "rating", operator: "lessThanOrEqual", value: 8 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audienceRating equals", () => {
    const items = [{ id: "1", audienceRating: 85 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audienceRating", operator: "equals", value: 85 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoBitDepth notEquals", () => {
    const items = [{ id: "1", videoBitDepth: 10 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoBitDepth", operator: "notEquals", value: 8 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoBitrate greaterThanOrEqual", () => {
    const items = [{ id: "1", videoBitrate: 20000 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoBitrate", operator: "greaterThanOrEqual", value: 15000 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audioChannels lessThan", () => {
    const items = [{ id: "1", audioChannels: 2 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioChannels", operator: "lessThan", value: 6 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audioSamplingRate equals", () => {
    const items = [{ id: "1", audioSamplingRate: 48000 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioSamplingRate", operator: "equals", value: 48000 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audioBitrate greaterThan", () => {
    const items = [{ id: "1", audioBitrate: 640 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioBitrate", operator: "greaterThan", value: 320 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- year: additional operators ---

  it("year greaterThan non-match", () => {
    const items = [{ id: "1", year: 2023 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "year", operator: "greaterThan", value: 2025 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("year lessThan", () => {
    const items = [{ id: "1", year: 2023 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "year", operator: "lessThan", value: 2025 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- rating: additional operators ---

  it("rating greaterThan", () => {
    const items = [{ id: "1", rating: 7.5 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "rating", operator: "greaterThan", value: 5 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("rating lessThan", () => {
    const items = [{ id: "1", rating: 7.5 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "rating", operator: "lessThan", value: 9 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- audienceRating: additional operators ---

  it("audienceRating greaterThan", () => {
    const items = [{ id: "1", audienceRating: 85 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audienceRating", operator: "greaterThan", value: 70 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audienceRating lessThan", () => {
    const items = [{ id: "1", audienceRating: 85 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audienceRating", operator: "lessThan", value: 90 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- videoBitDepth: additional operators ---

  it("videoBitDepth greaterThan", () => {
    const items = [{ id: "1", videoBitDepth: 10 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoBitDepth", operator: "greaterThan", value: 8 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoBitDepth lessThan", () => {
    const items = [{ id: "1", videoBitDepth: 10 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoBitDepth", operator: "lessThan", value: 12 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- videoBitrate: additional operators ---

  it("videoBitrate greaterThan", () => {
    const items = [{ id: "1", videoBitrate: 20000 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoBitrate", operator: "greaterThan", value: 15000 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("videoBitrate lessThan", () => {
    const items = [{ id: "1", videoBitrate: 20000 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "videoBitrate", operator: "lessThan", value: 25000 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- audioChannels: additional operators ---

  it("audioChannels greaterThan", () => {
    const items = [{ id: "1", audioChannels: 2 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioChannels", operator: "greaterThan", value: 1 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audioChannels lessThan non-match", () => {
    const items = [{ id: "1", audioChannels: 2 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioChannels", operator: "lessThan", value: 2 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
  });

  // --- audioSamplingRate: additional operators ---

  it("audioSamplingRate greaterThan", () => {
    const items = [{ id: "1", audioSamplingRate: 48000 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioSamplingRate", operator: "greaterThan", value: 44100 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("audioSamplingRate lessThan", () => {
    const items = [{ id: "1", audioSamplingRate: 48000 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioSamplingRate", operator: "lessThan", value: 96000 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  // --- audioBitrate: additional operators ---

  it("audioBitrate greaterThan non-match", () => {
    const items = [{ id: "1", audioBitrate: 640 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioBitrate", operator: "greaterThan", value: 1000 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("audioBitrate lessThan", () => {
    const items = [{ id: "1", audioBitrate: 640 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioBitrate", operator: "lessThan", value: 1000 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Date fields
// ---------------------------------------------------------------------------

describe("Date fields (lastPlayedAt as representative)", () => {
  const items = [
    { id: "1", lastPlayedAt: "2024-06-15T10:00:00Z" },
    { id: "2", lastPlayedAt: "2024-01-01T00:00:00Z" },
    { id: "3", lastPlayedAt: null },
    { id: "4", lastPlayedAt: "not-a-date" },
  ];

  it("before matches items with earlier date", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "before", value: "2024-03-01" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("after matches items with later date", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "after", value: "2024-03-01" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("equals matches at day level", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "equals", value: "2024-06-15" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("notEquals matches items with different date", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "notEquals", value: "2024-06-15" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("inLastDays matches recent dates", () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 5);
    const items2 = [
      { id: "recent", lastPlayedAt: recentDate.toISOString() },
      { id: "old", lastPlayedAt: "2020-01-01T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "inLastDays", value: 10 })])];
    const result = matched(items2, rules);
    expect(result.get("recent")!.length).toBeGreaterThan(0);
    expect(result.get("old")).toHaveLength(0);
  });

  it("notInLastDays matches old dates", () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 5);
    const items2 = [
      { id: "recent", lastPlayedAt: recentDate.toISOString() },
      { id: "old", lastPlayedAt: "2020-01-01T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "notInLastDays", value: 10 })])];
    const result = matched(items2, rules);
    expect(result.get("recent")).toHaveLength(0);
    expect(result.get("old")!.length).toBeGreaterThan(0);
  });

  it("null date returns false for all operators", () => {
    const operators = ["before", "after", "equals", "notEquals", "inLastDays", "notInLastDays"] as const;
    for (const op of operators) {
      const val = op === "inLastDays" || op === "notInLastDays" ? 30 : "2024-06-15";
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: op, value: val })])];
      const result = matched(items, rules);
      expect(result.get("3"), `null date should return false for ${op}`).toHaveLength(0);
    }
  });

  it("invalid date returns false for all operators", () => {
    const operators = ["before", "after", "equals", "notEquals", "inLastDays", "notInLastDays"] as const;
    for (const op of operators) {
      const val = op === "inLastDays" || op === "notInLastDays" ? 30 : "2024-06-15";
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: op, value: val })])];
      const result = matched(items, rules);
      expect(result.get("4"), `invalid date should return false for ${op}`).toHaveLength(0);
    }
  });
});

describe("Date fields spot-check (other date fields)", () => {
  it("addedAt before", () => {
    const items = [{ id: "1", addedAt: "2023-06-01T00:00:00Z" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "addedAt", operator: "before", value: "2024-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("originallyAvailableAt after", () => {
    const items = [{ id: "1", originallyAvailableAt: "2024-07-01T00:00:00Z" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "originallyAvailableAt", operator: "after", value: "2024-01-01" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Genre (JSON array)
// ---------------------------------------------------------------------------

describe("Genre field (JSON array)", () => {
  const items = [
    { id: "1", genres: ["Action", "Sci-Fi"] },
    { id: "2", genres: ["Comedy", "Romance"] },
    { id: "3", genres: [] },
  ];

  it("equals matches item with that genre", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "equals", value: "Action" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("notEquals excludes item with that genre", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "notEquals", value: "Action" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("contains matches item with that genre", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "contains", value: "Comedy" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("notContains excludes item with that genre", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "notContains", value: "Comedy" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("matchesWildcard with * pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "matchesWildcard", value: "Sci*" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("notMatchesWildcard excludes matching genre", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "notMatchesWildcard", value: "Act*" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("empty genres array does not match equals", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "equals", value: "Action" })])];
    const result = matched(items, rules);
    expect(result.get("3")).toHaveLength(0);
  });

  it("empty genres array matches notContains", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "notContains", value: "Action" })])];
    const result = matched(items, rules);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });

  it("case-insensitive matching for genre equals", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "equals", value: "action" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("case-insensitive matching for genre contains", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "contains", value: "SCI-FI" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. hasExternalId
// ---------------------------------------------------------------------------

describe("hasExternalId field", () => {
  const items = [
    { id: "1", externalIds: [{ source: "TMDB", externalId: "12345" }, { source: "IMDB", externalId: "tt1234" }] },
    { id: "2", externalIds: [{ source: "TVDB", externalId: "67890" }] },
    { id: "3", externalIds: [] },
  ];

  it("equals TMDB matches item with TMDB ID", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "hasExternalId", operator: "equals", value: "TMDB" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("equals TMDB does not match item without TMDB ID", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "hasExternalId", operator: "equals", value: "TMDB" })])];
    const result = matched(items, rules);
    expect(result.get("2")).toHaveLength(0);
  });

  it("notEquals matches item without the specified source", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "hasExternalId", operator: "notEquals", value: "TMDB" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("empty externalIds does not match equals", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "hasExternalId", operator: "equals", value: "TMDB" })])];
    const result = matched(items, rules);
    expect(result.get("3")).toHaveLength(0);
  });

  it("empty externalIds matches notEquals", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "hasExternalId", operator: "notEquals", value: "IMDB" })])];
    const result = matched(items, rules);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. isWatchlisted (boolean)
// ---------------------------------------------------------------------------

describe("isWatchlisted field (boolean)", () => {
  const items = [
    { id: "1", isWatchlisted: true },
    { id: "2", isWatchlisted: false },
    { id: "3" }, // undefined, should default to false
  ];

  it("equals true matches watchlisted item", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "isWatchlisted", operator: "equals", value: "true" })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("equals false matches non-watchlisted items", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "isWatchlisted", operator: "equals", value: "false" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("notEquals true matches non-watchlisted items", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "isWatchlisted", operator: "notEquals", value: "true" })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("undefined defaults to false", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "isWatchlisted", operator: "equals", value: "false" })])];
    const result = matched(items, rules);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });

  it("undefined does not match equals true", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "isWatchlisted", operator: "equals", value: "true" })])];
    const result = matched(items, rules);
    expect(result.get("3")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. fileSize (BigInt conversion)
// ---------------------------------------------------------------------------

describe("fileSize field (MB to bytes conversion)", () => {
  // 1000 MB = 1000 * 1024 * 1024 = 1048576000 bytes
  const MB = 1024 * 1024;
  const items = [
    { id: "1", fileSize: String(1000 * MB) },  // 1000 MB
    { id: "2", fileSize: String(500 * MB) },    // 500 MB
    { id: "3", fileSize: null },                 // null, should default to 0
  ];

  it("greaterThan matches larger file", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "fileSize", operator: "greaterThan", value: 800 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("lessThan matches smaller file", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "fileSize", operator: "lessThan", value: 800 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("equals matches exact size", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "fileSize", operator: "equals", value: 1000 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("notEquals matches different size", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "fileSize", operator: "notEquals", value: 1000 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("greaterThanOrEqual matches at boundary", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "fileSize", operator: "greaterThanOrEqual", value: 1000 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("lessThanOrEqual matches at boundary", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "fileSize", operator: "lessThanOrEqual", value: 500 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("null fileSize defaults to 0", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "fileSize", operator: "equals", value: 0 })])];
    const result = matched(items, rules);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. duration (minutes to milliseconds)
// ---------------------------------------------------------------------------

describe("duration field (minutes to milliseconds conversion)", () => {
  // 90 minutes = 90 * 60000 = 5400000 ms
  const MS_PER_MIN = 60000;
  const items = [
    { id: "1", duration: 90 * MS_PER_MIN },   // 90 min
    { id: "2", duration: 30 * MS_PER_MIN },   // 30 min
    { id: "3", duration: null },               // null, defaults to 0
  ];

  it("greaterThan matches longer duration", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "duration", operator: "greaterThan", value: 60 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("lessThan matches shorter duration", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "duration", operator: "lessThan", value: 60 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("equals matches exact duration", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "duration", operator: "equals", value: 90 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("notEquals matches different duration", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "duration", operator: "notEquals", value: 90 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("greaterThanOrEqual matches at boundary", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "duration", operator: "greaterThanOrEqual", value: 90 })])];
    const result = matched(items, rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
    expect(result.get("2")).toHaveLength(0);
  });

  it("lessThanOrEqual matches at boundary", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "duration", operator: "lessThanOrEqual", value: 30 })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Negate flag
// ---------------------------------------------------------------------------

describe("Negate flag", () => {
  it("negate on text equals inverts the result", () => {
    const items = [{ id: "1", title: "The Matrix" }, { id: "2", title: "Inception" }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "equals", value: "The Matrix", negate: true })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("negate on numeric greaterThan inverts the result", () => {
    const items = [{ id: "1", playCount: 10 }, { id: "2", playCount: 3 }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "playCount", operator: "greaterThan", value: 5, negate: true })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("negate on date before inverts the result", () => {
    const items = [
      { id: "1", lastPlayedAt: "2024-01-01T00:00:00Z" },
      { id: "2", lastPlayedAt: "2024-12-01T00:00:00Z" },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "before", value: "2024-06-01", negate: true })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("negate on genre contains inverts the result", () => {
    const items = [
      { id: "1", genres: ["Action", "Drama"] },
      { id: "2", genres: ["Comedy"] },
    ];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "contains", value: "Action", negate: true })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("negate on boolean equals inverts the result", () => {
    const items = [{ id: "1", isWatchlisted: true }, { id: "2", isWatchlisted: false }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "isWatchlisted", operator: "equals", value: "true", negate: true })])];
    const result = matched(items, rules);
    expect(result.get("1")).toHaveLength(0);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });
});
