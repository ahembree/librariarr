import { describe, it, expect, vi, afterEach } from "vitest";
import {
  evaluateAllRulesInMemory,
  getActualValuesForAllRules,
  getMatchedCriteriaForItems,
  type ArrMetadata,
  type SeerrMetadata,
} from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

const MB = 1024 * 1024;

function rule(field: string, operator: string, value: string | number = "", extra: Partial<LifecycleRule> = {}): LifecycleRule {
  return { id: `${field}-${operator}`, field, operator, value, condition: "AND", ...extra };
}

function group(rules: LifecycleRule[], extra: Partial<LifecycleRuleGroup> = {}): LifecycleRuleGroup {
  return { id: "g1", condition: "AND", rules, groups: [], ...extra };
}

/** Evaluate one rule (wrapped in a group) against an item. */
function ev(item: Record<string, unknown>, r: LifecycleRule, arr?: ArrMetadata, seerr?: SeerrMetadata) {
  return evaluateAllRulesInMemory([group([r])], item, arr, seerr);
}

const audio = (language: string | null, codec: string | null = "aac") => ({ streamType: 2, language, codec });
const sub = (language: string | null) => ({ streamType: 3, language, codec: "srt" });

afterEach(() => {
  vi.useRealTimers();
});

describe("evaluateAllRulesInMemory — structure", () => {
  it("empty, all-disabled and empty groups are never a match", () => {
    expect(evaluateAllRulesInMemory([], { id: "1" })).toBe(false);
    expect(evaluateAllRulesInMemory([group([rule("title", "equals", "x")], { enabled: false })], { id: "1", title: "x" })).toBe(false);
    expect(evaluateAllRulesInMemory([group([])], { id: "1" })).toBe(false);
    expect(evaluateAllRulesInMemory([rule("title", "equals", "x", { enabled: false })], { id: "1", title: "x" })).toBe(false);
  });

  it("groups combine by their own AND/OR condition, sub-groups too", () => {
    const item = { id: "1", title: "Alien", year: 1979 };
    const yes = rule("title", "equals", "alien");
    const no = rule("year", "equals", "2000");
    expect(evaluateAllRulesInMemory([group([yes]), group([no], { id: "g2", condition: "OR" })], item)).toBe(true);
    expect(evaluateAllRulesInMemory([group([yes]), group([no], { id: "g2", condition: "AND" })], item)).toBe(false);
    const withSub = group([no], { groups: [group([yes], { id: "s", condition: "OR" })] });
    expect(evaluateAllRulesInMemory([withSub], item)).toBe(true);
    const withDisabledSub = group([yes], { groups: [group([no], { id: "s", enabled: false })] });
    expect(evaluateAllRulesInMemory([withDisabledSub], item)).toBe(true);
    expect(evaluateAllRulesInMemory([group([no, { ...yes, condition: "OR" }])], item)).toBe(true);
  });

  it("group negation is pushed down before evaluation", () => {
    const item = { id: "1", title: "Alien" };
    expect(evaluateAllRulesInMemory([group([rule("title", "equals", "alien")], { negate: true })], item)).toBe(false);
  });

  it("legacy flat rules: OR inside a bucket, AND between buckets", () => {
    const item = { id: "1", title: "Alien", year: 1979, studio: "Fox" };
    const rules = [
      rule("title", "equals", "nope", { condition: "OR" }),
      rule("year", "equals", "1979", { condition: "AND" }),
      rule("studio", "equals", "fox"),
    ];
    expect(evaluateAllRulesInMemory(rules, item)).toBe(true);
    expect(evaluateAllRulesInMemory([rule("year", "equals", "1979"), rule("studio", "equals", "mgm")], item)).toBe(false);
  });
});

describe("dead rules", () => {
  it("a stream-query field outside a stream group matches nothing, even negated", () => {
    expect(ev({ id: "1", streams: [audio("English")] }, rule("sqCodec", "equals", "aac", { negate: true }))).toBe(false);
  });
});

