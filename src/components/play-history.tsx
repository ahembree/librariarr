"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CircleCheck,
  CircleDashed,
  History,
  Info,
  Loader2,
  Monitor,
  MonitorPlay,
  Repeat,
  User,
} from "lucide-react";
import { ColorChip } from "@/components/color-chip";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { formatDurationClock } from "@/lib/format";
import { SERVER_TYPE_STYLES, DEFAULT_SERVER_STYLE } from "@/lib/server-styles";
import { cn } from "@/lib/utils";

/** How many plays each request pulls; "Load more" appends another page. */
const PAGE_SIZE = 25;

interface WatchHistoryRow {
  id: string;
  serverUsername: string;
  watchedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  /**
   * Everything from `source` down is the Tracearr detail. `source` is
   * `"NATIVE"` (the media-server scan, which knows only who/when/what) or
   * `"TRACEARR"` (an imported play event). Every other field here is null on a
   * native row, and the row renders each only when present — so a native play
   * looks exactly as it did before Tracearr existed.
   */
  source: string;
  sourceEventId: string | null;
  referenceId: string | null;
  /** Crossed Tracearr's per-media-type completion threshold. */
  watched: boolean | null;
  percentComplete: number | null;
  state: string | null;
  progressMs: number | null;
  durationMs: number | null;
  totalDurationMs: number | null;
  segmentCount: number | null;
  stoppedAt: string | null;
  player: string | null;
  product: string | null;
  isTranscode: boolean | null;
  videoDecision: string | null;
  audioDecision: string | null;
  /** kbps. */
  bitrate: number | null;
  resolution: string | null;
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  streamVideoCodec: string | null;
  streamAudioCodec: string | null;
  /**
   * Stored JSON, written verbatim by the importer — typed `unknown` and read
   * structurally (see `asObject`), because a shape this component can't
   * guarantee must degrade to "not shown" rather than throw.
   */
  transcodeInfo: unknown;
  subtitleInfo: unknown;
  streamQuality: unknown;
  mediaItem: {
    id: string;
    title: string;
    /** Drives whether the row links out — only an episode has a page to go to. */
    type: string;
    parentTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
  };
  server: { id: string; name: string; type: string };
}

interface WatchHistoryResponse {
  items: WatchHistoryRow[];
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
}

interface PlayHistoryProps {
  /**
   * Scope to ONE media item — a movie, a track, or any single row. Takes
   * precedence over the series props below and switches the fetch to
   * `/api/media/[id]/plays`.
   *
   * Series pages scope by series identity instead, because a show's history is
   * the union of its episodes' plays across every server holding it.
   */
  mediaItemId?: string | null;
  /**
   * Series identity (see src/lib/media/series-key.ts) — the preferred way to
   * scope the history, so two same-titled shows don't blend. Falls back to
   * `parentTitle` when absent (legacy callers). At least one is required.
   */
  seriesKey?: string | null;
  /** Series name — the `parentTitle` every episode row carries. Fallback identifier. */
  parentTitle?: string | null;
  /** Restrict to one season. Omit for the whole series. */
  seasonNumber?: number | null;
  /** Restrict to one episode (with `seasonNumber`). Omit for all episodes. */
  episodeNumber?: number | null;
  /** Restrict to one server; omit to merge history across every server. */
  serverId?: string | null;
  /** Section heading. */
  heading?: string;
  /**
   * These rows are all the same episode — the one whose page this is. The
   * episode is still named on every row (so a play says exactly what was
   * watched), but as plain text rather than a link back to the page you are
   * already on.
   */
  currentEpisode?: boolean;
  /**
   * The item whose page this is, when scoping by `mediaItemId`. Every row is
   * then that same item, so naming it on each play would just repeat the page
   * heading — the row leads with the user instead.
   */
  singleItem?: boolean;
  /** Bump to refetch — e.g. on a `sync:completed` realtime event. */
  refreshKey?: number;
  /**
   * `section` (default): a full-width block under a series/season page.
   * `card`: one of the detail cards in `MediaDetailContent`'s grid — the
   * episode page passes it through `historySection` so this per-play list
   * *is* the episode's Watch History card, rather than a second section
   * beneath the per-user aggregate showing the same plays.
   */
  variant?: "section" | "card";
}

