import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ruleToWhere,
  UNSATISFIABLE_WHERE,
  isUnconfiguredContainsRule,
  FIELD_HANDLERS,
  STREAM_COUNT_FIELDS,
} from "@/lib/conditions/where-builder";
import { COMPLETED_PLAY_FILTER } from "@/lib/media/watch-completion";
import { MB_IN_BYTES, DURATION_MS_PER_MIN } from "@/lib/conditions/constants";
import type { Condition } from "@/lib/conditions/types";

const MATCH_ALL = { id: { not: "__librariarr_never_id__" } };

function w(field: string, operator: string, value: string | number = "", negate?: boolean) {
  const rule: Condition = { id: "r", field, operator, value, condition: "AND", negate };
  return ruleToWhere(rule);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isUnconfiguredContainsRule", () => {
  it("treats empty multi-selects and blank wildcard patterns as unconfigured", () => {
    expect(isUnconfiguredContainsRule("contains", "")).toBe(true);
    expect(isUnconfiguredContainsRule("notContains", " | |")).toBe(true);
    expect(isUnconfiguredContainsRule("contains", "a|")).toBe(false);
    expect(isUnconfiguredContainsRule("matchesWildcard", "  ")).toBe(true);
    expect(isUnconfiguredContainsRule("notMatchesWildcard", "*")).toBe(false);
    expect(isUnconfiguredContainsRule("equals", "")).toBe(false);
  });
});

describe("ruleToWhere — preamble and routing", () => {
  it("refuses unconfigured, inapplicable and malformed rules", () => {
    expect(w("studio", "contains", "|")).toBe(UNSATISFIABLE_WHERE);
    expect(w("year", "contains", "1999")).toBe(UNSATISFIABLE_WHERE);
    expect(w("unknownField", "equals", "x")).toBe(UNSATISFIABLE_WHERE);
    expect(w("year", "greaterThan", "abc")).toBe(UNSATISFIABLE_WHERE);
    expect(w("addedAt", "before", "not-a-date")).toBe(UNSATISFIABLE_WHERE);
  });

  it("leaves external, series-aggregate, cross-system and stream-count fields to Phase 2", () => {
    expect(w("arrTag", "equals", "keep")).toEqual({});
    expect(w("watchedEpisodeCount", "greaterThan", "3")).toEqual({});
    expect(w("serverCount", "greaterThan", "1")).toEqual({});
    expect(w("audioStreamCount", "greaterThan", "1")).toEqual({});
    expect(STREAM_COUNT_FIELDS.has("subtitleStreamCount")).toBe(true);
  });

  it("refuses a stream-query field outside a stream-query group", () => {
    expect(w("sqCodec", "equals", "aac")).toBe(UNSATISFIABLE_WHERE);
  });

  it("routes resolution and JSON-array fields to Phase 2", () => {
    expect(w("resolution", "equals", "1080P")).toEqual({});
    expect(w("genre", "contains", "Action")).toEqual({});
    expect(w("labels", "notContains", "Kids")).toEqual({});
    expect(w("country", "isNull")).toEqual({});
  });
});

describe("fileSize handler", () => {
  const mb = (n: number) => BigInt(Math.round(n * MB_IN_BYTES));
  it("converts MB to bytes for every comparison", () => {
    expect(w("fileSize", "greaterThan", "10")).toEqual({ fileSize: { gt: mb(10) } });
    expect(w("fileSize", "greaterThanOrEqual", "10")).toEqual({ fileSize: { gte: mb(10) } });
    expect(w("fileSize", "lessThan", "1.5")).toEqual({ fileSize: { lt: mb(1.5) } });
    expect(w("fileSize", "lessThanOrEqual", "1")).toEqual({ fileSize: { lte: mb(1) } });
    expect(w("fileSize", "equals", "2")).toEqual({ fileSize: mb(2) });
    expect(w("fileSize", "between", "1,2")).toEqual({ fileSize: { gte: mb(1), lte: mb(2) } });
  });

  it("notEquals and negated positives admit NULL file sizes", () => {
    expect(w("fileSize", "notEquals", "2")).toEqual({ OR: [{ fileSize: null }, { fileSize: { not: mb(2) } }] });
    expect(w("fileSize", "notEquals", "2", true)).toEqual({ NOT: { OR: [{ fileSize: null }, { fileSize: { not: mb(2) } }] } });
    expect(w("fileSize", "between", "1,2", true))
      .toEqual({ OR: [{ fileSize: null }, { NOT: { fileSize: { gte: mb(1), lte: mb(2) } } }] });
  });

  it("isNull / isNotNull with negate", () => {
    expect(w("fileSize", "isNull")).toEqual({ fileSize: null });
    expect(w("fileSize", "isNotNull", "", true)).toEqual({ NOT: { fileSize: { not: null } } });
  });
});

