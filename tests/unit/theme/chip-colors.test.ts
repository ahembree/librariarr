import { describe, it, expect } from "vitest";
import {
  DEFAULT_CHIP_COLORS,
  FALLBACK_HEX,
  AUDIO_CODEC_ORDER,
  COLOR_PALETTE,
  CHIP_CATEGORY_LABELS,
  CHIP_CATEGORY_ORDER,
  getChipBadgeStyle,
  getChipSolidStyle,
  mergeChipColors,
  type ChipColorMap,
} from "@/lib/theme/chip-colors";

describe("DEFAULT_CHIP_COLORS", () => {
  it("has the four expected categories", () => {
    expect(Object.keys(DEFAULT_CHIP_COLORS).sort()).toEqual([
      "audioCodec",
      "audioProfile",
      "dynamicRange",
      "resolution",
    ]);
  });

  it("maps known resolution values to hex colors", () => {
    expect(DEFAULT_CHIP_COLORS.resolution["4K"]).toBe("#a855f7");
    expect(DEFAULT_CHIP_COLORS.resolution.SD).toBe("#ef4444");
    expect(DEFAULT_CHIP_COLORS.resolution.Other).toBe("#6b7280");
  });

  it("maps known dynamic range values", () => {
    expect(DEFAULT_CHIP_COLORS.dynamicRange["Dolby Vision"]).toBe("#a855f7");
    expect(DEFAULT_CHIP_COLORS.dynamicRange.SDR).toBe("#71717a");
  });

  it("maps known audio profile values", () => {
    expect(DEFAULT_CHIP_COLORS.audioProfile["Dolby Atmos"]).toBe("#a855f7");
    expect(DEFAULT_CHIP_COLORS.audioProfile["DTS:X"]).toBe("#14b8a6");
  });

  it("maps known audio codec values", () => {
    expect(DEFAULT_CHIP_COLORS.audioCodec.FLAC).toBe("#a855f7");
    expect(DEFAULT_CHIP_COLORS.audioCodec.MP3).toBe("#eab308");
  });
});

describe("FALLBACK_HEX", () => {
  it("is the neutral gray hex", () => {
    expect(FALLBACK_HEX).toBe("#6b7280");
  });
});

describe("AUDIO_CODEC_ORDER", () => {
  it("lists codecs lossless → lossy → compressed", () => {
    expect(AUDIO_CODEC_ORDER[0]).toBe("FLAC");
    expect(AUDIO_CODEC_ORDER[AUDIO_CODEC_ORDER.length - 1]).toBe("WMA");
  });

  it("contains every key present in the default audioCodec map", () => {
    const ordered = new Set<string>(AUDIO_CODEC_ORDER);
    for (const key of Object.keys(DEFAULT_CHIP_COLORS.audioCodec)) {
      expect(ordered.has(key)).toBe(true);
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(AUDIO_CODEC_ORDER).size).toBe(AUDIO_CODEC_ORDER.length);
  });
});

