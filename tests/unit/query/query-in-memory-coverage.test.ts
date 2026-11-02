import { describe, it, expect, vi, afterEach } from "vitest";
import { evaluateAllQueryRulesInMemory } from "@/lib/query/query-engine";
import type { QueryGroup, QueryRule } from "@/lib/query/types";
import type { ArrMetadata, SeerrMetadata } from "@/lib/rules/lifecycle-engine";

const MB = 1024 * 1024;

function rule(field: string, operator: string, value: string | number = "", extra: Partial<QueryRule> = {}): QueryRule {
  return { id: `${field}-${operator}`, field, operator, value, condition: "AND", ...extra };
}

function group(rules: QueryRule[], extra: Partial<QueryGroup> = {}): QueryGroup {
  return { id: "g", condition: "AND", rules, groups: [], ...extra };
}

function ev(item: Record<string, unknown>, r: QueryRule, arr?: ArrMetadata, seerr?: SeerrMetadata) {
  return evaluateAllQueryRulesInMemory([group([r])], item, arr, seerr);
}

const audio = (language: string | null, codec: string | null = "aac") => ({ streamType: 2, language, codec });
const sub = (language: string | null) => ({ streamType: 3, language, codec: "srt" });

afterEach(() => {
  vi.useRealTimers();
});