describe("duration handler", () => {
  const ms = (n: number) => n * DURATION_MS_PER_MIN;
  it("converts minutes to ms", () => {
    expect(w("duration", "greaterThan", "90")).toEqual({ duration: { gt: ms(90) } });
    expect(w("duration", "greaterThanOrEqual", "90")).toEqual({ duration: { gte: ms(90) } });
    expect(w("duration", "lessThan", "90")).toEqual({ duration: { lt: ms(90) } });
    expect(w("duration", "lessThanOrEqual", "90")).toEqual({ duration: { lte: ms(90) } });
    expect(w("duration", "equals", "1.5")).toEqual({ duration: Math.round(ms(1.5)) });
    expect(w("duration", "between", "30,60")).toEqual({ duration: { gte: ms(30), lte: ms(60) } });
  });

  it("negative and null forms", () => {
    expect(w("duration", "notEquals", "10")).toEqual({ OR: [{ duration: null }, { duration: { not: ms(10) } }] });
    expect(w("duration", "isNull")).toEqual({ duration: null });
    expect(w("duration", "isNotNull", "", true)).toEqual({ NOT: { duration: { not: null } } });
    expect(w("duration", "lessThan", "10", true)).toEqual({ OR: [{ duration: null }, { NOT: { duration: { lt: ms(10) } } }] });
  });
});

describe("isWatchlisted handler", () => {
  it("is non-nullable: isNull matches nothing, isNotNull everything", () => {
    expect(w("isWatchlisted", "isNull")).toBe(UNSATISFIABLE_WHERE);
    expect(w("isWatchlisted", "isNotNull")).toEqual(MATCH_ALL);
    expect(w("isWatchlisted", "isNotNull", "", true)).toEqual({ NOT: MATCH_ALL });
  });

  it("equals / notEquals and negate", () => {
    expect(w("isWatchlisted", "equals", "TRUE")).toEqual({ isWatchlisted: true });
    expect(w("isWatchlisted", "notEquals", "true")).toEqual({ isWatchlisted: false });
    expect(w("isWatchlisted", "equals", "false", true)).toEqual({ NOT: { isWatchlisted: false } });
  });
});

describe("date handler", () => {
  it("before / after are strict comparisons and admit NULL under negate", () => {
    expect(w("addedAt", "before", "2024-01-01")).toEqual({ addedAt: { lt: new Date("2024-01-01") } });
    expect(w("addedAt", "after", "2024-01-01", true))
      .toEqual({ OR: [{ addedAt: null }, { NOT: { addedAt: { gt: new Date("2024-01-01") } } }] });
  });

  it("inLastDays / notInLastDays use a rolling window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    const tenAgo = new Date("2025-06-15T12:00:00Z");
    tenAgo.setDate(tenAgo.getDate() - 10);
    expect(w("lastPlayedAt", "inLastDays", "10")).toEqual({ lastPlayedAt: { gte: tenAgo } });
    expect(w("lastPlayedAt", "notInLastDays", "10")).toEqual({ lastPlayedAt: { lt: tenAgo } });
  });

  it("equals / between span whole UTC days", () => {
    expect(w("originallyAvailableAt", "equals", "2024-03-01"))
      .toEqual({ originallyAvailableAt: { gte: new Date("2024-03-01"), lt: new Date("2024-03-02") } });
    expect(w("originallyAvailableAt", "between", "2024-03-01,2024-03-05"))
      .toEqual({ originallyAvailableAt: { gte: new Date("2024-03-01"), lt: new Date("2024-03-06") } });
  });

  it("notEquals is outside the day OR NULL; null checks", () => {
    expect(w("addedAt", "notEquals", "2024-03-01")).toEqual({
      OR: [
        { addedAt: null },
        { OR: [{ addedAt: { lt: new Date("2024-03-01") } }, { addedAt: { gte: new Date("2024-03-02") } }] },
      ],
    });
    expect(w("addedAt", "isNull")).toEqual({ addedAt: null });
    expect(w("addedAt", "isNotNull", "", true)).toEqual({ NOT: { addedAt: { not: null } } });
  });
});