describe("stream language / codec fields", () => {
  const item = { id: "1", streams: [audio("English", "dts"), audio("Unknown", "aac"), sub("French"), sub("")] };

  it("value operators", () => {
    expect(ev(item, rule("audioLanguage", "equals", "english"))).toBe(true);
    expect(ev(item, rule("audioLanguage", "notEquals", "english"))).toBe(false);
    expect(ev(item, rule("audioLanguage", "contains", "German|English"))).toBe(true);
    expect(ev(item, rule("audioLanguage", "notContains", "German"))).toBe(true);
    expect(ev(item, rule("subtitleLanguage", "matchesWildcard", "fr*"))).toBe(true);
    expect(ev(item, rule("subtitleLanguage", "notMatchesWildcard", "fr*"))).toBe(false);
    expect(ev(item, rule("streamAudioCodec", "contains", "aac"))).toBe(true);
    expect(ev(item, rule("audioLanguage", "equals", "english", { negate: true }))).toBe(false);
  });

  it("an item with no known language matches no value operator, even negated", () => {
    const unknownOnly = { id: "2", streams: [audio("Unknown")] };
    expect(ev(unknownOnly, rule("audioLanguage", "notEquals", "English"))).toBe(false);
    expect(ev(unknownOnly, rule("audioLanguage", "equals", "English", { negate: true }))).toBe(false);
  });

  it("isNull / isNotNull consider only known values (raw for codecs)", () => {
    expect(ev(item, rule("audioLanguage", "isNotNull"))).toBe(true);
    expect(ev({ id: "3", streams: [audio("unknown"), audio(null)] }, rule("audioLanguage", "isNull"))).toBe(true);
    expect(ev({ id: "3", streams: [audio(null, "")] }, rule("streamAudioCodec", "isNotNull"))).toBe(true);
    expect(ev({ id: "3", streams: [audio(null, null)] }, rule("streamAudioCodec", "isNull"))).toBe(true);
    expect(ev({ id: "3" }, rule("subtitleLanguage", "isNull", "", { negate: true }))).toBe(false);
  });
});

describe("stream count fields", () => {
  const item = { id: "1", streams: [audio("a"), audio("b"), sub("c")] };
  it("counts streams of the type", () => {
    expect(ev(item, rule("audioStreamCount", "equals", "2"))).toBe(true);
    expect(ev(item, rule("audioStreamCount", "notEquals", "2"))).toBe(false);
    expect(ev(item, rule("audioStreamCount", "greaterThan", "1"))).toBe(true);
    expect(ev(item, rule("audioStreamCount", "greaterThanOrEqual", "3"))).toBe(false);
    expect(ev(item, rule("subtitleStreamCount", "lessThan", "2"))).toBe(true);
    expect(ev(item, rule("subtitleStreamCount", "lessThanOrEqual", "0"))).toBe(false);
    expect(ev(item, rule("subtitleStreamCount", "between", "1,1"))).toBe(true);
    expect(ev({ id: "2" }, rule("subtitleStreamCount", "isNull"))).toBe(true);
    expect(ev(item, rule("subtitleStreamCount", "isNotNull", "", { negate: true }))).toBe(false);
  });
});

describe("array / external id / watchlist / watched-by", () => {
  it("genre, labels, country", () => {
    const item = { id: "1", genres: ["Sci-Fi"], labels: ["Kids"], countries: ["USA"] };
    expect(ev(item, rule("genre", "contains", "sci-fi"))).toBe(true);
    expect(ev(item, rule("labels", "contains", "kids", { negate: true }))).toBe(false);
    expect(ev(item, rule("country", "equals", "usa"))).toBe(true);
  });

  it("hasExternalId", () => {
    const item = { id: "1", externalIds: [{ source: "TMDB", externalId: "1" }] };
    expect(ev(item, rule("hasExternalId", "equals", "TMDB"))).toBe(true);
    expect(ev(item, rule("hasExternalId", "equals", "TMDB", { negate: true }))).toBe(false);
  });

  it("isWatchlisted", () => {
    const item = { id: "1", isWatchlisted: true };
    expect(ev(item, rule("isWatchlisted", "isNotNull"))).toBe(true);
    expect(ev(item, rule("isWatchlisted", "isNotNull", "", { negate: true }))).toBe(false);
    expect(ev(item, rule("isWatchlisted", "isNull"))).toBe(false);
    expect(ev(item, rule("isWatchlisted", "isNull", "", { negate: true }))).toBe(true);
    expect(ev(item, rule("isWatchlisted", "equals", "true"))).toBe(true);
    expect(ev(item, rule("isWatchlisted", "notEquals", "true"))).toBe(false);
    expect(ev({ id: "2" }, rule("isWatchlisted", "equals", "false", { negate: true }))).toBe(false);
  });

  it("watchedByUser reads aggregated users or raw history", () => {
    expect(ev({ id: "1", watchedByUsers: ["alice"] }, rule("watchedByUser", "equals", "Alice"))).toBe(true);
    expect(ev({ id: "1", watchHistory: [{ serverUsername: "bob" }, { serverUsername: null }] }, rule("watchedByUser", "contains", "bob"))).toBe(true);
    expect(ev({ id: "1" }, rule("watchedByUser", "isNull"))).toBe(true);
    expect(ev({ id: "1", watchedByUsers: ["alice"] }, rule("watchedByUser", "equals", "alice", { negate: true }))).toBe(false);
  });
});

