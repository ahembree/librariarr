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

function matched(items: Array<Record<string, unknown>>, rules: Rule[] | RuleGroup[]) {
  return getMatchedCriteriaForItems(items, rules, "MOVIE");
}

// ---------------------------------------------------------------------------
// Shared test items
// ---------------------------------------------------------------------------

const multiStreamItem = {
  id: "1",
  streams: [
    { streamType: 2, language: "English", codec: "aac" },
    { streamType: 2, language: "Spanish", codec: "ac3" },
    { streamType: 3, language: "English", codec: "srt" },
    { streamType: 3, language: "French", codec: "srt" },
    { streamType: 3, language: "German", codec: "ass" },
  ],
};

const noStreamsItem = { id: "2", streams: [] };

const audioOnlyItem = {
  id: "3",
  streams: [
    { streamType: 2, language: "Japanese", codec: "flac" },
  ],
};

// ---------------------------------------------------------------------------
// 1. audioLanguage (streamType 2, language field)
// ---------------------------------------------------------------------------

describe("audioLanguage stream evaluation", () => {
  it("equals matches audio stream language (case-insensitive)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "english" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("equals matches with different casing", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "SPANISH" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("equals does not match when no audio stream has that language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "French" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("notEquals when no audio stream has that language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notEquals", value: "Japanese" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notEquals fails when an audio stream has that language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notEquals", value: "English" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("contains matches single value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "contains", value: "span" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("contains matches pipe-separated values", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "contains", value: "german|spanish" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("contains fails when no audio language matches any pipe value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "contains", value: "french|german" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("notContains succeeds when no audio language contains the value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notContains", value: "japanese" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notContains fails when an audio language contains the value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notContains", value: "eng" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("matchesWildcard matches audio stream language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "matchesWildcard", value: "eng*" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("matchesWildcard fails when no audio language matches the pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "matchesWildcard", value: "fre*" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("notMatchesWildcard succeeds when no audio language matches the pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notMatchesWildcard", value: "jap*" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notMatchesWildcard fails when an audio language matches the pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notMatchesWildcard", value: "spa*" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("ignores non-audio streams (streamType 3 should not count)", () => {
    // French is only a subtitle language, not an audio language
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "French" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("empty streams array returns false for equals", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "English" })])];
    const result = matched([noStreamsItem], rules);
    expect(result.get("2")).toHaveLength(0);
  });

  it("multiple audio streams — matches if ANY has the language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "Spanish" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. subtitleLanguage (streamType 3, language field)
// ---------------------------------------------------------------------------

describe("subtitleLanguage stream evaluation", () => {
  it("equals matches subtitle stream language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "equals", value: "French" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("equals is case-insensitive", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "equals", value: "GERMAN" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notEquals succeeds when no subtitle stream has that language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "notEquals", value: "Spanish" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notEquals fails when a subtitle stream has that language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "notEquals", value: "English" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("contains matches substring in subtitle language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "contains", value: "ger" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("matchesWildcard matches subtitle language pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "matchesWildcard", value: "fre*" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("ignores non-subtitle streams (streamType 2 should not count)", () => {
    // Spanish is only an audio language, not a subtitle language
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "equals", value: "Spanish" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("equals fails on item with only audio streams", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "equals", value: "Japanese" })])];
    const result = matched([audioOnlyItem], rules);
    expect(result.get("3")).toHaveLength(0);
  });

  it("notContains succeeds when no subtitle language contains the value", () => {
    // multiStreamItem subtitles: English, French, German — none contain "Jap"
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "notContains", value: "Jap" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notContains fails when a subtitle language contains the value", () => {
    // multiStreamItem subtitles: English, French, German — "English" contains "Eng"
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "notContains", value: "Eng" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("notMatchesWildcard succeeds when no subtitle language matches the pattern", () => {
    // multiStreamItem subtitles: English, French, German — none match "Jap*"
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "notMatchesWildcard", value: "Jap*" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notMatchesWildcard fails when a subtitle language matches the pattern", () => {
    // multiStreamItem subtitles: English, French, German — "English" matches "Eng*"
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "notMatchesWildcard", value: "Eng*" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. streamAudioCodec (streamType 2, codec field)
// ---------------------------------------------------------------------------

describe("streamAudioCodec stream evaluation", () => {
  it("equals matches audio stream codec", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "equals", value: "aac" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("equals is case-insensitive", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "equals", value: "AAC" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("equals fails when no audio stream has that codec", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "equals", value: "dts" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("notEquals succeeds when no audio stream has that codec", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "notEquals", value: "flac" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notEquals fails when an audio stream has that codec", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "notEquals", value: "ac3" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("contains matches substring in audio codec", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "contains", value: "ac" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("matchesWildcard matches audio codec pattern", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "matchesWildcard", value: "a*" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("reads codec field, not language field", () => {
    // "English" is the language, not codec — should not match
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "equals", value: "English" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("ignores subtitle stream codecs (only checks streamType 2)", () => {
    // "srt" and "ass" are subtitle codecs, not audio codecs
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "equals", value: "srt" })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("notContains succeeds when no audio codec contains the value", () => {
    // audioOnlyItem audio codec: flac — does not contain "mp3"
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "notContains", value: "mp3" })])];
    const result = matched([audioOnlyItem], rules);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });

  it("notContains fails when an audio codec contains the value", () => {
    // audioOnlyItem audio codec: flac — "flac" contains "fla"
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "notContains", value: "fla" })])];
    const result = matched([audioOnlyItem], rules);
    expect(result.get("3")).toHaveLength(0);
  });

  it("notMatchesWildcard succeeds when no audio codec matches the pattern", () => {
    // audioOnlyItem audio codec: flac — does not match "mp*"
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "notMatchesWildcard", value: "mp*" })])];
    const result = matched([audioOnlyItem], rules);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });

  it("notMatchesWildcard fails when an audio codec matches the pattern", () => {
    // audioOnlyItem audio codec: flac — "flac" matches "fl*"
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "notMatchesWildcard", value: "fl*" })])];
    const result = matched([audioOnlyItem], rules);
    expect(result.get("3")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. audioStreamCount (streamType 2, count)
// ---------------------------------------------------------------------------

describe("audioStreamCount stream evaluation", () => {
  it("equals matches correct audio stream count", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "equals", value: 2 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("equals fails when count does not match", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "equals", value: 3 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("notEquals succeeds when count differs", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "notEquals", value: 5 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notEquals fails when count matches", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "notEquals", value: 2 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("greaterThan matches when count exceeds value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "greaterThan", value: 1 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("greaterThan fails when count does not exceed value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "greaterThan", value: 2 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("greaterThanOrEqual matches when count equals value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "greaterThanOrEqual", value: 2 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("lessThan matches when count is less than value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "lessThan", value: 3 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("lessThan fails when count is not less than value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "lessThan", value: 2 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("lessThanOrEqual matches when count equals value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "lessThanOrEqual", value: 2 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("counts ONLY streamType 2 (ignores subtitle streams)", () => {
    // multiStreamItem has 2 audio (type 2) and 3 subtitle (type 3) streams
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "equals", value: 5 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("no streams results in count of 0", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "equals", value: 0 })])];
    const result = matched([noStreamsItem], rules);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("no streams — greaterThan 0 fails", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "greaterThan", value: 0 })])];
    const result = matched([noStreamsItem], rules);
    expect(result.get("2")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. subtitleStreamCount (streamType 3, count)
// ---------------------------------------------------------------------------

describe("subtitleStreamCount stream evaluation", () => {
  it("equals matches correct subtitle stream count", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "equals", value: 3 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("equals fails when count does not match", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "equals", value: 2 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("greaterThan matches when count exceeds value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "greaterThan", value: 2 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("lessThan matches when count is less than value", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "lessThan", value: 4 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("counts ONLY streamType 3 (ignores audio streams)", () => {
    // multiStreamItem has 3 subtitle (type 3) streams, not 5 total
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "equals", value: 5 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("no streams results in count of 0", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "equals", value: 0 })])];
    const result = matched([noStreamsItem], rules);
    expect(result.get("2")!.length).toBeGreaterThan(0);
  });

  it("counts 0 for item with only audio streams", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "equals", value: 0 })])];
    const result = matched([audioOnlyItem], rules);
    expect(result.get("3")!.length).toBeGreaterThan(0);
  });

  it("notEquals succeeds when count differs", () => {
    // multiStreamItem has 3 subtitle streams, 3 != 2
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "notEquals", value: 2 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("notEquals fails when count matches", () => {
    // multiStreamItem has 3 subtitle streams, 3 == 3
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "notEquals", value: 3 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")).toHaveLength(0);
  });

  it("greaterThanOrEqual matches when count equals value", () => {
    // multiStreamItem has 3 subtitle streams, 3 >= 3
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "greaterThanOrEqual", value: 3 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("lessThanOrEqual matches when count equals value", () => {
    // multiStreamItem has 3 subtitle streams, 3 <= 3
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "lessThanOrEqual", value: 3 })])];
    const result = matched([multiStreamItem], rules);
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Negate flag
// ---------------------------------------------------------------------------

describe("negate flag on stream rules", () => {
  it("negate on audioLanguage equals inverts the result (match becomes no match)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "English", negate: true })])];
    const result = matched([multiStreamItem], rules);
    // English IS an audio language, so equals=true, negate flips to false
    expect(result.get("1")).toHaveLength(0);
  });

  it("negate on audioLanguage equals inverts the result (no match becomes match)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "Japanese", negate: true })])];
    const result = matched([multiStreamItem], rules);
    // Japanese is NOT an audio language, so equals=false, negate flips to true
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });

  it("negate on audioStreamCount greaterThan inverts the result (match becomes no match)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "greaterThan", value: 1, negate: true })])];
    const result = matched([multiStreamItem], rules);
    // count=2 > 1 is true, negate flips to false
    expect(result.get("1")).toHaveLength(0);
  });

  it("negate on audioStreamCount greaterThan inverts the result (no match becomes match)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "greaterThan", value: 5, negate: true })])];
    const result = matched([multiStreamItem], rules);
    // count=2 > 5 is false, negate flips to true
    expect(result.get("1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Unknown language filtering
// ---------------------------------------------------------------------------

describe("unknown language filtering", () => {
  const unknownAudioItem = {
    id: "u1",
    streams: [
      { streamType: 2, language: "Unknown", codec: "aac" },
    ],
  };

  const nullLanguageItem = {
    id: "u2",
    streams: [
      { streamType: 2, language: null, codec: "aac" },
    ],
  };

  const emptyLanguageItem = {
    id: "u3",
    streams: [
      { streamType: 2, language: "", codec: "aac" },
    ],
  };

  const mixedLanguageItem = {
    id: "u4",
    streams: [
      { streamType: 2, language: "English", codec: "aac" },
      { streamType: 2, language: "Unknown", codec: "ac3" },
    ],
  };

  const unknownSubtitleItem = {
    id: "u5",
    streams: [
      { streamType: 3, language: "Unknown", codec: "srt" },
    ],
  };

  // --- audioLanguage: items with ONLY unknown language should not match ---

  it("audioLanguage equals does not match item with only 'Unknown' language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "English" })])];
    const result = matched([unknownAudioItem], rules);
    expect(result.get("u1")).toHaveLength(0);
  });

  it("audioLanguage notEquals does not match item with only 'Unknown' language", () => {
    // Without filtering, "Unknown" != "English" would be true — item would wrongly match
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notEquals", value: "English" })])];
    const result = matched([unknownAudioItem], rules);
    expect(result.get("u1")).toHaveLength(0);
  });

  it("audioLanguage contains does not match item with only 'Unknown' language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "contains", value: "eng" })])];
    const result = matched([unknownAudioItem], rules);
    expect(result.get("u1")).toHaveLength(0);
  });

  it("audioLanguage notContains does not match item with only 'Unknown' language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notContains", value: "eng" })])];
    const result = matched([unknownAudioItem], rules);
    expect(result.get("u1")).toHaveLength(0);
  });

  it("audioLanguage matchesWildcard does not match item with only 'Unknown' language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "matchesWildcard", value: "Eng*" })])];
    const result = matched([unknownAudioItem], rules);
    expect(result.get("u1")).toHaveLength(0);
  });

  it("audioLanguage notMatchesWildcard does not match item with only 'Unknown' language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notMatchesWildcard", value: "Eng*" })])];
    const result = matched([unknownAudioItem], rules);
    expect(result.get("u1")).toHaveLength(0);
  });

  // --- null and empty language also excluded ---

  it("audioLanguage equals does not match item with null language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "English" })])];
    const result = matched([nullLanguageItem], rules);
    expect(result.get("u2")).toHaveLength(0);
  });

  it("audioLanguage notEquals does not match item with null language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notEquals", value: "English" })])];
    const result = matched([nullLanguageItem], rules);
    expect(result.get("u2")).toHaveLength(0);
  });

  it("audioLanguage notEquals does not match item with empty language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notEquals", value: "English" })])];
    const result = matched([emptyLanguageItem], rules);
    expect(result.get("u3")).toHaveLength(0);
  });

  // --- Mixed: known + unknown streams should still match on the known stream ---

  it("audioLanguage equals still matches when known language exists alongside Unknown", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "English" })])];
    const result = matched([mixedLanguageItem], rules);
    expect(result.get("u4")!.length).toBeGreaterThan(0);
  });

  it("audioLanguage notEquals still works with mixed known/unknown streams", () => {
    // English stream exists, so notEquals "English" should fail
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notEquals", value: "English" })])];
    const result = matched([mixedLanguageItem], rules);
    expect(result.get("u4")).toHaveLength(0);
  });

  // --- subtitleLanguage also filters unknown ---

  it("subtitleLanguage equals does not match item with only 'Unknown' subtitle language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "equals", value: "English" })])];
    const result = matched([unknownSubtitleItem], rules);
    expect(result.get("u5")).toHaveLength(0);
  });

  it("subtitleLanguage notEquals does not match item with only 'Unknown' subtitle language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "notEquals", value: "English" })])];
    const result = matched([unknownSubtitleItem], rules);
    expect(result.get("u5")).toHaveLength(0);
  });

  // --- streamAudioCodec is NOT affected by unknown language filtering ---

  it("streamAudioCodec still evaluates normally (no unknown filtering)", () => {
    // The unknown language item has codec "aac" — streamAudioCodec rules should still match it
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "equals", value: "aac" })])];
    const result = matched([unknownAudioItem], rules);
    expect(result.get("u1")!.length).toBeGreaterThan(0);
  });

  // --- Case insensitive: "unknown" and "UNKNOWN" should also be filtered ---

  it("audioLanguage filters 'unknown' case-insensitively", () => {
    const lowerCaseUnknown = { id: "u6", streams: [{ streamType: 2, language: "unknown", codec: "aac" }] };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "notEquals", value: "English" })])];
    const result = matched([lowerCaseUnknown], rules);
    expect(result.get("u6")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. isNull / isNotNull on stream language fields
// ---------------------------------------------------------------------------

describe("isNull / isNotNull on stream fields", () => {
  const knownLanguageItem = {
    id: "n1",
    streams: [
      { streamType: 2, language: "English", codec: "aac" },
    ],
  };

  const unknownOnlyItem = {
    id: "n2",
    streams: [
      { streamType: 2, language: "Unknown", codec: "aac" },
    ],
  };

  const nullLanguageItem = {
    id: "n3",
    streams: [
      { streamType: 2, language: null, codec: "aac" },
    ],
  };

  const noStreamsItem = { id: "n4", streams: [] };

  const mixedItem = {
    id: "n5",
    streams: [
      { streamType: 2, language: "English", codec: "aac" },
      { streamType: 2, language: "Unknown", codec: "ac3" },
    ],
  };

  // --- audioLanguage isNull ---

  it("audioLanguage isNull matches item with no audio streams", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNull", value: "" })])];
    const result = matched([noStreamsItem], rules);
    expect(result.get("n4")!.length).toBeGreaterThan(0);
  });

  it("audioLanguage isNull matches item with only Unknown language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNull", value: "" })])];
    const result = matched([unknownOnlyItem], rules);
    expect(result.get("n2")!.length).toBeGreaterThan(0);
  });

  it("audioLanguage isNull matches item with only null language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNull", value: "" })])];
    const result = matched([nullLanguageItem], rules);
    expect(result.get("n3")!.length).toBeGreaterThan(0);
  });

  it("audioLanguage isNull does NOT match item with known language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNull", value: "" })])];
    const result = matched([knownLanguageItem], rules);
    expect(result.get("n1")).toHaveLength(0);
  });

  it("audioLanguage isNull does NOT match item with mixed known+unknown", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNull", value: "" })])];
    const result = matched([mixedItem], rules);
    expect(result.get("n5")).toHaveLength(0);
  });

  // --- audioLanguage isNotNull ---

  it("audioLanguage isNotNull matches item with known language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNotNull", value: "" })])];
    const result = matched([knownLanguageItem], rules);
    expect(result.get("n1")!.length).toBeGreaterThan(0);
  });

  it("audioLanguage isNotNull matches item with mixed known+unknown", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNotNull", value: "" })])];
    const result = matched([mixedItem], rules);
    expect(result.get("n5")!.length).toBeGreaterThan(0);
  });

  it("audioLanguage isNotNull does NOT match item with only Unknown language", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNotNull", value: "" })])];
    const result = matched([unknownOnlyItem], rules);
    expect(result.get("n2")).toHaveLength(0);
  });

  it("audioLanguage isNotNull does NOT match item with no audio streams", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNotNull", value: "" })])];
    const result = matched([noStreamsItem], rules);
    expect(result.get("n4")).toHaveLength(0);
  });

  // --- subtitleLanguage isNull ---

  it("subtitleLanguage isNull matches item with no subtitle streams", () => {
    // knownLanguageItem only has audio streams, no subtitles
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "isNull", value: "" })])];
    const result = matched([knownLanguageItem], rules);
    expect(result.get("n1")!.length).toBeGreaterThan(0);
  });

  // --- streamAudioCodec isNull/isNotNull ---

  it("streamAudioCodec isNotNull matches item with codec", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "isNotNull", value: "" })])];
    const result = matched([knownLanguageItem], rules);
    expect(result.get("n1")!.length).toBeGreaterThan(0);
  });

  it("streamAudioCodec isNull matches item with no audio streams", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "streamAudioCodec", operator: "isNull", value: "" })])];
    const result = matched([noStreamsItem], rules);
    expect(result.get("n4")!.length).toBeGreaterThan(0);
  });

  // --- negate with isNull ---

  it("negate on audioLanguage isNull inverts the result", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "isNull", value: "", negate: true })])];
    // noStreamsItem has no audio language → isNull=true, negate flips to false
    const result = matched([noStreamsItem], rules);
    expect(result.get("n4")).toHaveLength(0);
  });
});
