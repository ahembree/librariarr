import { describe, it, expect } from "vitest";
import { getMatchedCriteriaForItems } from "@/lib/rules/engine";
import type { Rule, RuleGroup } from "@/lib/rules/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<Rule> & Pick<Rule, "field" | "operator" | "value">): Rule {
  return { id: "r1", condition: "AND", ...overrides };
}

function makeStreamQueryGroup(
  streamType: string,
  rules: Rule[],
  overrides?: Partial<RuleGroup>,
): RuleGroup {
  return {
    id: "sq1",
    condition: "AND",
    rules,
    groups: [],
    streamQuery: { streamType: streamType as "audio" | "video" | "subtitle" },
    ...overrides,
  };
}

function matched(items: Array<Record<string, unknown>>, groups: RuleGroup[]) {
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