describe("cross-system fields", () => {
  it("serverCount defaults to 1", () => {
    const item = { id: "1", serverCount: 2 };
    expect(ev(item, rule("serverCount", "equals", "2"))).toBe(true);
    expect(ev(item, rule("serverCount", "notEquals", "2"))).toBe(false);
    expect(ev(item, rule("serverCount", "greaterThan", "1"))).toBe(true);
    expect(ev(item, rule("serverCount", "greaterThanOrEqual", "3"))).toBe(false);
    expect(ev(item, rule("serverCount", "lessThan", "3"))).toBe(true);
    expect(ev(item, rule("serverCount", "lessThanOrEqual", "1"))).toBe(false);
    expect(ev(item, rule("serverCount", "between", "2,5"))).toBe(true);
    expect(ev({ id: "2" }, rule("serverCount", "equals", "1"))).toBe(true);
    expect(ev(item, rule("serverCount", "isNull"))).toBe(false);
    expect(ev(item, rule("serverCount", "isNull", "", { negate: true }))).toBe(true);
    expect(ev(item, rule("serverCount", "isNotNull"))).toBe(true);
    expect(ev(item, rule("serverCount", "isNotNull", "", { negate: true }))).toBe(false);
    expect(ev(item, rule("serverCount", "equals", "2", { negate: true }))).toBe(false);
  });

  it("matchedByRuleSet and hasPendingAction", () => {
    const item = { id: "1", matchedRuleSets: ["Keep"], hasPendingAction: true };
    expect(ev(item, rule("matchedByRuleSet", "contains", "keep"))).toBe(true);
    expect(ev(item, rule("matchedByRuleSet", "contains", "keep", { negate: true }))).toBe(false);
    expect(ev(item, rule("hasPendingAction", "equals", "true"))).toBe(true);
    expect(ev(item, rule("hasPendingAction", "notEquals", "true"))).toBe(false);
    expect(ev(item, rule("hasPendingAction", "isNull"))).toBe(false);
    expect(ev(item, rule("hasPendingAction", "isNull", "", { negate: true }))).toBe(true);
    expect(ev(item, rule("hasPendingAction", "isNotNull"))).toBe(true);
    expect(ev(item, rule("hasPendingAction", "isNotNull", "", { negate: true }))).toBe(false);
    expect(ev({ id: "2" }, rule("hasPendingAction", "equals", "true", { negate: true }))).toBe(true);
  });
});

describe("fileSize / duration", () => {
  it("fileSize compares MB against bytes", () => {
    const item = { id: "1", fileSize: String(100 * MB) };
    expect(ev(item, rule("fileSize", "greaterThan", "50"))).toBe(true);
    expect(ev(item, rule("fileSize", "greaterThanOrEqual", "100"))).toBe(true);
    expect(ev(item, rule("fileSize", "lessThan", "100"))).toBe(false);
    expect(ev(item, rule("fileSize", "lessThanOrEqual", "100"))).toBe(true);
    expect(ev(item, rule("fileSize", "equals", "100"))).toBe(true);
    expect(ev(item, rule("fileSize", "notEquals", "100"))).toBe(false);
    expect(ev(item, rule("fileSize", "between", "50,150"))).toBe(true);
    expect(ev(item, rule("fileSize", "between", "50,150", { negate: true }))).toBe(false);
    expect(ev(item, rule("fileSize", "isNull"))).toBe(false);
    expect(ev({ id: "2", fileSize: null }, rule("fileSize", "isNull"))).toBe(true);
  });

  it("a NULL fileSize follows Phase 1's null shapes", () => {
    const item = { id: "2", fileSize: null };
    expect(ev(item, rule("fileSize", "notEquals", "1"))).toBe(true);
    expect(ev(item, rule("fileSize", "greaterThan", "1"))).toBe(false);
    expect(ev(item, rule("fileSize", "greaterThan", "1", { negate: true }))).toBe(true);
  });

  it("duration compares minutes against ms", () => {
    const item = { id: "1", duration: 90 * 60_000 };
    expect(ev(item, rule("duration", "greaterThan", "60"))).toBe(true);
    expect(ev(item, rule("duration", "greaterThanOrEqual", "90"))).toBe(true);
    expect(ev(item, rule("duration", "lessThan", "90"))).toBe(false);
    expect(ev(item, rule("duration", "lessThanOrEqual", "89"))).toBe(false);
    expect(ev(item, rule("duration", "equals", "90"))).toBe(true);
    expect(ev(item, rule("duration", "notEquals", "90"))).toBe(false);
    expect(ev(item, rule("duration", "between", "60,120"))).toBe(true);
    expect(ev(item, rule("duration", "isNotNull"))).toBe(true);
    expect(ev({ id: "2" }, rule("duration", "isNull"))).toBe(true);
    expect(ev({ id: "2" }, rule("duration", "lessThan", "5"))).toBe(false);
    expect(ev({ id: "2" }, rule("duration", "notEquals", "5", { negate: true }))).toBe(false);
  });
});

