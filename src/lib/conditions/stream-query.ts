import type {
  ConditionField,
  ConditionSectionDef,
  StreamQueryStreamType,
} from "./types";

/**
 * Stream query fields apply to individual MediaStream rows when a group is
 * marked `streamQuery: { streamType, quantifier }`. Shared by both builders.
 */

export type StreamQueryField =
  | "sqCodec"
  | "sqProfile"
  | "sqLanguage"
  | "sqLanguageCode"
  | "sqChannels"
  | "sqBitrate"
  | "sqBitDepth"
  | "sqIsDefault"
  | "sqDisplayTitle"
  | "sqExtDisplayTitle"
  | "sqWidth"
  | "sqHeight"
  | "sqFrameRate"
  | "sqScanType"
  | "sqVideoRangeType"
  | "sqSamplingRate"
  | "sqAudioLayout"
  | "sqForced"
  | "sqAudioProfile"
  | "sqDynamicRange"
  | "sqColorPrimaries"
  | "sqColorRange"
  | "sqChromaSubsampling";

/** Which stream types each stream query field applies to */
const SQ_STREAM_TYPE_MAP: Record<StreamQueryField, StreamQueryStreamType[]> = {
  sqCodec: ["audio", "video", "subtitle"],
  sqProfile: ["audio", "video", "subtitle"],
  sqLanguage: ["audio", "video", "subtitle"],
  sqLanguageCode: ["audio", "video", "subtitle"],
  sqBitrate: ["audio", "video"],
  sqIsDefault: ["audio", "video", "subtitle"],
  sqDisplayTitle: ["audio", "video", "subtitle"],
  sqExtDisplayTitle: ["audio", "video", "subtitle"],
  sqChannels: ["audio"],
  sqSamplingRate: ["audio"],
  sqAudioLayout: ["audio"],
  sqAudioProfile: ["audio"],
  sqBitDepth: ["video"],
  sqWidth: ["video"],
  sqHeight: ["video"],
  sqFrameRate: ["video"],
  sqScanType: ["video"],
  sqVideoRangeType: ["video"],
  sqDynamicRange: ["video"],
  sqColorPrimaries: ["video"],
  sqColorRange: ["video"],
  sqChromaSubsampling: ["video"],
  sqForced: ["subtitle"],
};

/** Maps stream query field names to MediaStream column names (null = computed) */
const SQ_COLUMN_MAP: Record<StreamQueryField, string | null> = {
  sqCodec: "codec",
  sqProfile: "profile",
  sqLanguage: "language",
  sqLanguageCode: "languageCode",
  sqChannels: "channels",
  sqBitrate: "bitrate",
  sqBitDepth: "bitDepth",
  sqIsDefault: "isDefault",
  sqDisplayTitle: "displayTitle",
  sqExtDisplayTitle: "extendedDisplayTitle",
  sqWidth: "width",
  sqHeight: "height",
  sqFrameRate: "frameRate",
  sqScanType: "scanType",
  sqVideoRangeType: "videoRangeType",
  sqSamplingRate: "samplingRate",
  sqAudioLayout: "audioChannelLayout",
  sqForced: "forced",
  sqAudioProfile: null, // computed
  sqDynamicRange: null, // computed
  sqColorPrimaries: "colorPrimaries",
  sqColorRange: "colorRange",
  sqChromaSubsampling: "chromaSubsampling",
};

export const STREAM_QUERY_COMPUTED_FIELDS: StreamQueryField[] = [
  "sqAudioProfile",
  "sqDynamicRange",
];

export function isStreamQueryComputedField(field: string): boolean {
  return STREAM_QUERY_COMPUTED_FIELDS.includes(field as StreamQueryField);
}

export const STREAM_QUERY_FIELDS: ConditionField[] = [
  { value: "sqCodec", label: "Codec", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqProfile", label: "Profile", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqLanguage", label: "Language", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqLanguageCode", label: "Language Code", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqChannels", label: "Channels", type: "number", section: "streamQuery" },
  { value: "sqBitrate", label: "Bitrate (kbps)", type: "number", section: "streamQuery" },
  { value: "sqBitDepth", label: "Bit Depth", type: "number", section: "streamQuery" },
  { value: "sqIsDefault", label: "Is Default Track", type: "boolean", section: "streamQuery", knownValues: ["true", "false"] },
  { value: "sqDisplayTitle", label: "Display Title", type: "text", section: "streamQuery" },
  { value: "sqExtDisplayTitle", label: "Extended Display Title", type: "text", section: "streamQuery" },
  { value: "sqWidth", label: "Width", type: "number", section: "streamQuery" },
  { value: "sqHeight", label: "Height", type: "number", section: "streamQuery" },
  { value: "sqFrameRate", label: "Frame Rate", type: "number", section: "streamQuery" },
  { value: "sqScanType", label: "Scan Type", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqVideoRangeType", label: "Video Range Type", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqSamplingRate", label: "Sample Rate (Hz)", type: "number", section: "streamQuery" },
  { value: "sqAudioLayout", label: "Channel Layout", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqForced", label: "Forced", type: "boolean", section: "streamQuery", knownValues: ["true", "false"] },
  { value: "sqAudioProfile", label: "Audio Profile", type: "text", section: "streamQuery", enumerable: true, knownValues: ["Dolby Atmos", "DTS:X", "DTS-HD MA", "Dolby TrueHD"] },
  { value: "sqDynamicRange", label: "Dynamic Range", type: "text", section: "streamQuery", enumerable: true, knownValues: ["Dolby Vision", "HDR10+", "HDR10", "HDR", "HLG", "SDR"] },
  { value: "sqColorPrimaries", label: "Color Primaries", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqColorRange", label: "Color Range", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqChromaSubsampling", label: "Chroma Subsampling", type: "text", section: "streamQuery", enumerable: true },
];

export const STREAM_QUERY_SECTIONS: ConditionSectionDef[] = [
  { key: "streamQuery", label: "Stream Properties" },
];

export const ALL_STREAM_QUERY_FIELD_VALUES: StreamQueryField[] =
  STREAM_QUERY_FIELDS.map((f) => f.value as StreamQueryField);

export function isStreamQueryField(field: string): boolean {
  return ALL_STREAM_QUERY_FIELD_VALUES.includes(field as StreamQueryField);
}

export function isStreamQueryGroup(group: { streamQuery?: unknown }): boolean {
  return !!group.streamQuery;
}

/** Returns stream query fields applicable to the given stream type */
export function getStreamQueryFieldsForType(
  streamType: StreamQueryStreamType,
): ConditionField[] {
  return STREAM_QUERY_FIELDS.filter((f) =>
    SQ_STREAM_TYPE_MAP[f.value as StreamQueryField]?.includes(streamType),
  );
}

/** Maps a stream query field to its MediaStream column name, or null if computed */
export function streamQueryFieldToColumn(
  field: StreamQueryField,
): string | null {
  return SQ_COLUMN_MAP[field] ?? null;
}

export const STREAM_TYPE_INT_MAP: Record<StreamQueryStreamType, number> = {
  video: 1,
  audio: 2,
  subtitle: 3,
};
