/**
 * Per-stream audio profile and dynamic range detection helpers.
 * Simplified versions of the sync-time detection functions that use only
 * stream-level fields (no part-level or filename data).
 */

interface StreamRecord {
  codec?: string | null;
  profile?: string | null;
  displayTitle?: string | null;
  extendedDisplayTitle?: string | null;
  videoRangeType?: string | null;
}

/**
 * Detect audio profile from a single stream record.
 * Returns a normalized profile name or null if not detected.
 */
export function detectStreamAudioProfile(stream: StreamRecord): string | null {
  const displayText = stream.extendedDisplayTitle ?? stream.displayTitle ?? "";
  if (displayText) {
    const upper = displayText.toUpperCase();
    if (upper.includes("ATMOS")) return "Dolby Atmos";
    if (upper.includes("DTS:X") || upper.includes("DTS-X")) return "DTS:X";
    if (upper.includes("DTS-HD MA") || upper.includes("DTS-HD MASTER")) return "DTS-HD MA";
    if (upper.includes("TRUEHD")) return "Dolby TrueHD";
  }

  if (stream.profile) {
    const profile = stream.profile.toLowerCase();
    if (profile === "truehd") return "Dolby TrueHD";
  }

  if (stream.codec) {
    const codec = stream.codec.toLowerCase();
    if (codec === "truehd") return "Dolby TrueHD";
  }

  return null;
}

/**
 * Detect dynamic range from a single video stream record.
 * Returns a normalized range name or "SDR" as fallback.
 */
export function detectStreamDynamicRange(stream: StreamRecord): string {
  const rangeType = stream.videoRangeType;
  if (rangeType) {
    const upper = rangeType.toUpperCase();
    if (upper.includes("DOVI") || upper.includes("DV")) return "Dolby Vision";
    if (upper.includes("HDR10+") || upper.includes("HDR10PLUS") || upper.includes("HDR10P")) return "HDR10+";
    if (upper === "HDR10") return "HDR10";
    if (upper === "HLG") return "HLG";
    if (upper === "PQ") return "HDR10";
    if (upper === "SDR") return "SDR";
    if (upper.includes("HDR")) return "HDR";
  }
  return "SDR";
}
