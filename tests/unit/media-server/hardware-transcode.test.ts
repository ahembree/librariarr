import { describe, it, expect } from "vitest";
import {
  hardwareEncoder,
  hardwareDecoder,
  isHardwareTranscode,
} from "@/lib/media-server/hardware-transcode";
import type { MediaSession } from "@/lib/media-server/types";

type Transcoding = NonNullable<MediaSession["transcoding"]>;

function transcoding(overrides: Partial<Transcoding> = {}): Transcoding {
  return {
    videoDecision: "transcode",
    audioDecision: "copy",
    throttled: false,
    ...overrides,
  };
}

function session(t?: Transcoding): MediaSession {
  return {
    sessionId: "s",
    userId: "u",
    username: "user",
    userThumb: "",
    title: "Movie",
    type: "movie",
    player: { product: "Plex", platform: "web", state: "playing", address: "", local: true },
    session: { bandwidth: 0, location: "lan" },
    ...(t ? { transcoding: t } : {}),
  } as MediaSession;
}

describe("hardwareEncoder / hardwareDecoder", () => {
  it("reads Plex's per-half acceleration APIs", () => {
    const t = transcoding({ hwDecode: "vaapi", hwEncode: "vaapi" });
    expect(hardwareDecoder(t)).toBe("vaapi");
    expect(hardwareEncoder(t)).toBe("vaapi");
  });

  it("accepts ffmpeg-style codec names", () => {
    expect(hardwareEncoder(transcoding({ hwEncode: "hevc_qsv" }))).toBe("qsv");
    expect(hardwareEncoder(transcoding({ hwEncode: "h264_nvenc" }))).toBe("nvenc");
    expect(hardwareDecoder(transcoding({ hwDecode: "hevc_nvdec" }))).toBe("nvdec");
  });

  it("is case-insensitive", () => {
    expect(hardwareEncoder(transcoding({ hwEncode: "VAAPI" }))).toBe("vaapi");
  });

  it("reads Jellyfin's single pipeline-level value for both halves", () => {
    const t = transcoding({ hwAccel: "qsv" });
    expect(hardwareEncoder(t)).toBe("qsv");
    expect(hardwareDecoder(t)).toBe("qsv");
  });

  it("treats a software encoder as no acceleration", () => {
    expect(hardwareEncoder(transcoding({ hwEncode: "libx264" }))).toBeUndefined();
    expect(hardwareEncoder(transcoding({ hwEncode: "" }))).toBeUndefined();
    expect(hardwareEncoder(transcoding({ hwEncode: "none" }))).toBeUndefined();
  });

  it("is undefined when the session reports nothing", () => {
    expect(hardwareEncoder(undefined)).toBeUndefined();
    expect(hardwareDecoder(undefined)).toBeUndefined();
    expect(hardwareEncoder(transcoding())).toBeUndefined();
  });

  it("covers every acceleration API the servers can name", () => {
    for (const api of ["amf", "qsv", "nvenc", "v4l2m2m", "vaapi", "videotoolbox", "rkmpp", "mf", "mediacodecndk"]) {
      expect(hardwareEncoder(transcoding({ hwEncode: api }))).toBe(api);
    }
    for (const api of ["d3d11va", "dxva2", "nvdec", "vaapi", "qsv", "videotoolbox"]) {
      expect(hardwareDecoder(transcoding({ hwDecode: api }))).toBe(api);
    }
  });
});

describe("isHardwareTranscode", () => {
  it("is true when the encode runs on hardware", () => {
    expect(isHardwareTranscode(session(transcoding({ hwEncode: "vaapi" })))).toBe(true);
    expect(isHardwareTranscode(session(transcoding({ hwAccel: "nvenc" })))).toBe(true);
  });

  // The encode is the expensive half. A hardware decode feeding a software
  // encode still burns CPU, so it must not qualify for the exemption.
  it("is false when only the decode runs on hardware", () => {
    expect(
      isHardwareTranscode(session(transcoding({ hwDecode: "vaapi", hwEncode: "libx265" })))
    ).toBe(false);
  });

  it("is false for a fully software transcode", () => {
    expect(isHardwareTranscode(session(transcoding()))).toBe(false);
  });

  it("is false when there is no transcode at all", () => {
    expect(isHardwareTranscode(session())).toBe(false);
  });

  // Plex sets transcodeHwRequested when it *asks* for hardware, then falls
  // back to software silently — it must never stand in for real acceleration.
  it("ignores transcodeHwRequested", () => {
    expect(
      isHardwareTranscode(session(transcoding({ transcodeHwRequested: true })))
    ).toBe(false);
  });
});
