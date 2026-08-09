import type { MediaSession } from "@/lib/media-server/types";

/**
 * Hardware-transcode detection, shared by the transcode manager's exemption
 * and the Stream Manager UI so the two can't disagree about whether a stream
 * is accelerated.
 *
 * Neither Plex nor Jellyfin/Emby names a *device*: they report the
 * acceleration API in use (vaapi, nvenc, qsv, …) and express "CPU" as the
 * absence of one. So "hardware" here means "some non-CPU encoder is doing the
 * work", never a specific GPU.
 *
 * Plex's `transcodeHwRequested` is deliberately NOT used: it records that
 * hardware was *asked for*, not that it was obtained — Plex falls back to
 * software silently. The decode/encode API names are the reliable signal,
 * which is why Tautulli validates those against a known list rather than
 * trusting the request flag.
 */

/** Acceleration APIs that can perform the encode half of a transcode. */
const HW_ENCODERS = new Set([
  "amf",
  "mediacodecndk",
  "mf",
  "nvenc",
  "qsv",
  "rkmpp",
  "v4l2m2m",
  "vaapi",
  "videotoolbox",
]);

/** Acceleration APIs that can perform the decode half of a transcode. */
const HW_DECODERS = new Set([
  "amf",
  "d3d11va",
  "dxva2",
  "mediacodecndk",
  "nvdec",
  "qsv",
  "rkmpp",
  "v4l2m2m",
  "vaapi",
  "videotoolbox",
]);

/**
 * Reduces a reported codec/API string to its acceleration API. Servers report
 * either the bare API ("vaapi") or an ffmpeg-style codec name ("hevc_qsv"),
 * so fall back to the segment after the last underscore.
 */
function accelApi(raw: string | undefined, known: Set<string>): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value || value === "none") return undefined;
  if (known.has(value)) return value;

  const suffix = value.slice(value.lastIndexOf("_") + 1);
  return known.has(suffix) ? suffix : undefined;
}

type Transcoding = NonNullable<MediaSession["transcoding"]>;

/** The acceleration API doing the encode, or undefined when it's on the CPU. */
export function hardwareEncoder(t: Transcoding | undefined): string | undefined {
  if (!t) return undefined;
  // Jellyfin/Emby report one pipeline-level value with no decode/encode split.
  return accelApi(t.hwEncode, HW_ENCODERS) ?? accelApi(t.hwAccel, HW_ENCODERS);
}

/** The acceleration API doing the decode, or undefined when it's on the CPU. */
export function hardwareDecoder(t: Transcoding | undefined): string | undefined {
  if (!t) return undefined;
  return accelApi(t.hwDecode, HW_DECODERS) ?? accelApi(t.hwAccel, HW_DECODERS);
}

/**
 * Whether the expensive half — the video encode — is running on hardware.
 *
 * Decode alone doesn't count: software-encoding 4K is the costly part, and
 * exempting a stream for a hardware *decode* would miss that entirely.
 */
export function isHardwareTranscode(session: MediaSession): boolean {
  return hardwareEncoder(session.transcoding) !== undefined;
}