function episodeLabel(row: WatchHistoryRow): string | null {
  const { seasonNumber, episodeNumber } = row.mediaItem;
  if (seasonNumber == null || episodeNumber == null) return null;
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

/**
 * Absolute date + time for a play. Watch history is about *when* something was
 * played, so the clock time is part of the answer, not decoration — a relative
 * "2d ago" alone can't distinguish two plays on the same evening.
 */
function formatWatchedAt(dateStr: string | null): string {
  if (!dateStr) return "Unknown date";
  const date = new Date(dateStr);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const watchDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - watchDay.getTime()) / 86400000);

  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  const day = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }),
  });
  return `${day} ${time}`;
}

function formatPlayCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "play" : "plays"}`;
}

/**
 * Tracearr reports the stream bitrate in kbps. `src/lib/format.ts` has no
 * bitrate helper (it deals in bytes and durations), so this mirrors the Stream
 * Manager's own kbps→Mbps formatting — a stream should read the same in its
 * history as it did live.
 */
function formatBitrate(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

/** Tracearr's enums arrive lower-case ("playing", "stopped"). */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The three JSON columns (`transcodeInfo`, `subtitleInfo`, `streamQuality`) are
 * stored exactly as the importer assembled them, so they are read
 * *structurally* rather than cast to a compile-time shape: a row written by an
 * older build, or a field Tracearr stops sending, has to degrade to "not
 * shown" instead of throwing inside a render.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * First non-null value among `keys`. Tracearr's nested detail objects are
 * camelCase (`containerDecision`, `dynamicRange`) while its top-level history
 * fields are snake_case, and the `streamQuality` bundle is assembled from the
 * latter — so every lookup into it accepts either spelling rather than
 * silently rendering an empty popover if the two ever disagree.
 */
function pick(source: Record<string, unknown> | null, ...keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    if (source[key] != null) return source[key];
  }
  return undefined;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Tracearr's decision enum → the vocabulary the Stream Manager already uses. */
const DECISION_LABELS: Record<string, string> = {
  directplay: "Direct play",
  copy: "Copy",
  transcode: "Transcode",
};

function decisionLabel(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  return DECISION_LABELS[text] ?? titleCase(text);
}

/** Prefer Tracearr's own display string ("H.264", "TrueHD") over the raw codec id. */
function codecLabel(display: unknown, codec: string | null): string | null {
  return asText(display) ?? (codec ? codec.toUpperCase() : null);
}

/** Tracearr sends framerate as a free string ("23.976", "24p"); only label a bare number. */
function framerateLabel(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  return /^[\d.]+$/.test(text) ? `${text} fps` : text;
}

/** "5.1" when the server said so, else a raw channel count. */
function channelsLabel(display: unknown, channels: unknown): string | null {
  const text = asText(display);
  if (text) return text;
  const count = asNumber(channels);
  return count != null ? `${count} ch` : null;
}

/** " · "-joined non-empty parts, or null when nothing is known. */
function joinParts(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((part): part is string => !!part);
  return kept.length > 0 ? kept.join(" · ") : null;
}

/**
 * The transcode-vs-direct-play badge.
 *
 * Same rule as the Stream Manager's `getStreamDecision`, so a play labelled
 * "Transcode" while it was live is still labelled "Transcode" in its history:
 * ANY re-encode — video or audio — is a transcode, a `copy` decision is a
 * remux (container change, nothing re-encoded) and everything else is direct
 * play. Returns null when the row knows none of the three, which is every
 * native row.
 */
function streamDecision(row: WatchHistoryRow): { label: string; classes: string } | null {
  const { isTranscode, videoDecision, audioDecision } = row;
  if (isTranscode == null && !videoDecision && !audioDecision) return null;
  if (isTranscode || videoDecision === "transcode" || audioDecision === "transcode") {
    return { label: "Transcode", classes: "bg-amber-dim text-amber border-amber/25" };
  }
  if (videoDecision === "copy" || audioDecision === "copy") {
    return { label: "Direct Stream", classes: "bg-sky-dim text-sky border-sky/25" };
  }
  return { label: "Direct Play", classes: "bg-green-dim text-green border-green/25" };
}

interface Completion {
  /** 0-100, rounded. Null when neither the percentage nor a position/runtime pair is known. */
  percent: number | null;
  /** Did the play cross Tracearr's completion threshold — and do we even know? */
  state: "watched" | "partial" | "unknown";
}

/**
 * How far the play got.
 *
 * `percentComplete` is Tracearr's headline figure and is authoritative — it is
 * computed per media type and can be non-null when the position/runtime pair
 * is not — so the pair is only used as a fallback, and nothing is shown when
 * neither is available.
 *
 * `watched` is the separate question of whether the play crossed the
 * completion threshold. An unfinished play is labelled "Partial": it is a
 * perfectly ordinary play that stopped early, so the label must not read as an
 * error or a deletion. The watch-state reconcile — not this card — is what
 * ignores such a row.
 */
function completion(row: WatchHistoryRow): Completion | null {
  const derived =
    row.progressMs != null && row.totalDurationMs != null && row.totalDurationMs > 0
      ? (row.progressMs / row.totalDurationMs) * 100
      : null;
  const raw = row.percentComplete ?? derived;
  const state = row.watched == null ? "unknown" : row.watched ? "watched" : "partial";
  if (raw == null && state === "unknown") return null;
  return {
    percent: raw == null ? null : Math.max(0, Math.min(100, Math.round(raw))),
    state,
  };
}

/**
 * Player is the client app ("Plex for Apple TV"), product the branded product
 * name — often the same string, so the duplicate is collapsed rather than
 * printed twice.
 */
function playerLabel(row: WatchHistoryRow): string | null {
  const parts = [row.player, row.product]
    .map((part) => part?.trim() || null)
    .filter((part): part is string => !!part);
  return joinParts([...new Set(parts)]);
}

/** A `label: value` pair in the details popover. */
interface DetailRow {
  label: string;
  value: string;
}

interface DetailSection {
  title: string;
  rows: DetailRow[];
}

/** Drops the entries with no value, so a section is only as long as its data. */
function detailRows(entries: Array<[string, string | null]>): DetailRow[] {
  return entries
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([label, value]) => ({ label, value }));
}

/**
 * The deep detail behind the row's "Details" popover — everything too granular
 * for the secondary line: the full source→stream video/audio chain from
 * `streamQuality`, the transcode reasoning from `transcodeInfo`, and
 * `subtitleInfo`. Empty sections are dropped, so a row with no Tracearr detail
 * produces no popover at all.
 */
function buildDetailSections(row: WatchHistoryRow): DetailSection[] {
  const quality = asObject(row.streamQuality);
  const sourceVideo = asObject(pick(quality, "source_video_details", "sourceVideoDetails"));
  const sourceAudio = asObject(pick(quality, "source_audio_details", "sourceAudioDetails"));
  const streamVideo = asObject(pick(quality, "stream_video_details", "streamVideoDetails"));
  const streamAudio = asObject(pick(quality, "stream_audio_details", "streamAudioDetails"));
  const transcode = asObject(row.transcodeInfo);
  const subtitle = asObject(row.subtitleInfo);

  const sourceWidth = asNumber(pick(quality, "source_video_width", "sourceVideoWidth"));
  const sourceHeight = asNumber(pick(quality, "source_video_height", "sourceVideoHeight"));
  const streamWidth = asNumber(pick(streamVideo, "width"));
  const streamHeight = asNumber(pick(streamVideo, "height"));
  const sourceBitrate = asNumber(pick(sourceVideo, "bitrate"));
  const streamBitrate = asNumber(pick(streamVideo, "bitrate"));
  const sourceAudioBitrate = asNumber(pick(sourceAudio, "bitrate"));
  const streamAudioBitrate = asNumber(pick(streamAudio, "bitrate"));

  const sourceContainer = asText(pick(transcode, "sourceContainer", "source_container"));
  const streamContainer = asText(pick(transcode, "streamContainer", "stream_container"));
  const hwDecode = asText(pick(transcode, "hwDecoding", "hw_decoding"));
  const hwEncode = asText(pick(transcode, "hwEncoding", "hw_encoding"));
  const hwRequested = asBool(pick(transcode, "hwRequested", "hw_requested"));
  const speed = asNumber(pick(transcode, "speed"));
  const throttled = asBool(pick(transcode, "throttled"));
  const reasons = pick(transcode, "reasons");
  const forced = asBool(pick(subtitle, "forced"));

  const sections: DetailSection[] = [
    {
      title: "Playback",
      rows: detailRows([
        ["State", row.state ? titleCase(row.state) : null],
        // Watch time is time actually spent playing, summed over the resume
        // chain; position/runtime is where in the item the play stopped.
        ["Watch time", row.durationMs != null ? formatDurationClock(row.durationMs) : null],
        [
          "Position",
          row.progressMs != null
            ? [
                formatDurationClock(row.progressMs),
                row.totalDurationMs != null ? formatDurationClock(row.totalDurationMs) : null,
              ]
                .filter(Boolean)
                .join(" / ")
            : null,
        ],
        ["Sessions", row.segmentCount != null ? String(row.segmentCount) : null],
        ["Ended", row.stoppedAt ? formatWatchedAt(row.stoppedAt) : null],
        ["Player", playerLabel(row)],
        // Provenance, deliberately suppressed for NATIVE: a native row must
        // produce NO section at all, or every one of them would grow a
        // "Details" popover holding a single uninformative line.
        ["Recorded by", row.source === "NATIVE" ? null : titleCase(row.source.toLowerCase())],
      ]),
    },
    {
      title: "Video",
      rows: detailRows([
        ["Decision", decisionLabel(row.videoDecision)],
        [
          "Source",
          joinParts([
            codecLabel(
              pick(quality, "source_video_codec_display", "sourceVideoCodecDisplay"),
              row.sourceVideoCodec,
            ),
            sourceWidth != null && sourceHeight != null ? `${sourceWidth}×${sourceHeight}` : null,
            asText(pick(sourceVideo, "dynamicRange", "dynamic_range")),
            framerateLabel(pick(sourceVideo, "framerate")),
            sourceBitrate != null ? formatBitrate(sourceBitrate) : null,
          ]),
        ],
        [
          "Stream",
          joinParts([
            codecLabel(
              pick(quality, "stream_video_codec_display", "streamVideoCodecDisplay"),
              row.streamVideoCodec,
            ),
            streamWidth != null && streamHeight != null ? `${streamWidth}×${streamHeight}` : null,
            asText(pick(streamVideo, "dynamicRange", "dynamic_range")),
            framerateLabel(pick(streamVideo, "framerate")),
            streamBitrate != null ? formatBitrate(streamBitrate) : null,
          ]),
        ],
      ]),
    },
    {
      title: "Audio",
      rows: detailRows([
        ["Decision", decisionLabel(row.audioDecision)],
        [
          "Source",
          joinParts([
            codecLabel(
              pick(quality, "source_audio_codec_display", "sourceAudioCodecDisplay"),
              row.sourceAudioCodec,
            ),
            channelsLabel(
              pick(quality, "audio_channels_display", "audioChannelsDisplay"),
              pick(quality, "source_audio_channels", "sourceAudioChannels"),
            ),
            asText(pick(sourceAudio, "channelLayout", "channel_layout")),
            asText(pick(sourceAudio, "language")),
            sourceAudioBitrate != null ? formatBitrate(sourceAudioBitrate) : null,
          ]),
        ],
        [
          "Stream",
          joinParts([
            codecLabel(
              pick(quality, "stream_audio_codec_display", "streamAudioCodecDisplay"),
              row.streamAudioCodec,
            ),
            channelsLabel(null, pick(streamAudio, "channels")),
            asText(pick(streamAudio, "language")),
            streamAudioBitrate != null ? formatBitrate(streamAudioBitrate) : null,
          ]),
        ],
      ]),
    },
    {
      title: "Transcode",
      rows: detailRows([
        [
          "Container",
          joinParts([
            decisionLabel(pick(transcode, "containerDecision", "container_decision")),
            sourceContainer && streamContainer
              ? `${sourceContainer} → ${streamContainer}`
              : (sourceContainer ?? streamContainer),
          ]),
        ],
        [
          "Hardware",
          // Only report what the server actually said. The Stream Manager makes
          // the same distinction: "no hardware encoder named" is not proof of a
          // software encode, so an absent name says "not requested" at most.
          joinParts([
            hwDecode ? `decode ${hwDecode}` : null,
            hwEncode ? `encode ${hwEncode}` : null,
          ]) ?? (hwRequested == null ? null : hwRequested ? "Requested" : "Not requested"),
        ],
        ["Speed", speed != null ? `${speed.toFixed(1)}×` : null],
        ["Throttled", throttled == null ? null : throttled ? "Yes" : "No"],
        [
          "Reasons",
          Array.isArray(reasons)
            ? (reasons
                .map(asText)
                .filter((reason): reason is string => !!reason)
                .join(", ") || null)
            : null,
        ],
      ]),
    },
    {
      title: "Subtitles",
      rows: detailRows([
        ["Decision", decisionLabel(pick(subtitle, "decision"))],
        ["Codec", asText(pick(subtitle, "codec"))?.toUpperCase() ?? null],
        ["Language", asText(pick(subtitle, "language"))],
        ["Forced", forced == null ? null : forced ? "Yes" : "No"],
      ]),
    },
  ];

  return sections.filter((section) => section.rows.length > 0);
}

/**
 * The row's deep stream detail. Keyboard reachable on purpose: the trigger is a
 * real focusable button and Radix's HoverCard opens on focus as well as hover,
 * so Tab shows exactly what a pointer hover does (a `title` attribute or a
 * hover-only div would not).
 */
function StreamDetailPopover({ sections }: { sections: DetailSection[] }) {
  return (
    <HoverCard openDelay={150} closeDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label="Stream details"
          className="inline-flex shrink-0 items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Info className="h-3 w-3" />
          Details
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-72 max-w-[calc(100vw-2rem)] space-y-3 duration-200"
      >
        {sections.map((section) => (
          <div key={section.title} className="space-y-0.5">
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">
              {section.title}
            </p>
            {section.rows.map((detail) => (
              <div key={detail.label} className="flex items-baseline justify-between gap-3">
                <span className="shrink-0 text-[11px] text-muted-foreground">{detail.label}</span>
                <span className="min-w-0 break-words text-right font-mono text-[11px] text-foreground">
                  {detail.value}
                </span>
              </div>
            ))}
          </div>
        ))}
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The compact secondary line of Tracearr detail: completion, the stream
 * decision, the player, resolution/bitrate, a resume count, and everything
 * finer-grained behind one "Details" popover.
 *
 * Returns null when the row carries none of it — which is every NATIVE row, so
 * a native play renders exactly the markup it did before Tracearr existed.
 */
function PlaybackMeta({ row, className }: { row: WatchHistoryRow; className?: string }) {
  const decision = streamDecision(row);
  const progress = completion(row);
  const player = playerLabel(row);
  const stream = joinParts([
    row.resolution,
    row.bitrate != null ? formatBitrate(row.bitrate) : null,
  ]);
  // `segmentCount` is the ONLY signal that a play was resumed: a resume folds a
  // new segment into the same record, and `referenceId` — documented as the
  // chain key — currently just equals `sourceEventId`, so it groups nothing.
  const segments = row.segmentCount != null && row.segmentCount > 1 ? row.segmentCount : null;
  const sections = buildDetailSections(row);

  if (!decision && !progress && !player && !stream && segments == null && sections.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
    >
      {progress && (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 font-medium tabular-nums",
            progress.state === "partial" && "text-sky",
            progress.state === "watched" && "text-green",
          )}
          title={
            progress.state === "partial"
              ? "Stopped before the end — a partial play"
              : progress.state === "watched"
                ? "Played far enough to count as watched"
                : undefined
          }
        >
          {progress.state === "partial" ? (
            <CircleDashed className="h-3 w-3 shrink-0" />
          ) : progress.state === "watched" ? (
            <CircleCheck className="h-3 w-3 shrink-0" />
          ) : null}
          {[
            progress.percent != null ? `${progress.percent}%` : null,
            progress.state === "partial" ? "Partial" : progress.state === "watched" ? "Watched" : null,
          ]
            .filter(Boolean)
            .join(" ")}
        </span>
      )}
      {decision && <ColorChip className={decision.classes}>{decision.label}</ColorChip>}
      {player && (
        <span className="flex min-w-0 items-center gap-1" title={player}>
          <MonitorPlay className="h-3 w-3 shrink-0" />
          <span className="max-w-[10rem] truncate">{player}</span>
        </span>
      )}
      {stream && <span className="shrink-0 font-mono tabular-nums">{stream}</span>}
      {segments != null && (
        <span
          className="flex shrink-0 items-center gap-1"
          title={`Played across ${segments} sessions — the play was resumed`}
        >
          <Repeat className="h-3 w-3" />
          resumed &times;{segments}
        </span>
      )}
      {sections.length > 0 && <StreamDetailPopover sections={sections} />}
    </div>
  );
}

interface PlayRowProps {
  row: WatchHistoryRow;
  /** Render the episode as plain text instead of a self-link (see the prop). */
  currentEpisode: boolean;
  /** Every row is the item whose page this is — omit the title line entirely. */
  singleItem: boolean;
  /** Only worth naming the server when the plays actually span more than one. */
  multiServer: boolean;
  card: boolean;
}

function PlayRow({ row, currentEpisode, singleItem, multiServer, card }: PlayRowProps) {
  const label = episodeLabel(row);
  const device = row.deviceName || row.platform;
  // Only an episode has somewhere else to go. A movie's or track's own page is
  // where this list already lives, and `/library/series/episode/<id>` would be
  // a 404 for either — the link has to follow the row's type, not the caller's.
  const isEpisode = row.mediaItem.type === "SERIES";

  // Scoped to one item: every row names the same thing, so the title would just
  // repeat the page heading on every line. The user leads instead.
  const episode = singleItem ? null : (
    <div className={card ? "mb-1 flex min-w-0 items-center gap-2" : "flex min-w-0 items-center gap-2 sm:flex-1"}>
      {label && (
        <ColorChip className="border-border font-mono text-muted-foreground">{label}</ColorChip>
      )}
      {currentEpisode || !isEpisode ? (
        <span className="truncate font-medium" title={row.mediaItem.title}>
          {row.mediaItem.title}
        </span>
      ) : (
        <Link
          href={`/library/series/episode/${row.mediaItem.id}`}
          className="truncate font-medium hover:text-primary hover:underline"
          title={row.mediaItem.title}
        >
          {row.mediaItem.title}
        </Link>
      )}
    </div>
  );
  const serverChip = multiServer && (
    <ColorChip className={(SERVER_TYPE_STYLES[row.server.type] ?? DEFAULT_SERVER_STYLE).classes}>
      {row.server.name}
    </ColorChip>
  );
  const watchedAt = (
    <span className="font-mono tabular-nums" title={row.watchedAt ?? undefined}>
      {formatWatchedAt(row.watchedAt)}
    </span>
  );

  if (card) {
    // Card columns are narrow, so the row keeps the shape of the other detail
    // cards' rows: name on the left with a muted secondary line, one mono
    // value on the right.
    return (
      <li className="rounded-lg bg-muted/50 px-3 py-2 text-sm transition-colors hover:bg-muted/70">
        {episode}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <span className="font-medium">{row.serverUsername}</span>
            {(device || serverChip) && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {device && (
                  <span className="flex min-w-0 items-center gap-1" title={device}>
                    <Monitor className="h-3 w-3 shrink-0" />
                    <span className="truncate">{device}</span>
                  </span>
                )}
                {serverChip}
              </div>
            )}
            {/* Renders nothing at all for a native row (see PlaybackMeta). */}
            <PlaybackMeta row={row} />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{watchedAt}</span>
        </div>
      </li>
    );
  }

  return (
    <li className="rounded-lg bg-muted/50 px-3 py-2 text-sm transition-colors hover:bg-muted/70">
      {/* Stacks below `sm`: the metadata block can't shrink (chips and the
          timestamp don't wrap), so side-by-side on a phone squeezed the title
          to a single clipped character and overlapped it. */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        {episode}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:shrink-0 sm:flex-nowrap">
          <span className="flex items-center gap-1">
            <User className="h-3 w-3" />
            <span className="font-medium text-foreground/80">{row.serverUsername}</span>
          </span>
          {device && (
            <span className="flex items-center gap-1" title={device}>
              <Monitor className="h-3 w-3" />
              <span className="max-w-[10rem] truncate">{device}</span>
            </span>
          )}
          {serverChip}
          {watchedAt}
        </div>
      </div>
      {/* Second line, and only when there is something to put on it — a native
          row renders nothing here, leaving the `<li>` exactly as it was. */}
      <PlaybackMeta row={row} className="mt-1.5" />
    </li>
  );
}

/**
 * Per-play watch history for a series, a single season, or a single episode —
 * who watched, when, and which episode.
 *
 * Reads `/api/media/series/watch-history` (the stored `WatchHistory` table).
 * `MediaDetailContent`'s built-in history card answers a different question
 * (how many plays per user, fetched live from the server) and has no per-play
 * timestamps, so it can't stand in for this — which is why the episode page
 * swaps that card for this component (`variant="card"`) instead of showing
 * both.
 */
export function PlayHistory({
  mediaItemId,
  seriesKey,
  parentTitle,
  seasonNumber,
  episodeNumber,
  serverId,
  heading = "Watch History",
  currentEpisode = false,
  singleItem = false,
  refreshKey = 0,
  variant = "section",
}: PlayHistoryProps) {
  const [rows, setRows] = useState<WatchHistoryRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  // Guards against a stale slow response landing after the scope changed and
  // overwriting the current series'/season's rows.
  const reqToken = useRef(0);

  const loadPage = useCallback(
    async (page: number, token: number) => {
      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(PAGE_SIZE),
        });
        if (serverId) params.set("serverId", serverId);

        // Two scopes, two endpoints. An item id is the narrower and more
        // certain of the two, so it wins when both are somehow supplied.
        let url: string;
        if (mediaItemId) {
          url = `/api/media/${mediaItemId}/plays?${params}`;
        } else {
          if (seriesKey) params.set("seriesKey", seriesKey);
          else if (parentTitle) params.set("parentTitle", parentTitle);
          if (seasonNumber != null) params.set("seasonNumber", String(seasonNumber));
          if (episodeNumber != null) params.set("episodeNumber", String(episodeNumber));
          url = `/api/media/series/watch-history?${params}`;
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load watch history");
        const data: WatchHistoryResponse = await res.json();
        if (token !== reqToken.current) return;

        setRows((prev) => (page === 1 ? data.items : [...prev, ...data.items]));
        setTotalCount(data.pagination.totalCount);
        setHasMore(data.pagination.hasMore);
      } catch {
        if (token === reqToken.current) setError(true);
      } finally {
        if (token !== reqToken.current) return;
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [mediaItemId, seriesKey, parentTitle, seasonNumber, episodeNumber, serverId],
  );

  // Reset to the loading state when the scope changes, so a new series/season
  // never shows the previous one's plays while its own request is in flight.
  // (set-state-during-render is React 19's idiom for "reset state on prop change" —
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-state-when-a-prop-changes)
  const scopeKey = `${mediaItemId ?? ""}|${seriesKey ?? parentTitle ?? ""}|${seasonNumber ?? ""}|${episodeNumber ?? ""}|${serverId ?? ""}`;
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setRows([]);
    setTotalCount(0);
    setHasMore(false);
    setError(false);
    setLoading(true);
  }

  useEffect(() => {
    const token = ++reqToken.current;
    void (async () => {
      await loadPage(1, token);
    })();
  }, [loadPage, refreshKey]);

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    // The next page is derived from what's already rendered, so a "Load more"
    // that races a refresh can't skip a page.
    void loadPage(Math.floor(rows.length / PAGE_SIZE) + 1, reqToken.current);
  }, [loadPage, rows.length]);

  const card = variant === "card";
  // Only worth naming the server when the plays actually span more than one.
  const multiServer = new Set(rows.map((r) => r.server.id)).size > 1;

  const body = loading ? (
    <div className="space-y-2">
      {(card ? [0, 1] : [0, 1, 2]).map((i) => (
        <div
          key={i}
          className="flex animate-pulse items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5"
        >
          <div className="space-y-1.5">
            <div className={card ? "h-3 w-20 rounded bg-muted-foreground/20" : "h-3 w-40 rounded bg-muted-foreground/20"} />
            <div className={card ? "h-2 w-28 rounded bg-muted-foreground/10" : "h-2 w-24 rounded bg-muted-foreground/10"} />
          </div>
          <div className={card ? "h-2.5 w-12 rounded bg-muted-foreground/10" : "h-2.5 w-20 rounded bg-muted-foreground/10"} />
        </div>
      ))}
    </div>
  ) : error ? (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/5 bg-muted/30 px-3 py-6 text-center">
      <History className="h-5 w-5 text-muted-foreground/50" />
      <p className="text-xs text-muted-foreground">Could not load watch history</p>
    </div>
  ) : rows.length === 0 ? (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/5 bg-muted/30 px-3 py-6 text-center">
      <History className="h-5 w-5 text-muted-foreground/50" />
      <p className="text-xs text-muted-foreground">No watch history yet</p>
    </div>
  ) : (
    <>
      <ul className={card ? "space-y-2" : "space-y-1.5"}>
        {rows.map((row) => (
          <PlayRow
            key={row.id}
            row={row}
            currentEpisode={currentEpisode}
            singleItem={singleItem}
            multiServer={multiServer}
            card={card}
          />
        ))}
      </ul>

      {hasMore && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </>
  );

  if (card) {
    // Same shell and heading treatment as the other cards in the detail grid.
    return (
      <div className="rounded-xl border border-white/6 bg-card p-5 shadow-[var(--shadow-card)] space-y-3">
        <h3 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          <History className="h-3.5 w-3.5" />
          {heading}
          {!loading && totalCount > 0 && (
            <span className="text-xs font-normal normal-case">({formatPlayCount(totalCount)})</span>
          )}
        </h3>
        {body}
      </div>
    );
  }

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {heading}
        </h2>
        {!loading && totalCount > 0 && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatPlayCount(totalCount)}
          </span>
        )}
      </div>
      {body}
    </section>
  );
}