describe("COLOR_PALETTE", () => {
  it("is a non-empty list of {name, hex} presets", () => {
    expect(COLOR_PALETTE.length).toBeGreaterThan(0);
    for (const preset of COLOR_PALETTE) {
      expect(typeof preset.name).toBe("string");
      expect(preset.hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("has unique preset names", () => {
    const names = COLOR_PALETTE.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes the Purple preset matching the resolution 4K default", () => {
    const purple = COLOR_PALETTE.find((p) => p.name === "Purple");
    expect(purple?.hex).toBe("#a855f7");
  });
});

describe("CHIP_CATEGORY_LABELS", () => {
  it("provides a human label for each category", () => {
    expect(CHIP_CATEGORY_LABELS.resolution).toBe("Resolution");
    expect(CHIP_CATEGORY_LABELS.dynamicRange).toBe("Dynamic Range");
    expect(CHIP_CATEGORY_LABELS.audioProfile).toBe("Audio Profile");
    expect(CHIP_CATEGORY_LABELS.audioCodec).toBe("Audio Codec");
  });
});

describe("CHIP_CATEGORY_ORDER", () => {
  it("lists categories in the canonical order", () => {
    expect(CHIP_CATEGORY_ORDER).toEqual([
      "resolution",
      "dynamicRange",
      "audioProfile",
      "audioCodec",
    ]);
  });

  it("covers exactly the keys of CHIP_CATEGORY_LABELS", () => {
    expect([...CHIP_CATEGORY_ORDER].sort()).toEqual(
      Object.keys(CHIP_CATEGORY_LABELS).sort(),
    );
  });
});

describe("getChipBadgeStyle", () => {
  it("produces semi-transparent bg/border and a solid text color for a 6-digit hex", () => {
    // #a855f7 → r=168, g=85, b=247
    const style = getChipBadgeStyle("#a855f7");
    expect(style.backgroundColor).toBe("rgba(168, 85, 247, 0.2)");
    expect(style.color).toBe("#a855f7");
    expect(style.borderColor).toBe("rgba(168, 85, 247, 0.3)");
  });

  it("expands a 3-digit hex before computing rgba", () => {
    // #abc → #aabbcc → r=170, g=187, b=204
    const style = getChipBadgeStyle("#abc");
    expect(style.backgroundColor).toBe("rgba(170, 187, 204, 0.2)");
    expect(style.borderColor).toBe("rgba(170, 187, 204, 0.3)");
    // color is the raw passed value, unexpanded
    expect(style.color).toBe("#abc");
  });

  it("falls back to the neutral color for malformed hex (non-hex chars)", () => {
    // #6b7280 (FALLBACK_HEX) → r=107, g=114, b=128
    const style = getChipBadgeStyle("#zzzzzz");
    expect(style.backgroundColor).toBe("rgba(107, 114, 128, 0.2)");
    expect(style.borderColor).toBe("rgba(107, 114, 128, 0.3)");
  });

  it("falls back to the neutral color for wrong-length input", () => {
    // "#12345" is 5 hex digits → invalid length → fallback
    const style = getChipBadgeStyle("#12345");
    expect(style.backgroundColor).toBe("rgba(107, 114, 128, 0.2)");
  });

  it("falls back to the neutral color for empty string", () => {
    const style = getChipBadgeStyle("");
    expect(style.backgroundColor).toBe("rgba(107, 114, 128, 0.2)");
  });

  it("tolerates hex values without a leading '#'", () => {
    // "a855f7" with no hash → strip is a no-op, still 6 valid hex chars
    const style = getChipBadgeStyle("a855f7");
    expect(style.backgroundColor).toBe("rgba(168, 85, 247, 0.2)");
  });
});

describe("getChipSolidStyle", () => {
  it("returns the hex as background and white text", () => {
    expect(getChipSolidStyle("#3b82f6")).toEqual({
      backgroundColor: "#3b82f6",
      color: "#fff",
    });
  });

  it("does not transform the hex (uses it verbatim)", () => {
    expect(getChipSolidStyle("#abc").backgroundColor).toBe("#abc");
  });
});

describe("mergeChipColors", () => {
  it("returns a copy of defaults when given null", () => {
    const merged = mergeChipColors(null);
    expect(merged).toEqual(DEFAULT_CHIP_COLORS);
    // Should be a distinct object (shallow copy), not the same reference
    expect(merged).not.toBe(DEFAULT_CHIP_COLORS);
  });

  it("returns a copy of defaults when given undefined", () => {
    const merged = mergeChipColors(undefined);
    expect(merged).toEqual(DEFAULT_CHIP_COLORS);
  });

  it("returns a copy of defaults when called with no argument", () => {
    expect(mergeChipColors()).toEqual(DEFAULT_CHIP_COLORS);
  });

  it("overrides only the provided keys within a category", () => {
    const merged = mergeChipColors({ resolution: { "4K": "#000000" } });
    // overridden key
    expect(merged.resolution["4K"]).toBe("#000000");
    // untouched key in same category retains default
    expect(merged.resolution["1080P"]).toBe(DEFAULT_CHIP_COLORS.resolution["1080P"]);
    // untouched categories retain defaults
    expect(merged.dynamicRange).toEqual(DEFAULT_CHIP_COLORS.dynamicRange);
  });

  it("supports overriding across multiple categories at once", () => {
    const overrides: Partial<ChipColorMap> = {
      dynamicRange: { SDR: "#111111" },
      audioCodec: { MP3: "#222222" },
    };
    const merged = mergeChipColors(overrides);
    expect(merged.dynamicRange.SDR).toBe("#111111");
    expect(merged.dynamicRange.HDR10).toBe(DEFAULT_CHIP_COLORS.dynamicRange.HDR10);
    expect(merged.audioCodec.MP3).toBe("#222222");
    expect(merged.audioCodec.FLAC).toBe(DEFAULT_CHIP_COLORS.audioCodec.FLAC);
    expect(merged.resolution).toEqual(DEFAULT_CHIP_COLORS.resolution);
  });

  it("can add brand-new keys not present in defaults", () => {
    const merged = mergeChipColors({ resolution: { "8K": "#abcdef" } });
    expect(merged.resolution["8K"]).toBe("#abcdef");
    expect(merged.resolution["4K"]).toBe(DEFAULT_CHIP_COLORS.resolution["4K"]);
  });

  it("does not mutate DEFAULT_CHIP_COLORS", () => {
    mergeChipColors({ resolution: { "4K": "#mutated" } });
    expect(DEFAULT_CHIP_COLORS.resolution["4K"]).toBe("#a855f7");
  });
});