describe("date fields", () => {
  const item = { id: "1", addedAt: "2024-05-10T12:00:00Z" };
  it("comparisons", () => {
    expect(ev(item, rule("addedAt", "before", "2024-06-01"))).toBe(true);
    expect(ev(item, rule("addedAt", "after", "2024-06-01"))).toBe(false);
    expect(ev(item, rule("addedAt", "equals", "2024-05-10"))).toBe(true);
    expect(ev(item, rule("addedAt", "notEquals", "2024-05-10"))).toBe(false);
    expect(ev(item, rule("addedAt", "between", "2024-5-1,2024-5-31"))).toBe(true);
    expect(ev(item, rule("addedAt", "isNotNull"))).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-05-20T00:00:00Z"));
    expect(ev(item, rule("addedAt", "inLastDays", "30"))).toBe(true);
    expect(ev(item, rule("addedAt", "notInLastDays", "30"))).toBe(false);
  });

  it("missing or invalid dates", () => {
    // An unparseable date is not "empty" to isNull (only null/""), but no comparison can match it.
    expect(ev({ id: "2", addedAt: "garbage" }, rule("addedAt", "isNull"))).toBe(false);
    expect(ev({ id: "2", addedAt: "garbage" }, rule("addedAt", "after", "2000-01-01"))).toBe(false);
    expect(ev({ id: "2", addedAt: "garbage" }, rule("addedAt", "notEquals", "2000-01-01"))).toBe(true);
    expect(ev({ id: "2" }, rule("addedAt", "before", "2024-01-01"))).toBe(false);
    expect(ev({ id: "2" }, rule("addedAt", "notEquals", "2024-01-01"))).toBe(true);
    expect(ev({ id: "2" }, rule("addedAt", "inLastDays", "5", { negate: true }))).toBe(true);
  });
});

describe("numeric fields", () => {
  const item = { id: "1", year: 1999 };
  it("comparisons and nulls", () => {
    expect(ev(item, rule("year", "equals", "1999"))).toBe(true);
    expect(ev(item, rule("year", "notEquals", "1999"))).toBe(false);
    expect(ev(item, rule("year", "greaterThan", "1990"))).toBe(true);
    expect(ev(item, rule("year", "greaterThanOrEqual", "2000"))).toBe(false);
    expect(ev(item, rule("year", "lessThan", "2000"))).toBe(true);
    expect(ev(item, rule("year", "lessThanOrEqual", "1998"))).toBe(false);
    expect(ev(item, rule("year", "between", "1990,2000"))).toBe(true);
    expect(ev(item, rule("year", "isNull"))).toBe(false);
    expect(ev({ id: "2" }, rule("year", "isNotNull", "", { negate: true }))).toBe(true);
    expect(ev({ id: "2" }, rule("year", "notEquals", "1"))).toBe(true);
    expect(ev({ id: "2" }, rule("year", "equals", "1"))).toBe(false);
  });
});

describe("resolution", () => {
  const item = { id: "1", resolution: "1080" };
  it("normalizes both sides to labels", () => {
    expect(ev(item, rule("resolution", "equals", "1080P"))).toBe(true);
    expect(ev(item, rule("resolution", "notEquals", "4k"))).toBe(true);
    expect(ev(item, rule("resolution", "contains", "720|1080p"))).toBe(true);
    expect(ev(item, rule("resolution", "notContains", "1080P"))).toBe(false);
    expect(ev(item, rule("resolution", "matchesWildcard", "1080*"))).toBe(true);
    expect(ev(item, rule("resolution", "notMatchesWildcard", "1080*"))).toBe(false);
    expect(ev(item, rule("resolution", "equals", "1080P", { negate: true }))).toBe(false);
    expect(ev(item, rule("resolution", "isNotNull"))).toBe(true);
    expect(ev({ id: "2", resolution: "" }, rule("resolution", "isNull"))).toBe(true);
    expect(ev({ id: "2", resolution: null }, rule("resolution", "notEquals", "4K"))).toBe(true);
    expect(ev({ id: "2", resolution: null }, rule("resolution", "equals", "4K"))).toBe(false);
  });
});

