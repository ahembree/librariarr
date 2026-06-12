import { describe, it, expect } from "vitest";
import { getMatchedCriteriaForItems, evaluateAllRulesInMemory } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { buildStreamQueryClause } from "@/lib/conditions/stream-query-where";
import { UNSATISFIABLE_WHERE } from "@/lib/conditions/where-builder";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<LifecycleRule> & Pick<LifecycleRule, "field" | "operator" | "value">): LifecycleRule {
  return { id: "r1", condition: "AND", ...overrides };
}

function makeStreamQueryGroup(
  streamType: string,
  rules: LifecycleRule[],
  overrides?: Partial<LifecycleRuleGroup>,
): LifecycleRuleGroup {
  return {
    id: "sq1",
    condition: "AND",
    rules,
    groups: [],
    streamQuery: { streamType: streamType as "audio" | "video" | "subtitle" },
    ...overrides,
  };
}

function matched(items: Array<Record<string, unknown>>, groups: LifecycleRuleGroup[]) {
  return getMatchedCriteriaForItems(items, groups, "MOVIE");
}

// ---------------------------------------------------------------------------
// Shared test items
// ---------------------------------------------------------------------------

/** Item with English Atmos + Japanese stereo audio */
const atmosItem = {
  id: "atmos1",
  streams: [
    // English Dolby Atmos audio
    {
      streamType: 2, language: "English", languageCode: "eng", codec: "truehd",
      profile: "truehd", bitrate: 5000, isDefault: true, displayTitle: "English (TrueHD 7.1)",
      extendedDisplayTitle: "English (TrueHD 7.1 Atmos)", channels: 8, samplingRate: 48000,
      audioChannelLayout: "7.1", bitDepth: null, width: null, height: null,
      frameRate: null, scanType: null, videoRangeType: null, forced: null,
    },
    // Japanese stereo audio
    {
      streamType: 2, language: "Japanese", languageCode: "jpn", codec: "aac",
      profile: "lc", bitrate: 256, isDefault: false, displayTitle: "Japanese (AAC Stereo)",
      extendedDisplayTitle: "Japanese (AAC Stereo)", channels: 2, samplingRate: 48000,
      audioChannelLayout: "stereo", bitDepth: null, width: null, height: null,
      frameRate: null, scanType: null, videoRangeType: null, forced: null,
    },
    // Video stream with Dolby Vision
    {
      streamType: 1, language: null, languageCode: null, codec: "hevc",
      profile: "main 10", bitrate: 40000, isDefault: true, displayTitle: "4K (HEVC Main 10)",
      extendedDisplayTitle: "4K (HEVC Main 10)", channels: null, samplingRate: null,
      audioChannelLayout: null, bitDepth: 10, width: 3840, height: 2160,
      frameRate: 23.976, scanType: "progressive", videoRangeType: "DOVI", forced: null,
    },
    // English subtitle
    {
      streamType: 3, language: "English", languageCode: "eng", codec: "srt",
      profile: null, bitrate: null, isDefault: false, displayTitle: "English",
      extendedDisplayTitle: "English (SRT)", channels: null, samplingRate: null,
      audioChannelLayout: null, bitDepth: null, width: null, height: null,
      frameRate: null, scanType: null, videoRangeType: null, forced: false,
    },
  ],
};

/** Item with Japanese Atmos + English stereo */
const japaneseAtmosItem = {
  id: "atmos2",
  streams: [
    // Japanese Dolby Atmos audio
    {
      streamType: 2, language: "Japanese", languageCode: "jpn", codec: "truehd",
      profile: "truehd", bitrate: 5000, isDefault: true, displayTitle: "Japanese (TrueHD 7.1)",
      extendedDisplayTitle: "Japanese (TrueHD 7.1 Atmos)", channels: 8, samplingRate: 48000,
      audioChannelLayout: "7.1", bitDepth: null, width: null, height: null,
      frameRate: null, scanType: null, videoRangeType: null, forced: null,
    },
    // English stereo audio
    {
      streamType: 2, language: "English", languageCode: "eng", codec: "aac",
      profile: "lc", bitrate: 256, isDefault: false, displayTitle: "English (AAC Stereo)",
      extendedDisplayTitle: "English (AAC Stereo)", channels: 2, samplingRate: 48000,
      audioChannelLayout: "stereo", bitDepth: null, width: null, height: null,
      frameRate: null, scanType: null, videoRangeType: null, forced: null,
    },
  ],
};