describe("numeric handler", () => {
  it("emits comparisons for nullable columns", () => {
    expect(w("year", "equals", "2000")).toEqual({ year: 2000 });
    expect(w("year", "greaterThan", "2000")).toEqual({ year: { gt: 2000 } });
    expect(w("year", "greaterThanOrEqual", "2000")).toEqual({ year: { gte: 2000 } });
    expect(w("year", "lessThan", "2000")).toEqual({ year: { lt: 2000 } });
    expect(w("year", "lessThanOrEqual", "2000")).toEqual({ year: { lte: 2000 } });
    expect(w("year", "between", "1990,2000")).toEqual({ year: { gte: 1990, lte: 2000 } });
    expect(w("year", "notEquals", "2000")).toEqual({ OR: [{ year: null }, { year: { not: 2000 } }] });
    expect(w("year", "isNull")).toEqual({ year: null });
    expect(w("year", "isNotNull")).toEqual({ year: { not: null } });
  });

  it("does not add NULL-safety for the non-nullable playCount", () => {
    expect(w("playCount", "equals", "0", true)).toEqual({ NOT: { playCount: 0 } });
    expect(w("playCount", "notEquals", "0")).toEqual({ playCount: { not: 0 } });
    expect(w("playCount", "isNull")).toBe(UNSATISFIABLE_WHERE);
    expect(w("playCount", "isNotNull")).toEqual(MATCH_ALL);
    expect(w("playCount", "isNull", "", true)).toEqual({ NOT: UNSATISFIABLE_WHERE });
  });
});