describe("text fields", () => {
  it("free-text vs enumerable contains", () => {
    const item = { id: "1", title: "Star Wars", videoCodec: "hevc" };
    expect(ev(item, rule("title", "contains", "wars|trek"))).toBe(true);
    expect(ev(item, rule("title", "notContains", "trek"))).toBe(true);
    expect(ev(item, rule("videoCodec", "contains", "he"))).toBe(false);
    expect(ev(item, rule("videoCodec", "contains", "h264|hevc"))).toBe(true);
    expect(ev(item, rule("videoCodec", "notContains", "hevc"))).toBe(false);
    expect(ev(item, rule("title", "notEquals", "star wars"))).toBe(false);
    expect(ev(item, rule("title", "matchesWildcard", "star*"))).toBe(true);
    expect(ev(item, rule("title", "notMatchesWildcard", "star*"))).toBe(false);
  });

  it("null and empty text", () => {
    expect(ev({ id: "1", studio: "" }, rule("studio", "isNull"))).toBe(true);
    expect(ev({ id: "1", studio: "Fox" }, rule("studio", "isNotNull", "", { negate: true }))).toBe(false);
    expect(ev({ id: "1" }, rule("studio", "notContains", "x"))).toBe(true);
    expect(ev({ id: "1" }, rule("studio", "contains", "x"))).toBe(false);
  });
});