/** Item with no streams */
const noStreamsItem = { id: "empty1", streams: [] };

// ---------------------------------------------------------------------------
// 1. Basic stream query — single condition
// ---------------------------------------------------------------------------

describe("stream query groups - single condition", () => {
  it("matches when an audio stream has matching codec", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqCodec", operator: "equals", value: "truehd" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });

  it("does not match when no stream has matching codec", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqCodec", operator: "equals", value: "dts" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")).toHaveLength(0);
  });

  it("does not match when item has no streams", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqCodec", operator: "equals", value: "truehd" }),
    ]);
    const result = matched([noStreamsItem], [group]);
    expect(result.get("empty1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Compound conditions on the SAME stream (the key use case)
// ---------------------------------------------------------------------------

describe("stream query groups - compound conditions on same stream", () => {
  it("matches when a SINGLE stream satisfies ALL conditions (Japanese Atmos item)", () => {
    // Find items with a non-English Atmos track
    const group = makeStreamQueryGroup("audio", [
      makeRule({ id: "r1", field: "sqAudioProfile", operator: "equals", value: "Dolby Atmos" }),
      makeRule({ id: "r2", field: "sqLanguage", operator: "notEquals", value: "English" }),
    ]);
    const result = matched([japaneseAtmosItem], [group]);
    expect(result.get("atmos2")!.length).toBeGreaterThan(0);
  });

  it("does NOT match when conditions span DIFFERENT streams (English Atmos + Japanese stereo)", () => {
    // atmosItem has English Atmos and Japanese stereo — no single stream is both Atmos AND non-English
    const group = makeStreamQueryGroup("audio", [
      makeRule({ id: "r1", field: "sqAudioProfile", operator: "equals", value: "Dolby Atmos" }),
      makeRule({ id: "r2", field: "sqLanguage", operator: "notEquals", value: "English" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")).toHaveLength(0);
  });

  it("matches codec + channels compound condition", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ id: "r1", field: "sqCodec", operator: "equals", value: "truehd" }),
      makeRule({ id: "r2", field: "sqChannels", operator: "greaterThanOrEqual", value: 6 }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });

  it("does not match codec + channels when no single stream satisfies both", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ id: "r1", field: "sqCodec", operator: "equals", value: "aac" }),
      makeRule({ id: "r2", field: "sqChannels", operator: "greaterThanOrEqual", value: 6 }),
    ]);
    // aac track has 2 channels, truehd track has 8 but is not aac
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Computed fields
// ---------------------------------------------------------------------------

describe("stream query groups - computed fields", () => {
  it("sqAudioProfile detects Dolby Atmos from extendedDisplayTitle", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqAudioProfile", operator: "equals", value: "Dolby Atmos" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });

  it("sqAudioProfile does not match non-Atmos streams", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqAudioProfile", operator: "equals", value: "DTS:X" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")).toHaveLength(0);
  });

  it("sqDynamicRange detects Dolby Vision from videoRangeType", () => {
    const group = makeStreamQueryGroup("video", [
      makeRule({ field: "sqDynamicRange", operator: "equals", value: "Dolby Vision" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });

  it("sqDynamicRange does not match wrong range", () => {
    const group = makeStreamQueryGroup("video", [
      makeRule({ field: "sqDynamicRange", operator: "equals", value: "HDR10" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Stream type filtering
// ---------------------------------------------------------------------------

describe("stream query groups - stream type filtering", () => {
  it("audio query ignores video and subtitle streams", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqCodec", operator: "equals", value: "hevc" }),
    ]);
    // hevc is on the video stream, not audio
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")).toHaveLength(0);
  });

  it("video query ignores audio streams", () => {
    const group = makeStreamQueryGroup("video", [
      makeRule({ field: "sqCodec", operator: "equals", value: "truehd" }),
    ]);
    // truehd is on an audio stream, not video
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")).toHaveLength(0);
  });

  it("subtitle query matches subtitle streams", () => {
    const group = makeStreamQueryGroup("subtitle", [
      makeRule({ field: "sqLanguage", operator: "equals", value: "English" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });

  it("subtitle forced field", () => {
    const group = makeStreamQueryGroup("subtitle", [
      makeRule({ field: "sqForced", operator: "equals", value: "false" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Boolean and numeric fields
// ---------------------------------------------------------------------------

describe("stream query groups - boolean and numeric fields", () => {
  it("sqIsDefault matches default track", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqIsDefault", operator: "equals", value: "true" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });

  it("sqChannels numeric comparison", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqChannels", operator: "lessThan", value: 4 }),
    ]);
    // Japanese stereo has 2 channels
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });

  it("sqBitrate numeric comparison", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqBitrate", operator: "greaterThan", value: 1000 }),
    ]);
    // Atmos track has 5000 bitrate
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });

  it("sqWidth numeric on video stream", () => {
    const group = makeStreamQueryGroup("video", [
      makeRule({ field: "sqWidth", operator: "greaterThanOrEqual", value: 3840 }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Disabled rules and groups
// ---------------------------------------------------------------------------

describe("stream query groups - disabled rules/groups", () => {
  it("disabled stream query group is skipped", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqCodec", operator: "equals", value: "nonexistent" }),
    ], { enabled: false });
    const result = matched([atmosItem], [group]);
    // Disabled group should not cause a non-match
    expect(result.get("atmos1")).toHaveLength(0);
  });

  it("disabled rules within stream query group are skipped", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ id: "r1", field: "sqCodec", operator: "equals", value: "truehd" }),
      makeRule({ id: "r2", field: "sqLanguage", operator: "equals", value: "nonexistent", enabled: false }),
    ]);
    const result = matched([atmosItem], [group]);
    // Only the enabled rule (sqCodec=truehd) should apply
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Wildcard operators (in-memory only)
// ---------------------------------------------------------------------------

describe("stream query groups - wildcard operators", () => {
  it("matchesWildcard on language", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqLanguage", operator: "matchesWildcard", value: "Eng*" }),
    ]);
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });

  it("notMatchesWildcard on language", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqLanguage", operator: "notMatchesWildcard", value: "Eng*" }),
    ]);
    // Japanese stream doesn't match Eng*, so this should match
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Negate on rules
// ---------------------------------------------------------------------------

describe("stream query groups - negate", () => {
  it("negate on a rule inverts match", () => {
    const group = makeStreamQueryGroup("audio", [
      makeRule({ field: "sqCodec", operator: "equals", value: "truehd", negate: true }),
    ]);
    // negate(equals truehd) means the stream's codec must NOT be truehd
    // The AAC stream satisfies this
    const result = matched([atmosItem], [group]);
    expect(result.get("atmos1")!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Audit regressions — Phase 1/Phase 2 parity for stream queries
// ---------------------------------------------------------------------------

describe("audit regressions: stream-query parity", () => {

  const sqGroup = (rules: Array<Record<string, unknown>>, quantifier: "any" | "none" | "all" = "any"): LifecycleRuleGroup => ({
    id: "g", condition: "AND",
    rules: rules.map((r, i) => ({ id: `r${i}`, condition: "AND", ...r } as never)),
    groups: [],
    streamQuery: { streamType: "audio", quantifier },
  });

  it("misplaced non-stream field fails the whole group in Phase 1 (no silent drop)", () => {
    const clause = buildStreamQueryClause(sqGroup([{ field: "title", operator: "equals", value: "x" }]));
    expect(clause).toEqual(UNSATISFIABLE_WHERE);
  });

  it("misplaced non-stream field fails the group in Phase 2 too (none stays closed)", () => {
    const groups = [sqGroup([{ field: "title", operator: "equals", value: "x" }], "none")];
    const item = { id: "1", streams: [{ streamType: 2, codec: "aac" }] };
    expect(evaluateAllRulesInMemory(groups, item)).toBe(false);
  });

  it("stream-query field in a PLAIN group is a dead rule, not a dropped constraint", () => {
    const groups: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND",
      rules: [{ id: "r", condition: "AND", field: "sqCodec", operator: "equals", value: "aac" } as never],
      groups: [],
    }];
    expect(evaluateAllRulesInMemory(groups, { id: "1", streams: [{ streamType: 2, codec: "aac" }] })).toBe(false);
  });

  it("negated positive numeric includes NULL streams in Phase 1 (OR column IS NULL)", () => {
    const clause = buildStreamQueryClause(sqGroup([
      { field: "sqBitrate", operator: "greaterThan", value: "1000", negate: true },
    ]));
    expect(JSON.stringify(clause)).toContain('"bitrate":null');
  });

  it("Phase 2 matches NULL-bitrate streams for negated greaterThan (parity)", () => {
    const groups = [sqGroup([{ field: "sqBitrate", operator: "greaterThan", value: "1000", negate: true }])];
    expect(evaluateAllRulesInMemory(groups, { id: "1", streams: [{ streamType: 2, bitrate: null }] })).toBe(true);
    expect(evaluateAllRulesInMemory(groups, { id: "2", streams: [{ streamType: 2, bitrate: 5000 }] })).toBe(false);
  });

  it("boolean equals false includes NULL streams in Phase 1 (Phase 2 coerces !!null)", () => {
    const clause = buildStreamQueryClause(sqGroup([{ field: "sqForced", operator: "equals", value: "false" }]));
    expect(JSON.stringify(clause)).toContain('"forced":null');
    // Phase 2 agreement
    const groups = [sqGroup([{ field: "sqForced", operator: "equals", value: "false" }])];
    expect(evaluateAllRulesInMemory(groups, { id: "1", streams: [{ streamType: 2, forced: null }] })).toBe(true);
  });

  it("boolean isNull is expressible in both phases (was silently dropped from Phase 1)", () => {
    const clause = buildStreamQueryClause(sqGroup([{ field: "sqForced", operator: "isNull", value: "" }]));
    expect(JSON.stringify(clause)).toContain('"forced":null');
    const groups = [sqGroup([{ field: "sqForced", operator: "isNull", value: "" }])];
    expect(evaluateAllRulesInMemory(groups, { id: "1", streams: [{ streamType: 2, forced: null }] })).toBe(true);
    expect(evaluateAllRulesInMemory(groups, { id: "2", streams: [{ streamType: 2, forced: true }] })).toBe(false);
  });

  it("stream counts support between / isNull / isNotNull in memory", () => {
    const countGroup = (operator: string, value: string): LifecycleRuleGroup[] => [{
      id: "g", condition: "AND",
      rules: [{ id: "r", condition: "AND", field: "audioStreamCount", operator, value } as never],
      groups: [],
    }];
    const twoAudio = { id: "1", streams: [{ streamType: 2 }, { streamType: 2 }, { streamType: 3 }] };
    const noAudio = { id: "2", streams: [{ streamType: 3 }] };
    expect(evaluateAllRulesInMemory(countGroup("between", "1,3"), twoAudio)).toBe(true);
    expect(evaluateAllRulesInMemory(countGroup("between", "3,5"), twoAudio)).toBe(false);
    expect(evaluateAllRulesInMemory(countGroup("isNull", ""), noAudio)).toBe(true);
    expect(evaluateAllRulesInMemory(countGroup("isNotNull", ""), twoAudio)).toBe(true);
    expect(evaluateAllRulesInMemory(countGroup("isNotNull", ""), noAudio)).toBe(false);
  });
});