describe("generic text handler", () => {
  it("equals / notEquals escape LIKE metacharacters", () => {
    expect(w("studio", "equals", "a_b")).toEqual({ studio: { equals: "a\\_b", mode: "insensitive" } });
    expect(w("studio", "equals", "a", true))
      .toEqual({ OR: [{ studio: null }, { NOT: { studio: { equals: "a", mode: "insensitive" } } }] });
    expect(w("studio", "notEquals", "50%"))
      .toEqual({ OR: [{ studio: null }, { studio: { not: "50\\%", mode: "insensitive" } }] });
    expect(w("title", "notEquals", "x")).toEqual({ title: { not: "x", mode: "insensitive" } });
  });

  it("contains on an enumerable field is list membership", () => {
    expect(w("videoCodec", "contains", "h264|hevc")).toEqual({
      OR: [
        { videoCodec: { equals: "h264", mode: "insensitive" } },
        { videoCodec: { equals: "hevc", mode: "insensitive" } },
      ],
    });
  });

  it("contains on a free-text field is substring search, OR-ed for several values", () => {
    expect(w("title", "contains", "star")).toEqual({ title: { contains: "star", mode: "insensitive" } });
    expect(w("title", "contains", "star|trek")).toEqual({
      OR: [
        { title: { contains: "star", mode: "insensitive" } },
        { title: { contains: "trek", mode: "insensitive" } },
      ],
    });
  });

  it("notContains variants include NULL rows on nullable columns", () => {
    expect(w("videoCodec", "notContains", "h264|hevc")).toEqual({
      OR: [
        { videoCodec: null },
        { AND: [
          { NOT: { videoCodec: { equals: "h264", mode: "insensitive" } } },
          { NOT: { videoCodec: { equals: "hevc", mode: "insensitive" } } },
        ] },
      ],
    });
    expect(w("parentTitle", "notContains", "a|b")).toEqual({
      OR: [
        { parentTitle: null },
        { AND: [
          { NOT: { parentTitle: { contains: "a", mode: "insensitive" } } },
          { NOT: { parentTitle: { contains: "b", mode: "insensitive" } } },
        ] },
      ],
    });
    expect(w("title", "notContains", "x")).toEqual({ NOT: { title: { contains: "x", mode: "insensitive" } } });
    expect(w("title", "notContains", "x", true)).toEqual({ NOT: { NOT: { title: { contains: "x", mode: "insensitive" } } } });
  });

  it("isNull / isNotNull differ between nullable and non-nullable text", () => {
    expect(w("title", "isNull")).toEqual({ title: "" });
    expect(w("title", "isNotNull")).toEqual({ NOT: { title: "" } });
    expect(w("studio", "isNull")).toEqual({ OR: [{ studio: null }, { studio: "" }] });
    expect(w("studio", "isNotNull")).toEqual({ AND: [{ studio: { not: null } }, { NOT: { studio: "" } }] });
  });

  it("wildcards fall through the generic handler as no constraint", () => {
    expect(w("title", "matchesWildcard", "Star*")).toEqual({});
  });
});

describe("hasExternalId handler", () => {
  it("list-emptiness and per-source operators", () => {
    expect(w("hasExternalId", "isNotNull")).toEqual({ externalIds: { some: {} } });
    expect(w("hasExternalId", "isNull")).toEqual({ externalIds: { none: {} } });
    expect(w("hasExternalId", "equals", "TMDB")).toEqual({ externalIds: { some: { source: "TMDB" } } });
    expect(w("hasExternalId", "notEquals", "TMDB")).toEqual({ externalIds: { none: { source: "TMDB" } } });
    expect(w("hasExternalId", "contains", "TMDB| IMDB")).toEqual({ externalIds: { some: { source: { in: ["TMDB", "IMDB"] } } } });
    expect(w("hasExternalId", "notContains", "TVDB")).toEqual({ externalIds: { none: { source: { in: ["TVDB"] } } } });
    expect(w("hasExternalId", "equals", "TMDB", true)).toEqual({ NOT: { externalIds: { some: { source: "TMDB" } } } });
  });

  it("wildcards resolve against the known source list", () => {
    expect(w("hasExternalId", "matchesWildcard", "t*")).toEqual({ externalIds: { some: { source: { in: ["TMDB", "TVDB"] } } } });
    expect(w("hasExternalId", "matchesWildcard", "zzz*")).toBe(UNSATISFIABLE_WHERE);
    expect(w("hasExternalId", "notMatchesWildcard", "*db")).toEqual({
      externalIds: { none: { source: { in: ["TMDB", "TVDB", "IMDB"] } } },
    });
  });
});

