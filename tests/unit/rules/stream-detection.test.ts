import { describe, it, expect } from "vitest";
import { detectStreamAudioProfile, detectStreamDynamicRange } from "@/lib/rules/stream-detection";

describe("detectStreamAudioProfile", () => {
  it.each([
    [{ extendedDisplayTitle: "English (TrueHD 7.1 Atmos)" }, "Dolby Atmos"],
    [{ displayTitle: "eac3 atmos" }, "Dolby Atmos"],
    [{ displayTitle: "DTS:X 7.1" }, "DTS:X"],
    [{ displayTitle: "dts-x" }, "DTS:X"],
    [{ displayTitle: "DTS-HD MA 5.1" }, "DTS-HD MA"],
    [{ displayTitle: "DTS-HD Master Audio" }, "DTS-HD MA"],
    [{ displayTitle: "TrueHD 7.1" }, "Dolby TrueHD"],
    [{ profile: "TrueHD" }, "Dolby TrueHD"],
    [{ codec: "TRUEHD" }, "Dolby TrueHD"],
  ])("detects %o as %s", (stream, expected) => {
    expect(detectStreamAudioProfile(stream)).toBe(expected);
  });

  it("prefers the extended display title over the display title", () => {
    expect(
      detectStreamAudioProfile({ extendedDisplayTitle: "Atmos", displayTitle: "DTS-HD MA" }),
    ).toBe("Dolby Atmos");
  });

  it("checks Atmos before TrueHD in the same title", () => {
    expect(detectStreamAudioProfile({ displayTitle: "TrueHD Atmos" })).toBe("Dolby Atmos");
  });

  it.each([
    [{}],
    [{ codec: "aac", profile: "lc", displayTitle: "English (AAC Stereo)" }],
    [{ displayTitle: "DTS 5.1" }],
    [{ codec: null, profile: null, displayTitle: null, extendedDisplayTitle: null }],
  ])("returns null when nothing is recognised (%o)", (stream) => {
    expect(detectStreamAudioProfile(stream)).toBeNull();
  });
});

describe("detectStreamDynamicRange", () => {
  it.each([
    ["DOVI", "Dolby Vision"],
    ["DOVIWithHDR10", "Dolby Vision"],
    ["dv", "Dolby Vision"],
    ["HDR10+", "HDR10+"],
    ["hdr10plus", "HDR10+"],
    ["HDR10P", "HDR10+"],
    ["HDR10", "HDR10"],
    ["hlg", "HLG"],
    ["PQ", "HDR10"],
    ["SDR", "SDR"],
    ["HDR", "HDR"],
    ["SomethingHDR", "HDR"],
    ["Unknown", "SDR"],
  ])("maps %s to %s", (rangeType, expected) => {
    expect(detectStreamDynamicRange({ videoRangeType: rangeType })).toBe(expected);
  });

  it("falls back to SDR with no range type", () => {
    expect(detectStreamDynamicRange({})).toBe("SDR");
    expect(detectStreamDynamicRange({ videoRangeType: null })).toBe("SDR");
    expect(detectStreamDynamicRange({ videoRangeType: "" })).toBe("SDR");
  });
});