describe("structure", () => {
  it("no active groups means no constraint (the query matches everything)", () => {
    expect(evaluateAllQueryRulesInMemory([], { id: "1" }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory([group([rule("year", "equals", "1")], { enabled: false })], { id: "1" }, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory([group([])], { id: "1" }, undefined, undefined)).toBe(true);
  });

  it("combines top-level groups and sub-groups with AND/OR", () => {
    const item = { id: "1", title: "Alien", year: 1979 };
    const yes = rule("title", "equals", "alien");
    const no = rule("year", "equals", "2000");
    expect(evaluateAllQueryRulesInMemory([group([no]), group([yes], { id: "g2", condition: "OR" })], item, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory([group([yes]), group([no], { id: "g2" })], item, undefined, undefined)).toBe(false);
    expect(evaluateAllQueryRulesInMemory([group([no], { groups: [group([yes], { id: "s", condition: "OR" })] })], item, undefined, undefined)).toBe(true);
    expect(evaluateAllQueryRulesInMemory([group([yes, rule("year", "equals", "2000", { enabled: false })], { groups: [group([no], { id: "s", enabled: false })] })], item, undefined, undefined)).toBe(true);
  });

  it("guards: dead rules never match even negated", () => {
    expect(ev({ id: "1", title: "x" }, rule("title", "contains", "|", { negate: true }))).toBe(false);
    expect(ev({ id: "1", year: 1 }, rule("year", "contains", "1", { negate: true }))).toBe(false);
    expect(ev({ id: "1", year: 1 }, rule("year", "equals", "abc", { negate: true }))).toBe(false);
    expect(ev({ id: "1" }, rule("sqCodec", "equals", "aac", { negate: true }))).toBe(false);
  });
});

describe("Arr / Seerr delegation", () => {
  it("delegates to the shared evaluators", () => {
    const arr = { arrId: 1, tags: ["keep"], monitored: true } as unknown as ArrMetadata;
    expect(ev({ id: "1" }, rule("arrTag", "contains", "keep"), arr)).toBe(true);
    expect(ev({ id: "1" }, rule("foundInArr", "equals", "false"))).toBe(true);
    expect(ev({ id: "1" }, rule("seerrRequested", "equals", "false"))).toBe(true);
  });
});

describe("cross-system fields", () => {
  const item = { id: "1", serverCount: 3, matchedRuleSets: ["Keep"], hasPendingAction: false };
  it("serverCount", () => {
    expect(ev(item, rule("serverCount", "equals", "3"))).toBe(true);
    expect(ev(item, rule("serverCount", "notEquals", "3"))).toBe(false);
    expect(ev(item, rule("serverCount", "greaterThan", "2"))).toBe(true);
    expect(ev(item, rule("serverCount", "greaterThanOrEqual", "4"))).toBe(false);
    expect(ev(item, rule("serverCount", "lessThan", "4"))).toBe(true);
    expect(ev(item, rule("serverCount", "lessThanOrEqual", "2"))).toBe(false);
    expect(ev(item, rule("serverCount", "between", "1,3"))).toBe(true);
    expect(ev(item, rule("serverCount", "equals", "3", { negate: true }))).toBe(false);
    expect(ev({ id: "2" }, rule("serverCount", "equals", "1"))).toBe(true);
    expect(ev(item, rule("serverCount", "isNull"))).toBe(false);
    expect(ev(item, rule("serverCount", "isNull", "", { negate: true }))).toBe(true);
    expect(ev(item, rule("serverCount", "isNotNull"))).toBe(true);
    expect(ev(item, rule("serverCount", "isNotNull", "", { negate: true }))).toBe(false);
  });

  it("matchedByRuleSet and hasPendingAction", () => {
    expect(ev(item, rule("matchedByRuleSet", "equals", "keep"))).toBe(true);
    expect(ev(item, rule("matchedByRuleSet", "equals", "keep", { negate: true }))).toBe(false);
    expect(ev(item, rule("hasPendingAction", "equals", "false"))).toBe(true);
    expect(ev(item, rule("hasPendingAction", "notEquals", "false"))).toBe(false);
    expect(ev(item, rule("hasPendingAction", "equals", "false", { negate: true }))).toBe(false);
    expect(ev(item, rule("hasPendingAction", "isNull"))).toBe(false);
    expect(ev(item, rule("hasPendingAction", "isNull", "", { negate: true }))).toBe(true);
    expect(ev(item, rule("hasPendingAction", "isNotNull"))).toBe(true);
    expect(ev(item, rule("hasPendingAction", "isNotNull", "", { negate: true }))).toBe(false);
  });
});

describe("stream relation fields", () => {
  const item = { id: "1", streams: [audio("English", "dts"), audio("unknown", null), sub("French")] };
  it("value operators over known values", () => {
    expect(ev(item, rule("audioLanguage", "equals", "ENGLISH"))).toBe(true);
    expect(ev(item, rule("audioLanguage", "notEquals", "english"))).toBe(false);
    expect(ev(item, rule("audioLanguage", "contains", "german|english"))).toBe(true);
    expect(ev(item, rule("audioLanguage", "notContains", "german"))).toBe(true);
    expect(ev(item, rule("subtitleLanguage", "matchesWildcard", "fr*"))).toBe(true);
    expect(ev(item, rule("subtitleLanguage", "notMatchesWildcard", "fr*"))).toBe(false);
    expect(ev(item, rule("streamAudioCodec", "equals", "dts", { negate: true }))).toBe(false);
  });

  it("no known language: value operators never match, emptiness questions still do", () => {
    const unknown = { id: "2", streams: [audio("Unknown"), audio("")] };
    expect(ev(unknown, rule("audioLanguage", "notEquals", "english"))).toBe(false);
    expect(ev(unknown, rule("audioLanguage", "equals", "english", { negate: true }))).toBe(false);
    expect(ev(unknown, rule("audioLanguage", "isNull"))).toBe(true);
    expect(ev(unknown, rule("audioLanguage", "isNotNull"))).toBe(false);
    expect(ev({ id: "3", streams: [audio(null, null)] }, rule("streamAudioCodec", "isNull"))).toBe(true);
    expect(ev({ id: "3", streams: [audio(null, "")] }, rule("streamAudioCodec", "isNotNull"))).toBe(true);
  });
});

describe("stream counts", () => {
  const item = { id: "1", streams: [audio("a"), audio("b"), sub("c")] };
  it("operators", () => {
    expect(ev(item, rule("audioStreamCount", "equals", "2"))).toBe(true);
    expect(ev(item, rule("audioStreamCount", "notEquals", "2"))).toBe(false);
    expect(ev(item, rule("audioStreamCount", "greaterThan", "1"))).toBe(true);
    expect(ev(item, rule("audioStreamCount", "greaterThanOrEqual", "3"))).toBe(false);
    expect(ev(item, rule("subtitleStreamCount", "lessThan", "2"))).toBe(true);
    expect(ev(item, rule("subtitleStreamCount", "lessThanOrEqual", "0"))).toBe(false);
    expect(ev(item, rule("audioStreamCount", "between", "2,4"))).toBe(true);
    expect(ev({ id: "2" }, rule("subtitleStreamCount", "isNull"))).toBe(true);
    expect(ev(item, rule("subtitleStreamCount", "isNotNull", "", { negate: true }))).toBe(false);
  });
});

describe("array fields and external ids", () => {
  it("genre / labels / country / hasExternalId", () => {
    const item = { id: "1", genres: ["Drama"], labels: ["Kids"], countries: ["UK"], externalIds: [{ source: "TVDB", externalId: "1" }] };
    expect(ev(item, rule("genre", "contains", "drama"))).toBe(true);
    expect(ev(item, rule("labels", "contains", "kids", { negate: true }))).toBe(false);
    expect(ev(item, rule("country", "equals", "uk"))).toBe(true);
    expect(ev(item, rule("hasExternalId", "equals", "TVDB"))).toBe(true);
    expect(ev(item, rule("hasExternalId", "equals", "TVDB", { negate: true }))).toBe(false);
  });
});

describe("fileSize and duration", () => {
  it("fileSize in MB", () => {
    const item = { id: "1", fileSize: String(100 * MB) };
    expect(ev(item, rule("fileSize", "greaterThan", "50"))).toBe(true);
    expect(ev(item, rule("fileSize", "between", "90,110"))).toBe(true);
    expect(ev(item, rule("fileSize", "lessThanOrEqual", "99"))).toBe(false);
    expect(ev(item, rule("fileSize", "isNotNull"))).toBe(true);
    expect(ev({ id: "2", fileSize: null }, rule("fileSize", "isNull"))).toBe(true);
    expect(ev({ id: "2", fileSize: null }, rule("fileSize", "notEquals", "5"))).toBe(true);
    expect(ev({ id: "2", fileSize: null }, rule("fileSize", "greaterThan", "5", { negate: true }))).toBe(true);
  });

  it("duration in minutes", () => {
    const item = { id: "1", duration: 120 * 60_000 };
    expect(ev(item, rule("duration", "greaterThanOrEqual", "120"))).toBe(true);
    expect(ev(item, rule("duration", "between", "60,90"))).toBe(false);
    expect(ev(item, rule("duration", "lessThan", "60"))).toBe(false);
    expect(ev(item, rule("duration", "isNotNull"))).toBe(true);
    expect(ev({ id: "2" }, rule("duration", "isNull"))).toBe(true);
    expect(ev({ id: "2" }, rule("duration", "equals", "5"))).toBe(false);
    expect(ev({ id: "2" }, rule("duration", "notEquals", "5"))).toBe(true);
  });
});

describe("isWatchlisted and watchedByUser", () => {
  it("isWatchlisted", () => {
    const item = { id: "1", isWatchlisted: true };
    expect(ev(item, rule("isWatchlisted", "isNotNull"))).toBe(true);
    expect(ev(item, rule("isWatchlisted", "isNotNull", "", { negate: true }))).toBe(false);
    expect(ev(item, rule("isWatchlisted", "isNull"))).toBe(false);
    expect(ev(item, rule("isWatchlisted", "isNull", "", { negate: true }))).toBe(true);
    expect(ev(item, rule("isWatchlisted", "equals", "TRUE"))).toBe(true);
    expect(ev(item, rule("isWatchlisted", "notEquals", "true"))).toBe(false);
    expect(ev(item, rule("isWatchlisted", "equals", "true", { negate: true }))).toBe(false);
  });

  it("watchedByUser", () => {
    expect(ev({ id: "1", watchedByUsers: ["alice"] }, rule("watchedByUser", "equals", "alice"))).toBe(true);
    expect(ev({ id: "1", watchHistory: [{ serverUsername: "bob" }, { serverUsername: null }] }, rule("watchedByUser", "equals", "bob"))).toBe(true);
    expect(ev({ id: "1" }, rule("watchedByUser", "isNull"))).toBe(true);
    expect(ev({ id: "1", watchedByUsers: ["a"] }, rule("watchedByUser", "equals", "a", { negate: true }))).toBe(false);
  });
});

describe("dates", () => {
  const item = { id: "1", lastPlayedAt: "2024-05-10T12:00:00Z", seriesLastPlayedAt: "2024-05-10T12:00:00Z" };
  it("operators", () => {
    expect(ev(item, rule("lastPlayedAt", "before", "2024-06-01"))).toBe(true);
    expect(ev(item, rule("lastPlayedAt", "after", "2024-06-01"))).toBe(false);
    expect(ev(item, rule("lastPlayedAt", "equals", "2024-05-10"))).toBe(true);
    expect(ev(item, rule("lastPlayedAt", "notEquals", "2024-05-10"))).toBe(false);
    expect(ev(item, rule("seriesLastPlayedAt", "between", "2024-5-1,2024-5-31"))).toBe(true);
    expect(ev(item, rule("lastPlayedAt", "isNotNull"))).toBe(true);
    expect(ev(item, rule("lastPlayedAt", "isNull"))).toBe(false);
    expect(ev(item, rule("lastPlayedAt", "before", "2024-06-01", { negate: true }))).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-05-20T00:00:00Z"));
    expect(ev(item, rule("lastPlayedAt", "inLastDays", "30"))).toBe(true);
    expect(ev(item, rule("lastPlayedAt", "notInLastDays", "30"))).toBe(false);
  });

  it("missing and invalid dates", () => {
    expect(ev({ id: "2", addedAt: "garbage" }, rule("addedAt", "isNull"))).toBe(true);
    expect(ev({ id: "2" }, rule("addedAt", "after", "2000-01-01"))).toBe(false);
    expect(ev({ id: "2" }, rule("addedAt", "notEquals", "2000-01-01"))).toBe(true);
  });
});

describe("numeric fields", () => {
  it("operators and nulls", () => {
    const item = { id: "1", rating: 7.5, watchedEpisodePercentage: 50 };
    expect(ev(item, rule("rating", "greaterThan", "7"))).toBe(true);
    expect(ev(item, rule("rating", "between", "7,8"))).toBe(true);
    expect(ev(item, rule("watchedEpisodePercentage", "lessThan", "50"))).toBe(false);
    expect(ev(item, rule("rating", "isNull"))).toBe(false);
    expect(ev(item, rule("rating", "isNotNull"))).toBe(true);
    expect(ev({ id: "2" }, rule("rating", "notEquals", "1"))).toBe(true);
    expect(ev({ id: "2" }, rule("rating", "equals", "1", { negate: true }))).toBe(true);
  });
});

describe("resolution", () => {
  const item = { id: "1", resolution: "2160" };
  it("normalizes labels", () => {
    expect(ev(item, rule("resolution", "equals", "4k"))).toBe(true);
    expect(ev(item, rule("resolution", "notEquals", "4K"))).toBe(false);
    expect(ev(item, rule("resolution", "contains", "1080P|4K"))).toBe(true);
    expect(ev(item, rule("resolution", "notContains", "4K"))).toBe(false);
    expect(ev(item, rule("resolution", "matchesWildcard", "4*"))).toBe(true);
    expect(ev(item, rule("resolution", "notMatchesWildcard", "4*"))).toBe(false);
    expect(ev(item, rule("resolution", "isNotNull"))).toBe(true);
    expect(ev({ id: "2", resolution: "" }, rule("resolution", "isNull"))).toBe(true);
    expect(ev({ id: "2" }, rule("resolution", "notContains", "4K"))).toBe(true);
    expect(ev({ id: "2" }, rule("resolution", "equals", "4K", { negate: true }))).toBe(true);
  });
});

describe("text fields", () => {
  it("free text vs enumerable, wildcards, nulls", () => {
    const item = { id: "1", title: "Star Wars", videoCodec: "hevc" };
    expect(ev(item, rule("title", "contains", "trek|wars"))).toBe(true);
    expect(ev(item, rule("title", "notContains", "wars"))).toBe(false);
    expect(ev(item, rule("videoCodec", "contains", "hev"))).toBe(false);
    expect(ev(item, rule("videoCodec", "notContains", "h264"))).toBe(true);
    expect(ev(item, rule("title", "notEquals", "x"))).toBe(true);
    expect(ev(item, rule("title", "matchesWildcard", "*wars"))).toBe(true);
    expect(ev(item, rule("title", "notMatchesWildcard", "*wars"))).toBe(false);
    expect(ev({ id: "2" }, rule("studio", "matchesWildcard", "*"))).toBe(false);
    expect(ev({ id: "2" }, rule("studio", "notMatchesWildcard", "*"))).toBe(true);
    expect(ev({ id: "2" }, rule("studio", "equals", "x"))).toBe(false);
    expect(ev({ id: "2" }, rule("studio", "notEquals", "x"))).toBe(true);
    expect(ev({ id: "2", studio: "" }, rule("studio", "isNull"))).toBe(true);
    expect(ev({ id: "2", studio: "Fox" }, rule("studio", "isNotNull", "", { negate: true }))).toBe(false);
  });
});

describe("stream-query groups", () => {
  const video = { streamType: 1, codec: "hevc", videoRangeType: "HDR10", width: 3840, bitDepth: null, isDefault: true, forced: null };
  const a1 = { streamType: 2, codec: "eac3", language: "English", channels: 6, isDefault: true, forced: null, displayTitle: "English DD+ 5.1", extendedDisplayTitle: "", profile: null };
  const a2 = { streamType: 2, codec: "aac", language: "German", channels: null, isDefault: false, forced: false, displayTitle: "German", extendedDisplayTitle: null, profile: "lc" };
  const item = { id: "1", streams: [video, a1, a2] };
  const sqg = (streamType: "audio" | "video" | "subtitle", rules: QueryRule[], quantifier?: "any" | "none" | "all") =>
    group(rules, { streamQuery: quantifier ? { streamType, quantifier } : { streamType } });
  const sq = (g: QueryGroup) => evaluateAllQueryRulesInMemory([g], item, undefined, undefined);

  it("boolean fields", () => {
    expect(sq(sqg("audio", [rule("sqIsDefault", "equals", "false")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqIsDefault", "notEquals", "false")], "all"))).toBe(false);
    expect(sq(sqg("audio", [rule("sqIsDefault", "equals", "true", { negate: true })], "none"))).toBe(false);
    expect(sq(sqg("audio", [rule("sqIsDefault", "isNull", "")]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqIsDefault", "isNotNull", "", { negate: true })]))).toBe(false);
  });

  it("numeric fields incl. NULL channels", () => {
    expect(sq(sqg("audio", [rule("sqChannels", "greaterThan", "2")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqChannels", "between", "5,7")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqChannels", "isNull", "")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqChannels", "isNotNull", "")], "all"))).toBe(false);
    // NULL channels: comparison false, negated true.
    expect(sq(sqg("audio", [rule("sqChannels", "greaterThan", "10", { negate: true })], "all"))).toBe(true);
    expect(sq(sqg("audio", [rule("sqChannels", "between", "1,10", { negate: true })], "none"))).toBe(false);
    expect(sq(sqg("video", [rule("sqBitDepth", "between", "8,12")]))).toBe(false);
  });

  it("text fields and computed fields", () => {
    expect(sq(sqg("audio", [rule("sqCodec", "contains", "eac3|dts")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqCodec", "notContains", "eac3|aac")]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqDisplayTitle", "contains", "dd+")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqDisplayTitle", "notContains", "e")], "none"))).toBe(true);
    expect(sq(sqg("audio", [rule("sqLanguage", "equals", "german")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqLanguage", "notEquals", "german")], "all"))).toBe(false);
    expect(sq(sqg("audio", [rule("sqProfile", "isNull", "")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqExtDisplayTitle", "isNotNull", "")]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqLanguage", "matchesWildcard", "eng*")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqLanguage", "notMatchesWildcard", "*")]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqLanguage", "equals", "german", { negate: true })], "all"))).toBe(false);
    expect(sq(sqg("video", [rule("sqDynamicRange", "equals", "HDR10")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqAudioProfile", "isNull", "")], "all"))).toBe(true);
  });

  it("guards, disabled rules, quantifiers", () => {
    expect(sq(sqg("audio", [rule("sqCodec", "contains", "")], "none"))).toBe(false);
    expect(sq(sqg("audio", [rule("title", "equals", "x")], "none"))).toBe(false);
    expect(sq(sqg("audio", [rule("sqChannels", "equals", "x")], "none"))).toBe(false);
    expect(sq(sqg("audio", [rule("sqCodec", "equals", "aac", { enabled: false })]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqCodec", "equals", "flac")], "none"))).toBe(true);
    expect(sq(sqg("subtitle", [rule("sqCodec", "equals", "srt")], "all"))).toBe(false);
  });
});