describe("stream relation handler", () => {
  const known = { language: { not: null, notIn: ["", "unknown"], mode: "insensitive" } };
  const guard = (streamType: number) => ({ streams: { some: { streamType, ...known } } });

  it("defers wildcards to Phase 2", () => {
    expect(w("audioLanguage", "matchesWildcard", "Eng*")).toEqual({});
  });

  it("equals on a language guards on a known language, after negate", () => {
    const eq = { streams: { some: { streamType: 2, ...known, language: { equals: "English", mode: "insensitive" } } } };
    expect(w("audioLanguage", "equals", "English")).toEqual({ AND: [guard(2), eq] });
    expect(w("audioLanguage", "equals", "English", true)).toEqual({ AND: [guard(2), { NOT: eq }] });
  });

  it("notEquals / contains / notContains on subtitle language", () => {
    const one = (v: string) => ({ streams: { some: { streamType: 3, ...known, language: { equals: v, mode: "insensitive" } } } });
    expect(w("subtitleLanguage", "notEquals", "English")).toEqual({ AND: [guard(3), { NOT: one("English") }] });
    expect(w("subtitleLanguage", "contains", "English|French")).toEqual({ AND: [guard(3), { OR: [one("English"), one("French")] }] });
    expect(w("subtitleLanguage", "notContains", "English")).toEqual({ AND: [guard(3), { AND: [{ NOT: one("English") }] }] });
  });

  it("codec fields carry no known-language guard", () => {
    expect(w("streamAudioCodec", "equals", "aac")).toEqual({
      streams: { some: { streamType: 2, codec: { equals: "aac", mode: "insensitive" } } },
    });
    expect(w("streamAudioCodec", "isNull")).toEqual({ NOT: { streams: { some: { streamType: 2, codec: { not: null } } } } });
    expect(w("streamAudioCodec", "isNotNull", "", true)).toEqual({ NOT: { streams: { some: { streamType: 2, codec: { not: null } } } } });
  });

  it("isNull / isNotNull on a language use the known-language filter", () => {
    expect(w("audioLanguage", "isNull")).toEqual({ NOT: { streams: { some: { streamType: 2, ...known } } } });
    expect(w("audioLanguage", "isNotNull")).toEqual({ streams: { some: { streamType: 2, ...known } } });
  });
});

describe("watchedByUser handler", () => {
  it("defers wildcards", () => {
    expect(w("watchedByUser", "notMatchesWildcard", "a*")).toEqual({});
  });

  it("scopes every form to completed plays", () => {
    expect(w("watchedByUser", "equals", "alice_smith")).toEqual({
      watchHistory: { some: { ...COMPLETED_PLAY_FILTER, serverUsername: { equals: "alice\\_smith", mode: "insensitive" } } },
    });
    expect(w("watchedByUser", "notEquals", "bob")).toEqual({
      watchHistory: { none: { ...COMPLETED_PLAY_FILTER, serverUsername: { equals: "bob", mode: "insensitive" } } },
    });
    expect(w("watchedByUser", "contains", "a_b|c")).toEqual({
      watchHistory: { some: { ...COMPLETED_PLAY_FILTER, serverUsername: { in: ["a_b", "c"], mode: "insensitive" } } },
    });
    expect(w("watchedByUser", "notContains", "a")).toEqual({
      watchHistory: { none: { ...COMPLETED_PLAY_FILTER, serverUsername: { in: ["a"], mode: "insensitive" } } },
    });
    expect(w("watchedByUser", "isNull")).toEqual({ watchHistory: { none: { ...COMPLETED_PLAY_FILTER } } });
    expect(w("watchedByUser", "isNotNull", "", true)).toEqual({ NOT: { watchHistory: { some: { ...COMPLETED_PLAY_FILTER } } } });
  });
});

describe("handler defaults", () => {
  it("returns no constraint for an operator a handler does not know", () => {
    expect(FIELD_HANDLERS.fileSize("before", "1", "fileSize")).toEqual({});
    expect(FIELD_HANDLERS.duration("before", "1", "duration")).toEqual({});
    expect(FIELD_HANDLERS.addedAt("greaterThan", "1", "addedAt")).toEqual({});
    expect(FIELD_HANDLERS.year("before", "1", "year")).toEqual({});
    expect(FIELD_HANDLERS.hasExternalId("before", "1", "hasExternalId")).toEqual({});
    expect(FIELD_HANDLERS.audioLanguage("before", "1", "audioLanguage")).toEqual({});
    expect(FIELD_HANDLERS.watchedByUser("before", "1", "watchedByUser")).toEqual({});
  });

  it("isWatchlisted refuses an unknown operator even when negated", () => {
    expect(FIELD_HANDLERS.isWatchlisted("contains", "x", "isWatchlisted", true)).toBe(UNSATISFIABLE_WHERE);
  });
});