describe("stream-query groups in memory", () => {
  const video = {
    streamType: 1, codec: "hevc", profile: "main 10", language: null, bitDepth: 10, width: 3840, height: 2160,
    frameRate: 23.976, videoRangeType: "DOVI", isDefault: true, forced: null, displayTitle: "4K DoVi", extendedDisplayTitle: null,
  };
  const atmos = {
    streamType: 2, codec: "truehd", profile: "truehd", language: "English", channels: 8, isDefault: true, forced: null,
    displayTitle: "English (TrueHD 7.1)", extendedDisplayTitle: "English (TrueHD 7.1 Atmos)", bitrate: null,
  };
  const stereo = {
    streamType: 2, codec: "aac", profile: "lc", language: "Japanese", channels: 2, isDefault: false, forced: false,
    displayTitle: "Japanese", extendedDisplayTitle: "", bitrate: 256,
  };
  const item = { id: "1", streams: [video, atmos, stereo] };
  const sqg = (streamType: "audio" | "video" | "subtitle", rules: LifecycleRule[], quantifier?: "any" | "none" | "all") =>
    group(rules, { streamQuery: quantifier ? { streamType, quantifier } : { streamType } });
  const sq = (g: LifecycleRuleGroup) => evaluateAllRulesInMemory([g], item);

  it("boolean fields", () => {
    expect(sq(sqg("audio", [rule("sqIsDefault", "equals", "true")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqIsDefault", "notEquals", "true")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqForced", "isNull", "")]))).toBe(true); // audio streams carry forced = null
    expect(sq(sqg("subtitle", [rule("sqForced", "isNull", "")]))).toBe(false); // no subtitle streams
    expect(sq(sqg("audio", [rule("sqIsDefault", "equals", "true", { negate: true })], "all"))).toBe(false);
  });

  it("numeric fields incl. null bitrate", () => {
    expect(sq(sqg("audio", [rule("sqChannels", "equals", "8")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqChannels", "notEquals", "8")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqChannels", "greaterThan", "8")]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqChannels", "greaterThanOrEqual", "8")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqChannels", "lessThan", "2")]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqChannels", "lessThanOrEqual", "2")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqChannels", "between", "3,7")]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqBitrate", "isNull", "")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqBitrate", "isNotNull", "")], "all"))).toBe(false);
    // NULL bitrate: comparison false, negated comparison true.
    expect(sq(sqg("audio", [rule("sqBitrate", "greaterThan", "100", { negate: true })], "all"))).toBe(false);
    expect(sq(sqg("audio", [rule("sqBitrate", "lessThan", "100", { negate: true })], "all"))).toBe(true);
  });

  it("text fields", () => {
    expect(sq(sqg("audio", [rule("sqCodec", "contains", "dts|aac")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqCodec", "notContains", "truehd|aac")]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqDisplayTitle", "contains", "trueHD")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqDisplayTitle", "notContains", "e")], "none"))).toBe(true);
    expect(sq(sqg("audio", [rule("sqLanguage", "notEquals", "english")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqExtDisplayTitle", "isNull", "")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqExtDisplayTitle", "isNotNull", "")], "all"))).toBe(false);
    expect(sq(sqg("audio", [rule("sqLanguage", "matchesWildcard", "jap*")]))).toBe(true);
    expect(sq(sqg("audio", [rule("sqLanguage", "notMatchesWildcard", "*")]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqLanguage", "equals", "english", { negate: true })], "all"))).toBe(false);
  });

  it("computed fields", () => {
    expect(sq(sqg("audio", [rule("sqAudioProfile", "equals", "Dolby Atmos")]))).toBe(true);
    expect(sq(sqg("video", [rule("sqDynamicRange", "contains", "Dolby Vision|HDR10")]))).toBe(true);
  });

  it("guards make the group unsatisfiable, and none/all quantifiers", () => {
    expect(sq(sqg("audio", [rule("sqCodec", "contains", "")], "none"))).toBe(false);
    expect(sq(sqg("audio", [rule("title", "equals", "x")], "none"))).toBe(false);
    expect(sq(sqg("audio", [rule("sqChannels", "greaterThan", "x")], "none"))).toBe(false);
    expect(sq(sqg("audio", [rule("sqCodec", "equals", "aac", { enabled: false })]))).toBe(false);
    expect(sq(sqg("audio", [rule("sqCodec", "equals", "dts")], "none"))).toBe(true);
    expect(sq(sqg("audio", [rule("sqChannels", "greaterThanOrEqual", "2")], "all"))).toBe(true);
    expect(evaluateAllRulesInMemory([sqg("subtitle", [rule("sqCodec", "equals", "srt")], "all")], item)).toBe(false);
  });
});

const arrMeta: ArrMetadata = {
  arrId: 1, tags: ["keep"], qualityProfile: "HD", monitored: true, rating: 7, tmdbRating: null, rtCriticRating: 80,
  dateAdded: "2024-01-01T00:00:00Z", path: "/m/a", sizeOnDisk: 1536 * MB, originalLanguage: null, releaseDate: null,
  inCinemasDate: "2023-01-01T00:00:00Z", runtime: 120, qualityName: "Bluray", qualityCutoffMet: true, customFormatScore: 5,
  downloadDate: null, firstAired: null, seasonCount: 2, episodeCount: null, status: "ended", ended: false, seriesType: null,
  hasUnaired: null, monitoredSeasonCount: 1, monitoredEpisodeCount: 4,
};

describe("getActualValuesForAllRules", () => {
  const allArr = ["foundInArr", "arrTag", "arrQualityProfile", "arrMonitored", "arrRating", "arrTmdbRating", "arrRtCriticRating",
    "arrDateAdded", "arrReleaseDate", "arrInCinemasDate", "arrDownloadDate", "arrFirstAired", "arrSizeOnDisk", "arrRuntime",
    "arrSeasonCount", "arrEpisodeCount", "arrMonitoredSeasonCount", "arrMonitoredEpisodeCount", "arrCustomFormatScore",
    "arrQualityCutoffMet", "arrEnded", "arrHasUnaired", "arrPath", "arrOriginalLanguage", "arrQualityName", "arrStatus", "arrSeriesType"];

  it("formats every Arr field, with N/A for nulls", () => {
    const rules = [group(allArr.map((f) => rule(f, "isNotNull")))];
    const items = [{ id: "m1", externalIds: [{ source: "TMDB", externalId: "603" }] }];
    const vals = getActualValuesForAllRules(items, rules, "MOVIE", { "603": arrMeta })!.get("m1")!;
    expect(vals.get("foundInArr-isNotNull")).toBe("true");
    expect(vals.get("arrTag-isNotNull")).toBe("keep");
    expect(vals.get("arrQualityProfile-isNotNull")).toBe("HD");
    expect(vals.get("arrMonitored-isNotNull")).toBe("true");
    expect(vals.get("arrRating-isNotNull")).toBe("7");
    expect(vals.get("arrTmdbRating-isNotNull")).toBe("N/A");
    expect(vals.get("arrRtCriticRating-isNotNull")).toBe("80");
    expect(vals.get("arrReleaseDate-isNotNull")).toBe("N/A");
    expect(vals.get("arrInCinemasDate-isNotNull")).toMatch(/2023/);
    expect(vals.get("arrSizeOnDisk-isNotNull")).toBe("1536 MB");
    expect(vals.get("arrRuntime-isNotNull")).toBe("120 min");
    expect(vals.get("arrEpisodeCount-isNotNull")).toBe("N/A");
    expect(vals.get("arrSeasonCount-isNotNull")).toBe("2");
    expect(vals.get("arrMonitoredSeasonCount-isNotNull")).toBe("1");
    expect(vals.get("arrMonitoredEpisodeCount-isNotNull")).toBe("4");
    expect(vals.get("arrCustomFormatScore-isNotNull")).toBe("5");
    expect(vals.get("arrQualityCutoffMet-isNotNull")).toBe("true");
    expect(vals.get("arrEnded-isNotNull")).toBe("false");
    expect(vals.get("arrHasUnaired-isNotNull")).toBe("N/A");
    expect(vals.get("arrPath-isNotNull")).toBe("/m/a");
    expect(vals.get("arrOriginalLanguage-isNotNull")).toBe("N/A");
    expect(vals.get("arrQualityName-isNotNull")).toBe("Bluray");
    expect(vals.get("arrStatus-isNotNull")).toBe("ended");
    expect(vals.get("arrSeriesType-isNotNull")).toBe("N/A");
  });

  it("all-null Arr metadata reads N/A, empty tags read none", () => {
    const nulls = Object.fromEntries(Object.entries(arrMeta).map(([k, v]) => [k, typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? null : v])) as unknown as ArrMetadata;
    nulls.tags = [];
    nulls.qualityProfile = "";
    nulls.monitored = false;
    const rules = [group(allArr.map((f) => rule(f, "isNull")))];
    const items = [{ id: "s1", externalIds: [{ source: "TVDB", externalId: "9" }] }];
    const vals = getActualValuesForAllRules(items, rules, "SERIES", { "9": nulls }).get("s1")!;
    expect(vals.get("arrTag-isNull")).toBe("none");
    for (const f of allArr.filter((x) => !["foundInArr", "arrTag", "arrQualityProfile", "arrMonitored"].includes(x))) {
      expect(vals.get(`${f}-isNull`)).toBe("N/A");
    }
  });

  it("without Arr data: foundInArr false, others N/A (no Arr data)", () => {
    const vals = getActualValuesForAllRules([{ id: "x" }], [group([rule("foundInArr", "equals", "true"), rule("arrTag", "isNull")])], "MUSIC").get("x")!;
    expect(vals.get("foundInArr-equals")).toBe("false");
    expect(vals.get("arrTag-isNull")).toBe("N/A (no Arr data)");
  });

  it("formats Seerr fields with and without metadata", () => {
    const seerrFields = ["seerrRequested", "seerrRequestCount", "seerrRequestDate", "seerrApprovalDate", "seerrDeclineDate", "seerrRequestedBy"];
    const rules = [group(seerrFields.map((f) => rule(f, "isNotNull")))];
    const seerrData = { "TMDB:1": { requested: true, requestCount: 3, requestDate: "2024-01-01T00:00:00Z", requestedBy: ["a", "b"], approvalDate: null, declineDate: null } };
    const items = [{ id: "a", externalIds: [{ source: "TMDB", externalId: "1" }] }, { id: "b", externalIds: [] }];
    const res = getActualValuesForAllRules(items, rules, "MOVIE", undefined, seerrData);
    const a = res.get("a")!;
    expect(a.get("seerrRequested-isNotNull")).toBe("true");
    expect(a.get("seerrRequestCount-isNotNull")).toBe("3");
    expect(a.get("seerrRequestDate-isNotNull")).toMatch(/2024/);
    expect(a.get("seerrApprovalDate-isNotNull")).toBe("N/A");
    expect(a.get("seerrRequestedBy-isNotNull")).toBe("a, b");
    const b = res.get("b")!;
    expect(b.get("seerrRequested-isNotNull")).toBe("false");
    expect(b.get("seerrRequestedBy-isNotNull")).toBe("none");
    expect(b.get("seerrDeclineDate-isNotNull")).toBe("N/A");
  });

  it("formats library fields", () => {
    const fields: Array<[string, string]> = [
      ["audioLanguage", "isNull"], ["subtitleLanguage", "isNull"], ["streamAudioCodec", "isNull"],
      ["audioStreamCount", "isNull"], ["subtitleStreamCount", "isNull"], ["genre", "isNull"], ["labels", "isNull"],
      ["country", "isNull"], ["hasExternalId", "isNull"], ["isWatchlisted", "isNull"], ["watchedByUser", "isNull"],
      ["fileSize", "isNull"], ["duration", "isNull"], ["addedAt", "isNull"], ["year", "isNull"],
      ["watchedEpisodePercentage", "isNull"], ["studio", "isNull"], ["title", "isNull"],
    ];
    const rules = [group(fields.map(([f, o]) => rule(f, o)))];
    const full = {
      id: "f", streams: [audio("English", "dts"), audio("English", "aac"), audio("unknown"), sub("French")],
      genres: ["Drama"], labels: [], countries: ["UK", "US"], externalIds: [{ source: "IMDB", externalId: "tt1" }],
      isWatchlisted: true, watchHistory: [{ serverUsername: "a" }, { serverUsername: "a" }, { serverUsername: null }],
      fileSize: String(2048 * MB), duration: 5_400_000, addedAt: "2024-01-15T00:00:00Z", year: 2001,
      watchedEpisodePercentage: 33.333, studio: null, title: "T",
    };
    const v = getActualValuesForAllRules([full], rules, "MOVIE").get("f")!;
    expect(v.get("audioLanguage-isNull")).toBe("English");
    expect(v.get("subtitleLanguage-isNull")).toBe("French");
    expect(v.get("streamAudioCodec-isNull")).toBe("dts, aac");
    expect(v.get("audioStreamCount-isNull")).toBe("3");
    expect(v.get("subtitleStreamCount-isNull")).toBe("1");
    expect(v.get("genre-isNull")).toBe("Drama");
    expect(v.get("labels-isNull")).toBe("none");
    expect(v.get("country-isNull")).toBe("UK, US");
    expect(v.get("hasExternalId-isNull")).toBe("IMDB");
    expect(v.get("isWatchlisted-isNull")).toBe("true");
    expect(v.get("watchedByUser-isNull")).toBe("a");
    expect(v.get("fileSize-isNull")).toBe("2.0 GB");
    expect(v.get("duration-isNull")).toBe("90 min");
    expect(v.get("addedAt-isNull")).toMatch(/2024/);
    expect(v.get("year-isNull")).toBe("2001");
    expect(v.get("watchedEpisodePercentage-isNull")).toBe("33.3%");
    expect(v.get("studio-isNull")).toBe("N/A");
    expect(v.get("title-isNull")).toBe("T");

    const empty = getActualValuesForAllRules([{ id: "e", fileSize: String(10 * MB), watchedByUsers: [] }], rules, "MOVIE").get("e")!;
    expect(empty.get("audioLanguage-isNull")).toBe("none");
    expect(empty.get("genre-isNull")).toBe("none");
    expect(empty.get("hasExternalId-isNull")).toBe("none");
    expect(empty.get("watchedByUser-isNull")).toBe("none");
    expect(empty.get("fileSize-isNull")).toBe("10 MB");
    expect(empty.get("duration-isNull")).toBe("0 min");
    expect(empty.get("addedAt-isNull")).toBe("N/A");
    expect(empty.get("year-isNull")).toBe("0");
    expect(empty.get("watchedEpisodePercentage-isNull")).toBe("0.0%");
    expect(getActualValuesForAllRules([{ id: "z" }], rules, "MOVIE").get("z")!.get("fileSize-isNull")).toBe("0");
  });

  it("skips stream-query groups and returns nothing for misplaced stream-query fields", () => {
    const rules = [
      group([rule("sqCodec", "equals", "aac")]),
      group([rule("sqCodec", "equals", "aac", { id: "inSq" })], { id: "sq", streamQuery: { streamType: "audio" } }),
      group([rule("year", "equals", "1")], { id: "off", enabled: false }),
    ];
    const v = getActualValuesForAllRules([{ id: "i" }], rules, "MOVIE").get("i")!;
    expect(v.size).toBe(0);
  });

  it("works for legacy flat rules", () => {
    const v = getActualValuesForAllRules([{ id: "i", year: 5 }], [rule("year", "equals", "5"), rule("title", "isNull", "", { enabled: false })], "MOVIE").get("i")!;
    expect([...v.entries()]).toEqual([["year-equals", "5"]]);
  });
});

describe("getMatchedCriteriaForItems", () => {
  it("decorates units and day counts, labels operators, records group names", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-05-20T00:00:00Z"));
    const rules = [group([
      rule("fileSize", "greaterThan", "10"),
      rule("addedAt", "inLastDays", "30"),
      rule("arrSizeOnDisk", "greaterThan", "1"),
      rule("year", "equals", "1", { negate: true }),
    ], { name: "Big" })];
    const item = { id: "m", fileSize: String(100 * MB), addedAt: "2024-05-10T00:00:00Z", year: 2000, externalIds: [{ source: "TMDB", externalId: "7" }] };
    const crit = getMatchedCriteriaForItems([item], rules, "MOVIE", { "7": arrMeta }).get("m")!;
    expect(crit.map((c) => [c.field, c.operator, c.value, c.negate, c.groupName])).toEqual([
      ["File Size (MB)", ">", "10 MB", false, "Big"],
      [expect.any(String), "in last", "30 days", false, "Big"],
      [expect.any(String), ">", "1 MB", false, "Big"],
      [expect.any(String), "=", "1", true, "Big"],
    ]);
    expect(crit[2].actualValue).toBe("1536 MB");
  });

  it("reports a matched stream-query group as one criterion", () => {
    const sqGroup = group(
      [rule("sqCodec", "equals", "aac"), rule("sqChannels", "greaterThan", "1", { negate: true }), rule("sqLanguage", "equals", "x", { enabled: false })],
      { id: "sq", name: "Audio", streamQuery: { streamType: "audio" } },
    );
    const item = { id: "m", streams: [{ streamType: 2, codec: "aac", channels: 1 }] };
    const crit = getMatchedCriteriaForItems([item], [sqGroup], "MUSIC").get("m")!;
    expect(crit).toHaveLength(1);
    expect(crit[0]).toMatchObject({ ruleId: "sq", field: "Stream Query (audio)", operator: "matched", groupName: "Audio" });
    expect(crit[0].value).toBe("Codec = aac, NOT Channels > 1");
    expect(getMatchedCriteriaForItems([{ id: "n", streams: [] }], [sqGroup], "MUSIC").get("n")).toEqual([]);
  });
});
