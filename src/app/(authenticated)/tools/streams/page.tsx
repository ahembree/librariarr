"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { ColorChip } from "@/components/color-chip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Monitor,
  Play,
  Pause,
  Wifi,
  WifiOff,
  AlertTriangle,
  Radio,
  Tv,
  Film,
  Music,
  XCircle,
  Loader2,
  Shield,
  Zap,
  Server,
  SquareCheck,
  Square,
  Clock,
  Cpu,
  Globe,
  Plus,
  Pencil,
  Trash2,
  CalendarClock,
  User,
  Check,
  ChevronsUpDown,
  X,
} from "lucide-react";
import { FadeImage } from "@/components/ui/fade-image";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { formatDurationClock } from "@/lib/format";
import {
  SERVER_TYPE_STYLES,
  DEFAULT_SERVER_STYLE,
} from "@/lib/server-styles";

// --- Types ---

interface SessionPlayer {
  product: string;
  platform: string;
  state: string;
  address: string;
  local: boolean;
}

interface SessionInfo {
  bandwidth: number;
  location: string;
}

interface SessionTranscoding {
  videoDecision: string;
  audioDecision: string;
  throttled: boolean;
  sourceVideoCodec?: string;
  sourceAudioCodec?: string;
  speed?: number;
  transcodeHwRequested?: boolean;
}

interface SessionWithServer {
  serverId: string;
  serverName: string;
  serverType: string;
  sessionId: string;
  userId: string;
  username: string;
  userThumb: string;
  title: string;
  parentTitle?: string;
  grandparentTitle?: string;
  type: string;
  year?: number;
  thumb?: string;
  art?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  summary?: string;
  // Content metadata
  contentRating?: string;
  studio?: string;
  rating?: number;
  audienceRating?: number;
  tagline?: string;
  genres?: string[];
  // Media dimensions
  mediaWidth?: number;
  mediaHeight?: number;
  duration?: number;
  viewOffset?: number;
  // Media details
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
  bitrate?: number;
  aspectRatio?: string;
  audioChannels?: number;
  videoResolution?: string;
  videoProfile?: string;
  audioProfile?: string;
  optimizedForStreaming?: boolean;
  // File info
  partFile?: string;
  partSize?: number;
  startedAt: number;
  player: SessionPlayer;
  session: SessionInfo;
  transcoding?: SessionTranscoding;
}

interface TranscodeCriteria {
  anyTranscoding: boolean;
  videoTranscoding: boolean;
  audioTranscoding: boolean;
  fourKTranscoding: boolean;
  remoteTranscoding: boolean;
}

interface BlackoutSchedule {
  id: string;
  name: string;
  enabled: boolean;
  scheduleType: string; // "one_time" | "recurring"
  startDate: string | null;
  endDate: string | null;
  daysOfWeek: number[] | null; // [0,1,2,3,4,5,6] where 0=Sunday
  startTime: string | null; // "HH:mm"
  endTime: string | null; // "HH:mm"
  action: string; // "terminate_immediate" | "warn_then_terminate" | "block_new_only"
  message: string;
  delay: number; // seconds, for warn_then_terminate
  excludedUsers: string[];
}

// --- Constants ---

const PRESET_MESSAGES = [
  "Server maintenance in progress. Please try again later.",
  "This stream has been terminated by the server administrator.",
  "Server is restarting. Your stream will resume shortly.",
  "This content is temporarily unavailable.",
];

const TRANSCODE_PRESET_MESSAGES = [
  "Transcoding is not permitted on this server. Please use a direct play compatible client.",
  "This stream has been terminated due to transcoding. Please adjust your playback settings.",
  "4K content must be played in original quality. Please disable transcoding.",
  "Remote transcoding is not allowed. Please lower your remote streaming quality setting.",
  "Server resources are limited. Please use a client that supports direct play.",
];

const SSE_RECONNECT_DELAY = 3000;
const SSE_RECONNECT_MAX_DELAY = 30000;

const DEFAULT_CRITERIA: TranscodeCriteria = {
  anyTranscoding: false,
  videoTranscoding: false,
  audioTranscoding: false,
  fourKTranscoding: false,
  remoteTranscoding: false,
};

const CRITERIA_OPTIONS: { key: keyof TranscodeCriteria; label: string; desc: string }[] = [
  { key: "anyTranscoding", label: "Any Transcoding", desc: "Any stream transcoding video or audio" },
  { key: "videoTranscoding", label: "Video Transcoding", desc: "Stream has video transcoding" },
  { key: "audioTranscoding", label: "Audio Transcoding", desc: "Stream has audio transcoding" },
  { key: "fourKTranscoding", label: "4K Transcoding", desc: "Stream is transcoding 4K content" },
  { key: "remoteTranscoding", label: "Remote Transcoding", desc: "Stream is transcoding and remote (WAN)" },
];

const BLACKOUT_ACTION_LABELS: Record<string, string> = {
  terminate_immediate: "Terminate Immediately",
  warn_then_terminate: "Warn then Terminate",
  block_new_only: "Block New Only",
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DEFAULT_BLACKOUT_FORM = {
  name: "",
  scheduleType: "recurring" as string,
  startDate: "",
  endDate: "",
  daysOfWeek: [] as number[],
  startTime: "",
  endTime: "",
  action: "terminate_immediate" as string,
  message: "Stream terminated due to scheduled blackout period.",
  delay: 30,
  excludedUsers: [] as string[],
};

// --- Helpers ---

/** Format a Date as a datetime-local input value using the browser's local timezone. */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBlackoutScheduleDescription(schedule: BlackoutSchedule): string {
  if (schedule.scheduleType === "one_time") {
    const start = schedule.startDate
      ? new Date(schedule.startDate).toLocaleString([], {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "?";
    const end = schedule.endDate
      ? new Date(schedule.endDate).toLocaleString([], {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "?";
    return `${start} - ${end}`;
  }

  // Recurring
  const days =
    schedule.daysOfWeek && schedule.daysOfWeek.length > 0
      ? schedule.daysOfWeek.map((d) => DAY_LABELS[d]).join(", ")
      : "No days selected";
  const start = schedule.startTime || "?";
  const end = schedule.endTime || "?";
  return `Every ${days} ${start} - ${end}`;
}

function formatMediaTitle(s: SessionWithServer): string {
  if (s.type === "episode") {
    const show = s.grandparentTitle || s.parentTitle || "";
    return show ? `${show} \u00b7 ${s.title}` : s.title;
  }
  if (s.type === "track") {
    const parts = [s.grandparentTitle, s.parentTitle, s.title].filter(Boolean);
    return parts.join(" \u00b7 ");
  }
  return s.year ? `${s.title} (${s.year})` : s.title;
}

/** Split a session into a primary line (what to lead with) and a
 *  secondary context line, per media type. */
function sessionTitleParts(s: SessionWithServer): { primary: string; secondary: string | null } {
  if (s.type === "episode") {
    const show = s.grandparentTitle || s.parentTitle;
    if (show) {
      const secondary = [s.parentTitle !== show ? s.parentTitle : null, s.title]
        .filter(Boolean)
        .join(" \u00b7 ");
      return { primary: show, secondary: secondary || null };
    }
    return { primary: s.title, secondary: null };
  }
  if (s.type === "track") {
    const secondary = [s.grandparentTitle, s.parentTitle].filter(Boolean).join(" \u00b7 ");
    return { primary: s.title, secondary: secondary || null };
  }
  const meta = [s.year ? String(s.year) : null, s.contentRating ?? null]
    .filter(Boolean)
    .join(" \u00b7 ");
  return { primary: s.title, secondary: meta || null };
}

/** One-line summary of what is being transcoded, e.g.
 *  "video HEVC \u00b7 audio EAC3 \u00b7 1.4\u00d7 \u00b7 HW". */
function transcodeSummary(t: SessionTranscoding): string {
  const parts: string[] = [];
  if (t.videoDecision === "transcode") {
    parts.push(t.sourceVideoCodec ? `video ${t.sourceVideoCodec.toUpperCase()}` : "video");
  }
  if (t.audioDecision === "transcode") {
    parts.push(t.sourceAudioCodec ? `audio ${t.sourceAudioCodec.toUpperCase()}` : "audio");
  }
  if (t.speed !== undefined) parts.push(`${t.speed.toFixed(1)}\u00d7`);
  if (t.transcodeHwRequested !== undefined) parts.push(t.transcodeHwRequested ? "HW" : "SW");
  return parts.join(" \u00b7 ");
}



function formatBandwidth(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatEstimatedEnd(session: SessionWithServer): string | null {
  if (!session.duration || session.viewOffset == null) return null;
  const remaining = session.duration - session.viewOffset;
  if (remaining <= 0) return null;
  return formatTime(Date.now() + remaining);
}

function MediaTypeIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case "episode": return <Tv className={className} />;
    case "movie": return <Film className={className} />;
    case "track": return <Music className={className} />;
    default: return <Monitor className={className} />;
  }
}

function getStateConfig(state: string) {
  switch (state) {
    case "playing":
      return { icon: Play, label: "Playing", chip: "bg-green-dim text-green border-green/25", bar: "bg-primary" };
    case "paused":
      return { icon: Pause, label: "Paused", chip: "bg-amber-dim text-amber border-amber/25", bar: "bg-amber" };
    default:
      return { icon: Loader2, label: "Buffering", chip: "bg-sky-dim text-sky border-sky/25", bar: "bg-sky" };
  }
}

function getStreamDecision(transcoding?: SessionTranscoding): { label: string; direct: boolean } {
  if (!transcoding) return { label: "Direct Play", direct: true };
  const isDirect = transcoding.videoDecision === "directplay" && transcoding.audioDecision === "directplay";
  if (isDirect) return { label: "Direct Play", direct: true };
  if (transcoding.videoDecision === "transcode") return { label: "Transcode", direct: false };
  if (transcoding.videoDecision === "copy") return { label: "Direct Stream", direct: true };
  return { label: "Direct Play", direct: true };
}

function getSessionArtworkUrl(session: SessionWithServer): string | null {
  let thumbPath: string | undefined;
  if (session.type === "episode") {
    thumbPath = session.grandparentThumb || session.parentThumb || session.thumb;
  } else {
    thumbPath = session.thumb;
  }
  if (!thumbPath) return null;
  return `/api/tools/sessions/image?serverId=${encodeURIComponent(session.serverId)}&path=${encodeURIComponent(thumbPath)}`;
}

// --- Excluded Users Multi-Select ---

function ExcludedUsersSelect({
  selected,
  onChange,
  knownUsers,
}: {
  selected: string[];
  onChange: (users: string[]) => void;
  knownUsers: string[];
}) {
  const [open, setOpen] = useState(false);

  const toggle = (username: string) => {
    if (selected.includes(username)) {
      onChange(selected.filter((u) => u !== username));
    } else {
      onChange([...selected, username]);
    }
  };

  const remove = (username: string) => {
    onChange(selected.filter((u) => u !== username));
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Excluded Users</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          >
            <span className="truncate text-muted-foreground">
              {selected.length === 0 ? "Select users to exclude..." : `${selected.length} user${selected.length === 1 ? "" : "s"} excluded`}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search users..." />
            <CommandList>
              <CommandEmpty>No users found</CommandEmpty>
              <CommandGroup>
                {knownUsers.map((username) => (
                  <CommandItem
                    key={username}
                    value={username}
                    onSelect={() => toggle(username)}
                  >
                    <Check className={`mr-2 h-4 w-4 ${selected.includes(username) ? "opacity-100" : "opacity-0"}`} />
                    {username}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((username) => (
            <Badge key={username} variant="secondary" className="gap-1 pr-1">
              {username}
              <button
                type="button"
                onClick={() => remove(username)}
                className="rounded-sm hover:bg-muted-foreground/20"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Sessions from excluded users will not be terminated by this feature
      </p>
    </div>
  );
}

// --- Message Selector Component ---

function MessageSelector({
  selectedMessage,
  onSelect,
  customMessage,
  onCustomChange,
  messages = PRESET_MESSAGES,
}: {
  selectedMessage: string;
  onSelect: (msg: string) => void;
  customMessage: string;
  onCustomChange: (msg: string) => void;
  messages?: string[];
}) {
  const CUSTOM_VALUE = "__custom__";
  const isPreset = messages.includes(selectedMessage);
  const [customMode, setCustomMode] = useState(!isPreset);

  const selectValue = customMode ? CUSTOM_VALUE : selectedMessage;

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground uppercase tracking-wider">
        Termination Message
      </Label>
      <Select
        value={selectValue}
        onValueChange={(val) => {
          if (val === CUSTOM_VALUE) {
            setCustomMode(true);
            onSelect(customMessage || "");
          } else {
            setCustomMode(false);
            onSelect(val);
          }
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select a message..." />
        </SelectTrigger>
        <SelectContent>
          {messages.map((msg) => (
            <SelectItem key={msg} value={msg}>
              {msg}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_VALUE}>Custom message...</SelectItem>
        </SelectContent>
      </Select>
      {customMode && (
        <Input
          placeholder="Enter a custom message..."
          value={customMode ? (isPreset ? customMessage : selectedMessage) : customMessage}
          onChange={(e) => {
            onCustomChange(e.target.value);
            onSelect(e.target.value);
          }}
          autoFocus
        />
      )}
    </div>
  );
}

// --- Session Card Component ---

function sessionKey(s: SessionWithServer): string {
  return `${s.serverId}-${s.sessionId}`;
}

function SessionCard({
  session,
  selected,
  onToggleSelect,
  onTerminate,
  onOpenDetail,
}: {
  session: SessionWithServer;
  selected: boolean;
  onToggleSelect: (session: SessionWithServer) => void;
  onTerminate: (session: SessionWithServer) => void;
  onOpenDetail: (session: SessionWithServer) => void;
}) {
  const { getBadgeStyle } = useChipColors();
  const stateConfig = getStateConfig(session.player.state);
  const StateIcon = stateConfig.icon;

  const streamInfo = getStreamDecision(session.transcoding);
  const duration = session.duration ?? 0;
  const hasDuration = duration > 0;
  const progress = hasDuration
    ? Math.min(((session.viewOffset ?? 0) / duration) * 100, 100)
    : 0;
  const artUrl = getSessionArtworkUrl(session);
  const isTranscoding =
    !!session.transcoding &&
    (session.transcoding.videoDecision === "transcode" ||
      session.transcoding.audioDecision === "transcode");
  const { primary, secondary } = sessionTitleParts(session);
  const resolution = session.videoResolution
    ? normalizeResolutionLabel(session.videoResolution)
    : null;
  const eta = formatEstimatedEnd(session);
  const playerMeta = [session.player.product, session.player.platform, session.player.address]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`View details for ${primary}`}
      onClick={() => onOpenDetail(session)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail(session);
        }
      }}
      className={`group relative flex cursor-pointer overflow-hidden rounded-xl border bg-card text-left shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
        selected
          ? "border-primary/60 ring-1 ring-primary/60"
          : "border-white/6 hover:border-border-strong"
      }`}
    >
      {/* Blurred artwork wash behind the whole card */}
      {artUrl && (
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden>
          <FadeImage
            src={artUrl}
            alt=""
            loading="lazy"
            className="h-full w-full scale-110 object-cover opacity-[0.08] blur-xl"
          />
        </div>
      )}

      {/* Poster rail */}
      <div className="relative z-10 w-[96px] shrink-0 self-stretch overflow-hidden border-r border-white/5 bg-surface-2 sm:w-[104px]">
        {artUrl ? (
          <FadeImage
            src={artUrl}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <MediaTypeIcon type={session.type} className="h-6 w-6 text-faint" />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col gap-2 p-3.5 pb-4">
        {/* Who + playback state */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={selected}
            aria-label={selected ? "Deselect stream" : "Select stream"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(session);
            }}
            className="-ml-1 grid h-6 w-6 shrink-0 place-items-center"
          >
            <span
              className={`grid h-[18px] w-[18px] place-items-center rounded-[5px] border transition-colors ${
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border-strong bg-surface-0/60 text-transparent hover:border-primary/60"
              }`}
            >
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
          </button>
          {session.userThumb ? (
            <FadeImage
              src={session.userThumb}
              alt=""
              loading="lazy"
              className="h-5 w-5 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[9px] font-semibold text-primary">
              {session.username.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {session.username}
          </span>
          <ColorChip className={`gap-1 text-[11px] ${stateConfig.chip}`}>
            <StateIcon className={`h-3 w-3 ${session.player.state === "buffering" ? "animate-spin" : ""}`} />
            {stateConfig.label}
          </ColorChip>
        </div>

        {/* What's playing */}
        <div className="min-w-0">
          <p className="line-clamp-2 text-sm leading-snug font-semibold">{primary}</p>
          {secondary && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{secondary}</p>
          )}
        </div>

        {/* Stream facts */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ColorChip
            className={`gap-1 ${
              streamInfo.direct
                ? "bg-green-dim text-green border-green/25"
                : "bg-amber-dim text-amber border-amber/25"
            }`}
          >
            {streamInfo.direct ? (
              <Zap className="h-2.5 w-2.5" />
            ) : (
              <Radio className="h-2.5 w-2.5" />
            )}
            {streamInfo.label}
          </ColorChip>
          {resolution && (
            <ColorChip style={getBadgeStyle("resolution", resolution)}>{resolution}</ColorChip>
          )}
          <ColorChip className="gap-1">
            {session.player.local ? (
              <Wifi className="h-2.5 w-2.5" />
            ) : (
              <WifiOff className="h-2.5 w-2.5" />
            )}
            {session.player.local ? "LAN" : "WAN"}
          </ColorChip>
          {session.session.bandwidth > 0 && (
            <ColorChip className="font-mono tabular-nums">
              {formatBandwidth(session.session.bandwidth)}
            </ColorChip>
          )}
          <ColorChip className={`gap-1 ${(SERVER_TYPE_STYLES[session.serverType] ?? DEFAULT_SERVER_STYLE).classes}`}>
            <Server className="h-2.5 w-2.5" />
            {session.serverName}
          </ColorChip>
        </div>

        {/* Transcode summary — only when actually transcoding */}
        {isTranscoding && session.transcoding && (
          <p className="flex items-center gap-1.5 text-amber">
            <Cpu className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono text-[10.5px]">
              {transcodeSummary(session.transcoding)}
            </span>
          </p>
        )}

        {/* Player meta + times + terminate */}
        <div className="mt-auto flex items-end justify-between gap-3 pt-1.5">
          <div className="min-w-0 space-y-0.5 text-[11px] leading-tight text-faint">
            <p className="truncate">{playerMeta}</p>
            <p className="truncate font-mono text-[10.5px] tabular-nums">
              {hasDuration
                ? `${formatDurationClock(session.viewOffset ?? 0)} / ${formatDurationClock(duration)}${eta ? ` · ends ${eta}` : ""}`
                : session.startedAt > 0
                  ? `started ${formatTime(session.startedAt)}`
                  : "—"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 bg-destructive/15 text-xs text-destructive hover:bg-destructive hover:text-destructive-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onTerminate(session);
            }}
          >
            <XCircle className="h-3.5 w-3.5 mr-1" />
            Terminate
          </Button>
        </div>
      </div>

      {/* Playback progress — flush along the bottom edge */}
      {hasDuration && (
        <div
          className="absolute inset-x-0 bottom-0 z-20 h-[3px] bg-white/8"
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Playback progress"
        >
          <div
            className={`h-full ${stateConfig.bar} transition-[width] duration-500`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}

// --- Main Page ---

export default function StreamManagerPage() {
  const { getBadgeStyle } = useChipColors();
  const [sessions, setSessions] = useState<SessionWithServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [terminating, setTerminating] = useState(false);

  // Selection state
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // Terminate dialog state
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);
  const [terminateTarget, setTerminateTarget] = useState<SessionWithServer | "all" | "selected" | null>(null);
  const [selectedMessage, setSelectedMessage] = useState(PRESET_MESSAGES[0]);
  const [customMessage, setCustomMessage] = useState("");

  // Maintenance mode state
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState(PRESET_MESSAGES[0]);
  const [maintenanceCustom, setMaintenanceCustom] = useState("");
  const [maintenanceDelay, setMaintenanceDelay] = useState(30);
  const [maintenanceLoading, setMaintenanceLoading] = useState(true);
  const [maintenanceSaving, setMaintenanceSaving] = useState(false);
  const [discordNotifyMaintenance, setDiscordNotifyMaintenance] = useState(false);
  const [maintenanceExcludedUsers, setMaintenanceExcludedUsers] = useState<string[]>([]);

  // Transcode manager state
  const [transcodeEnabled, setTranscodeEnabled] = useState(false);
  const [transcodeMessage, setTranscodeMessage] = useState(TRANSCODE_PRESET_MESSAGES[0]);
  const [transcodeCustom, setTranscodeCustom] = useState("");
  const [transcodeDelay, setTranscodeDelay] = useState(30);
  const [transcodeCriteria, setTranscodeCriteria] = useState<TranscodeCriteria>(DEFAULT_CRITERIA);
  const [transcodeLoading, setTranscodeLoading] = useState(true);
  const [transcodeSaving, setTranscodeSaving] = useState(false);
  const [transcodeExcludedUsers, setTranscodeExcludedUsers] = useState<string[]>([]);

  // Known users from media servers (for exclusion dropdowns)
  const [knownUsers, setKnownUsers] = useState<string[]>([]);

  // Blackout schedules state
  const [blackoutSchedules, setBlackoutSchedules] = useState<BlackoutSchedule[]>([]);
  const [blackoutLoading, setBlackoutLoading] = useState(false);
  const [showBlackoutDialog, setShowBlackoutDialog] = useState(false);
  const [editingBlackout, setEditingBlackout] = useState<BlackoutSchedule | null>(null);
  const [blackoutForm, setBlackoutForm] = useState({ ...DEFAULT_BLACKOUT_FORM });
  const [blackoutSaving, setBlackoutSaving] = useState(false);
  const [deleteBlackoutId, setDeleteBlackoutId] = useState<string | null>(null);

  // Media detail sheet state
  const [sheetSession, setSheetSession] = useState<SessionWithServer | null>(null);

  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(SSE_RECONNECT_DELAY);

  // SSE connection for real-time session updates
  useEffect(() => {
    function connect() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const es = new EventSource("/api/tools/sessions/stream");
      eventSourceRef.current = es;

      es.onopen = () => {
        // Connection re-established — reset the backoff window.
        reconnectDelayRef.current = SSE_RECONNECT_DELAY;
      };

      es.addEventListener("sessions", (event) => {
        try {
          const data = JSON.parse(event.data);
          const incoming: SessionWithServer[] = data.sessions ?? [];
          setSessions(incoming);
          setLoading(false);
          setConnected(true);
          // Successful payload — reset the backoff window.
          reconnectDelayRef.current = SSE_RECONNECT_DELAY;

          // Prune selected keys that no longer exist
          const currentKeys = new Set(incoming.map(sessionKey));
          setSelectedKeys((prev) => {
            const next = new Set<string>();
            for (const k of prev) {
              if (currentKeys.has(k)) next.add(k);
            }
            return next.size === prev.size ? prev : next;
          });
        } catch {
          // Malformed event
        }
      });

      es.onerror = () => {
        setConnected(false);
        es.close();
        eventSourceRef.current = null;

        // Reconnect with exponential backoff (capped) to avoid hammering a
        // down endpoint; the delay is reset to the floor on a successful open.
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, SSE_RECONNECT_MAX_DELAY);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, []);

  // One-shot fetch for immediate refresh after termination
  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/tools/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions ?? []);
      }
    } catch {
      // SSE will pick up changes on next cycle
    }
  }, []);

  // Fetch maintenance mode
  const fetchMaintenance = useCallback(async () => {
    try {
      const res = await fetch("/api/tools/maintenance");
      if (res.ok) {
        const data = await res.json();
        setMaintenanceEnabled(data.enabled);
        setMaintenanceDelay(data.delay ?? 30);
        if (data.message) {
          setMaintenanceMessage(data.message);
          if (!PRESET_MESSAGES.includes(data.message)) {
            setMaintenanceCustom(data.message);
          }
        }
        setDiscordNotifyMaintenance(data.discordNotifyMaintenance ?? false);
        setMaintenanceExcludedUsers(data.excludedUsers ?? []);
      }
    } catch {
      // Silent
    } finally {
      setMaintenanceLoading(false);
    }
  }, []);

  // Fetch transcode manager settings
  const fetchTranscodeManager = useCallback(async () => {
    try {
      const res = await fetch("/api/tools/transcode-manager");
      if (res.ok) {
        const data = await res.json();
        setTranscodeEnabled(data.enabled);
        setTranscodeDelay(data.delay ?? 30);
        setTranscodeCriteria(data.criteria ?? DEFAULT_CRITERIA);
        if (data.message) {
          setTranscodeMessage(data.message);
          if (!TRANSCODE_PRESET_MESSAGES.includes(data.message)) {
            setTranscodeCustom(data.message);
          }
        }
        setTranscodeExcludedUsers(data.excludedUsers ?? []);
      }
    } catch {
      // Silent
    } finally {
      setTranscodeLoading(false);
    }
  }, []);

  // Fetch blackout schedules
  const fetchBlackoutSchedules = useCallback(async () => {
    setBlackoutLoading(true);
    try {
      const res = await fetch("/api/tools/blackout");
      if (res.ok) {
        const data = await res.json();
        setBlackoutSchedules(data.schedules ?? []);
      }
    } catch {
      // Silent
    } finally {
      setBlackoutLoading(false);
    }
  }, []);

  // Save (create or update) a blackout schedule
  const saveBlackout = async () => {
    setBlackoutSaving(true);
    try {
      const payload = {
        name: blackoutForm.name,
        scheduleType: blackoutForm.scheduleType,
        startDate:
          blackoutForm.scheduleType === "one_time" && blackoutForm.startDate
            ? new Date(blackoutForm.startDate).toISOString()
            : null,
        endDate:
          blackoutForm.scheduleType === "one_time" && blackoutForm.endDate
            ? new Date(blackoutForm.endDate).toISOString()
            : null,
        daysOfWeek: blackoutForm.scheduleType === "recurring" ? blackoutForm.daysOfWeek : null,
        startTime: blackoutForm.scheduleType === "recurring" ? blackoutForm.startTime || null : null,
        endTime: blackoutForm.scheduleType === "recurring" ? blackoutForm.endTime || null : null,
        action: blackoutForm.action,
        message: blackoutForm.message,
        delay: blackoutForm.action === "warn_then_terminate" ? blackoutForm.delay : 0,
        excludedUsers: blackoutForm.excludedUsers,
      };

      const url = editingBlackout
        ? `/api/tools/blackout/${editingBlackout.id}`
        : "/api/tools/blackout";
      const method = editingBlackout ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        await fetchBlackoutSchedules();
        setShowBlackoutDialog(false);
        setEditingBlackout(null);
      }
    } catch {
      // Silent
    } finally {
      setBlackoutSaving(false);
    }
  };

  // Delete a blackout schedule
  const deleteBlackout = async (id: string) => {
    try {
      const res = await fetch(`/api/tools/blackout/${id}`, { method: "DELETE" });
      if (res.ok) {
        await fetchBlackoutSchedules();
      }
    } catch {
      // Silent
    } finally {
      setDeleteBlackoutId(null);
    }
  };

  // Toggle a blackout schedule enabled/disabled
  const toggleBlackoutEnabled = async (id: string, currentEnabled: boolean) => {
    // Optimistic update
    setBlackoutSchedules((prev) =>
      prev.map((s) => (s.id === id ? { ...s, enabled: !currentEnabled } : s))
    );
    try {
      await fetch(`/api/tools/blackout/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
    } catch {
      // Revert on failure
      setBlackoutSchedules((prev) =>
        prev.map((s) => (s.id === id ? { ...s, enabled: currentEnabled } : s))
      );
    }
  };

  // Open dialog for new blackout schedule
  const openNewBlackout = () => {
    setEditingBlackout(null);
    setBlackoutForm({ ...DEFAULT_BLACKOUT_FORM });
    setShowBlackoutDialog(true);
  };

  // Open dialog for editing an existing blackout schedule
  const openEditBlackout = (schedule: BlackoutSchedule) => {
    setEditingBlackout(schedule);
    setBlackoutForm({
      name: schedule.name,
      scheduleType: schedule.scheduleType,
      startDate: schedule.startDate ? toDatetimeLocalValue(new Date(schedule.startDate)) : "",
      endDate: schedule.endDate ? toDatetimeLocalValue(new Date(schedule.endDate)) : "",
      daysOfWeek: schedule.daysOfWeek ?? [],
      startTime: schedule.startTime ?? "",
      endTime: schedule.endTime ?? "",
      action: schedule.action,
      message: schedule.message,
      delay: schedule.delay,
      excludedUsers: schedule.excludedUsers ?? [],
    });
    setShowBlackoutDialog(true);
  };

  // Toggle a day in/out of the daysOfWeek array
  const toggleBlackoutDay = (day: number) => {
    setBlackoutForm((prev) => {
      const days = prev.daysOfWeek.includes(day)
        ? prev.daysOfWeek.filter((d) => d !== day)
        : [...prev.daysOfWeek, day].sort();
      return { ...prev, daysOfWeek: days };
    });
  };

  // Load on mount
  useEffect(() => {
    void (async () => { await fetchMaintenance(); })();
  }, [fetchMaintenance]);

  useEffect(() => {
    void (async () => { await fetchTranscodeManager(); })();
  }, [fetchTranscodeManager]);

  useEffect(() => {
    void (async () => { await fetchBlackoutSchedules(); })();
  }, [fetchBlackoutSchedules]);

  useEffect(() => {
    fetch("/api/tools/users")
      .then((res) => (res.ok ? res.json() : { users: [] }))
      .then((data) => setKnownUsers(data.users ?? []))
      .catch(() => {});
  }, []);

  // Selection helpers
  const toggleSelect = (session: SessionWithServer) => {
    const key = sessionKey(session);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedKeys(new Set(sessions.map(sessionKey)));
  };

  const deselectAll = () => {
    setSelectedKeys(new Set());
  };

  const allSelected = sessions.length > 0 && selectedKeys.size === sessions.length;

  // Open terminate dialog
  const handleTerminateClick = (target: SessionWithServer | "all" | "selected") => {
    setTerminateTarget(target);
    setTerminateDialogOpen(true);
  };

  // Resolve which sessions the current target refers to
  const getTargetSessions = (): SessionWithServer[] => {
    if (terminateTarget === "all") return sessions;
    if (terminateTarget === "selected") return sessions.filter((s) => selectedKeys.has(sessionKey(s)));
    if (terminateTarget) return [terminateTarget];
    return [];
  };

  // Execute termination
  const executeTerminate = async () => {
    if (!terminateTarget || !selectedMessage) return;
    setTerminating(true);

    try {
      if (terminateTarget === "all") {
        await fetch("/api/tools/sessions/terminate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId: "all", message: selectedMessage }),
        });
      } else {
        // Group target sessions by serverId for efficient batch calls
        const targets = getTargetSessions();
        const byServer = new Map<string, string[]>();
        for (const s of targets) {
          const ids = byServer.get(s.serverId) ?? [];
          ids.push(s.sessionId);
          byServer.set(s.serverId, ids);
        }

        await Promise.all(
          Array.from(byServer.entries()).map(([serverId, sessionIds]) =>
            fetch("/api/tools/sessions/terminate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ serverId, sessionIds, message: selectedMessage }),
            })
          )
        );
      }

      setSelectedKeys(new Set());
      await refreshSessions();
    } catch {
      // SSE stream will pick up changes on next cycle
    } finally {
      setTerminating(false);
      setTerminateDialogOpen(false);
      setTerminateTarget(null);
    }
  };

  // --- Maintenance mode handlers ---

  const saveMaintenance = async (overrides: { enabled?: boolean; message?: string; delay?: number; discordNotifyMaintenance?: boolean; excludedUsers?: string[] }) => {
    const payload = {
      enabled: overrides.enabled ?? maintenanceEnabled,
      message: overrides.message ?? maintenanceMessage,
      delay: overrides.delay ?? maintenanceDelay,
      ...(overrides.discordNotifyMaintenance !== undefined && { discordNotifyMaintenance: overrides.discordNotifyMaintenance }),
      ...(overrides.excludedUsers !== undefined && { excludedUsers: overrides.excludedUsers }),
    };
    try {
      await fetch("/api/tools/maintenance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Silent
    }
  };

  const toggleMaintenance = async (enabled: boolean) => {
    setMaintenanceSaving(true);
    setMaintenanceEnabled(enabled);
    try {
      await saveMaintenance({ enabled });
      window.dispatchEvent(new CustomEvent("maintenance-changed", { detail: { enabled } }));
    } catch {
      setMaintenanceEnabled(!enabled);
    } finally {
      setMaintenanceSaving(false);
    }
  };

  const updateMaintenanceMessage = (message: string) => {
    setMaintenanceMessage(message);
    if (maintenanceEnabled) saveMaintenance({ message });
  };

  const updateMaintenanceDelay = (delay: number) => {
    setMaintenanceDelay(delay);
    if (maintenanceEnabled) saveMaintenance({ delay });
  };

  // --- Transcode manager handlers ---

  const saveTranscodeManager = async (overrides: {
    enabled?: boolean;
    message?: string;
    delay?: number;
    criteria?: TranscodeCriteria;
    excludedUsers?: string[];
  }) => {
    const payload = {
      enabled: overrides.enabled ?? transcodeEnabled,
      message: overrides.message ?? transcodeMessage,
      delay: overrides.delay ?? transcodeDelay,
      criteria: overrides.criteria ?? transcodeCriteria,
      ...(overrides.excludedUsers !== undefined && { excludedUsers: overrides.excludedUsers }),
    };
    try {
      await fetch("/api/tools/transcode-manager", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Silent
    }
  };

  const toggleTranscodeManager = async (enabled: boolean) => {
    setTranscodeSaving(true);
    setTranscodeEnabled(enabled);
    try {
      await saveTranscodeManager({ enabled });
    } catch {
      setTranscodeEnabled(!enabled);
    } finally {
      setTranscodeSaving(false);
    }
  };

  const updateTranscodeMessage = (message: string) => {
    setTranscodeMessage(message);
    if (transcodeEnabled) saveTranscodeManager({ message });
  };

  const updateTranscodeDelay = (delay: number) => {
    setTranscodeDelay(delay);
    if (transcodeEnabled) saveTranscodeManager({ delay });
  };

  const updateTranscodeCriteria = (key: keyof TranscodeCriteria, checked: boolean) => {
    const updated = { ...transcodeCriteria, [key]: checked };
    setTranscodeCriteria(updated);
    if (transcodeEnabled) saveTranscodeManager({ criteria: updated });
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 min-w-0">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Stream Manager</h1>
        <p className="text-muted-foreground mt-1">
          Monitor and manage active streams across your media servers
        </p>
      </div>

      {/* Active Sessions */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Monitor className="h-5 w-5" />
              Active Sessions
            </h2>
            {!loading && (
              <Badge variant="secondary" className="text-xs">
                {sessions.length}
              </Badge>
            )}
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <span
              className={`h-2 w-2 rounded-full ${connected ? "bg-green animate-pulse shadow-[0_0_8px_var(--green)]" : "bg-muted-foreground"}`}
              title={connected ? "Live — connected to server" : "Connecting..."}
              role="status"
              aria-label={connected ? "Live — connected to server" : "Connecting to server"}
            />
            {connected && <span className="text-xs text-green hidden sm:inline">Live</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sessions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={allSelected ? deselectAll : selectAll}
              >
                {allSelected ? (
                  <SquareCheck className="h-4 w-4 mr-1.5" />
                ) : (
                  <Square className="h-4 w-4 mr-1.5" />
                )}
                {allSelected ? "Deselect All" : "Select All"}
              </Button>
            )}
            {selectedKeys.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                disabled={terminating}
                onClick={() => handleTerminateClick("selected")}
              >
                <XCircle className="h-4 w-4 mr-1.5" />
                Terminate Selected ({selectedKeys.size})
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              disabled={sessions.length === 0 || terminating}
              onClick={() => handleTerminateClick("all")}
            >
              {terminating ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <XCircle className="h-4 w-4 mr-1.5" />
              )}
              Terminate All
            </Button>
          </div>
        </div>

        {/* Session list */}
        {!loading && sessions.length === 0 ? (
          <EmptyState
            icon={Monitor}
            title="No active streams"
            description="Streams will appear here when users start playing media."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 stagger-children">
            {sessions.map((s) => (
              <SessionCard
                key={sessionKey(s)}
                session={s}
                selected={selectedKeys.has(sessionKey(s))}
                onToggleSelect={toggleSelect}
                onTerminate={handleTerminateClick}
                onOpenDetail={setSheetSession}
              />
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* Maintenance Mode + Transcode Manager grid */}
      <div className="grid gap-6 lg:grid-cols-2 min-w-0 animate-fade-in-up">
        {/* Maintenance Mode */}
        <div className="space-y-4 min-w-0">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Maintenance Mode
          </h2>

          <Card className={`overflow-hidden transition-colors ${maintenanceEnabled ? "border-amber/40 bg-amber/5" : ""}`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <CardTitle className="text-base flex items-center gap-2">
                    {maintenanceEnabled && (
                      <AlertTriangle className="h-4 w-4 text-amber shrink-0" />
                    )}
                    {maintenanceEnabled ? "Maintenance Mode Active" : "Maintenance Mode"}
                  </CardTitle>
                  <CardDescription>
                    {maintenanceEnabled
                      ? `New streams will be automatically terminated after ${maintenanceDelay} seconds`
                      : "When enabled, all new streams will be automatically terminated with your chosen message"}
                  </CardDescription>
                </div>
                <Switch
                  checked={maintenanceEnabled}
                  onCheckedChange={toggleMaintenance}
                  disabled={maintenanceLoading || maintenanceSaving}
                  className="shrink-0"
                />
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Delay input */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                  Termination Delay (seconds)
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={maintenanceDelay}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 0) updateMaintenanceDelay(val);
                  }}
                  className="w-full sm:w-24"
                />
                <p className="text-[11px] text-muted-foreground">
                  Time before a new stream is terminated (0 for immediate)
                </p>
              </div>

              {/* Message selector */}
              <MessageSelector
                selectedMessage={maintenanceMessage}
                onSelect={updateMaintenanceMessage}
                customMessage={maintenanceCustom}
                onCustomChange={(msg) => {
                  setMaintenanceCustom(msg);
                  if (msg) updateMaintenanceMessage(msg);
                }}
              />

              {/* Discord notification toggle */}
              <div className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Notify Discord</p>
                  <p className="text-[11px] text-muted-foreground">
                    Send a Discord notification when maintenance mode is toggled
                  </p>
                </div>
                <Switch
                  checked={discordNotifyMaintenance}
                  onCheckedChange={(checked) => {
                    setDiscordNotifyMaintenance(checked);
                    saveMaintenance({ discordNotifyMaintenance: checked });
                  }}
                  disabled={maintenanceLoading}
                  className="shrink-0"
                />
              </div>

              {/* Excluded users */}
              <ExcludedUsersSelect
                selected={maintenanceExcludedUsers}
                onChange={(users) => {
                  setMaintenanceExcludedUsers(users);
                  saveMaintenance({ excludedUsers: users });
                }}
                knownUsers={knownUsers}
              />
            </CardContent>
          </Card>
        </div>

        {/* Transcode Manager */}
        <div className="space-y-4 min-w-0">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Radio className="h-5 w-5" />
            Transcode Manager
          </h2>

          <Card className={`overflow-hidden transition-colors ${transcodeEnabled ? "border-amber/40 bg-amber/5" : ""}`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <CardTitle className="text-base flex items-center gap-2">
                    {transcodeEnabled && (
                      <AlertTriangle className="h-4 w-4 text-amber shrink-0" />
                    )}
                    {transcodeEnabled ? "Transcode Manager Active" : "Transcode Manager"}
                  </CardTitle>
                  <CardDescription>
                    {transcodeEnabled
                      ? `Matching transcoding streams will be terminated after ${transcodeDelay} seconds`
                      : "When enabled, streams matching selected criteria will be automatically terminated"}
                  </CardDescription>
                </div>
                <Switch
                  checked={transcodeEnabled}
                  onCheckedChange={toggleTranscodeManager}
                  disabled={transcodeLoading || transcodeSaving}
                  className="shrink-0"
                />
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Delay input */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                  Termination Delay (seconds)
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={transcodeDelay}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 0) updateTranscodeDelay(val);
                  }}
                  className="w-full sm:w-24"
                />
                <p className="text-[11px] text-muted-foreground">
                  Time before a matching stream is terminated (0 for immediate)
                </p>
              </div>

              {/* Criteria toggles */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                  Termination Criteria
                </Label>
                <p className="text-[11px] text-muted-foreground pb-1">
                  If any enabled criterion matches a stream, it will be terminated after the delay
                </p>
                {CRITERIA_OPTIONS.map(({ key, label, desc }) => (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-[11px] text-muted-foreground">{desc}</p>
                    </div>
                    <Switch
                      checked={transcodeCriteria[key]}
                      onCheckedChange={(checked) => updateTranscodeCriteria(key, checked)}
                      className="shrink-0"
                    />
                  </div>
                ))}
              </div>

              {/* Termination message */}
              <MessageSelector
                selectedMessage={transcodeMessage}
                onSelect={updateTranscodeMessage}
                customMessage={transcodeCustom}
                messages={TRANSCODE_PRESET_MESSAGES}
                onCustomChange={(msg) => {
                  setTranscodeCustom(msg);
                  if (msg) updateTranscodeMessage(msg);
                }}
              />

              {/* Excluded users */}
              <ExcludedUsersSelect
                selected={transcodeExcludedUsers}
                onChange={(users) => {
                  setTranscodeExcludedUsers(users);
                  saveTranscodeManager({ excludedUsers: users });
                }}
                knownUsers={knownUsers}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <Separator />

      {/* Blackout Schedules */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Blackout Schedules
          </h2>
          <Button size="sm" onClick={openNewBlackout}>
            <Plus className="h-4 w-4 mr-1.5" />
            New Schedule
          </Button>
        </div>

        {blackoutLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : blackoutSchedules.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No blackout schedules"
            description="Create schedules to automatically terminate streams during specific time periods."
          />
        ) : (
          <div className="space-y-3">
            {blackoutSchedules.map((schedule) => (
              <Card key={schedule.id} className={schedule.enabled ? "border-amber/30 bg-amber/5" : ""}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{schedule.name}</span>
                        <ColorChip className="text-slate-300 bg-slate-500/15 border-slate-500/30">
                          {schedule.scheduleType === "one_time" ? "One-Time" : "Recurring"}
                        </ColorChip>
                        <ColorChip
                          className={
                            schedule.action === "terminate_immediate"
                              ? "text-red-400 bg-red-500/15 border-red-500/30"
                              : schedule.action === "warn_then_terminate"
                                ? "text-amber bg-amber/15 border-amber/30"
                                : "text-blue-400 bg-blue-500/15 border-blue-500/30"
                          }
                        >
                          {BLACKOUT_ACTION_LABELS[schedule.action] ?? schedule.action}
                        </ColorChip>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatBlackoutScheduleDescription(schedule)}
                      </p>
                      {schedule.action === "warn_then_terminate" && (
                        <p className="text-[10px] text-muted-foreground">
                          Delay: {schedule.delay}s
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Switch
                        checked={schedule.enabled}
                        onCheckedChange={() => toggleBlackoutEnabled(schedule.id, schedule.enabled)}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => openEditBlackout(schedule)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setDeleteBlackoutId(schedule.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Blackout Create/Edit Dialog */}
      <Dialog open={showBlackoutDialog} onOpenChange={setShowBlackoutDialog}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingBlackout ? "Edit Blackout Schedule" : "New Blackout Schedule"}
            </DialogTitle>
            <DialogDescription>
              {editingBlackout
                ? "Update the schedule settings below"
                : "Configure when streams should be automatically terminated"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Name */}
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                placeholder="e.g., Weekend Maintenance"
                value={blackoutForm.name}
                onChange={(e) => setBlackoutForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            {/* Schedule Type */}
            <div className="space-y-1.5">
              <Label>Schedule Type</Label>
              <Select
                value={blackoutForm.scheduleType}
                onValueChange={(v) => setBlackoutForm((f) => ({ ...f, scheduleType: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="one_time">One-Time</SelectItem>
                  <SelectItem value="recurring">Recurring</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* One-time: date range */}
            {blackoutForm.scheduleType === "one_time" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Start Date/Time</Label>
                  <Input
                    type="datetime-local"
                    value={blackoutForm.startDate}
                    onChange={(e) => setBlackoutForm((f) => ({ ...f, startDate: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>End Date/Time</Label>
                  <Input
                    type="datetime-local"
                    value={blackoutForm.endDate}
                    onChange={(e) => setBlackoutForm((f) => ({ ...f, endDate: e.target.value }))}
                  />
                </div>
              </div>
            )}

            {/* Recurring: days of week + time range */}
            {blackoutForm.scheduleType === "recurring" && (
              <>
                <div className="space-y-1.5">
                  <Label>Days of Week</Label>
                  <div className="flex flex-wrap gap-2">
                    {DAY_LABELS.map((label, idx) => (
                      <button
                        key={idx}
                        onClick={() => toggleBlackoutDay(idx)}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors border ${
                          blackoutForm.daysOfWeek.includes(idx)
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-muted bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Start Time</Label>
                    <Input
                      type="time"
                      value={blackoutForm.startTime}
                      onChange={(e) => setBlackoutForm((f) => ({ ...f, startTime: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>End Time</Label>
                    <Input
                      type="time"
                      value={blackoutForm.endTime}
                      onChange={(e) => setBlackoutForm((f) => ({ ...f, endTime: e.target.value }))}
                    />
                  </div>
                </div>
              </>
            )}

            {/* Action */}
            <div className="space-y-1.5">
              <Label>Action</Label>
              <Select
                value={blackoutForm.action}
                onValueChange={(v) => setBlackoutForm((f) => ({ ...f, action: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="terminate_immediate">Terminate Immediately</SelectItem>
                  <SelectItem value="warn_then_terminate">Warn then Terminate</SelectItem>
                  <SelectItem value="block_new_only">Block New Only</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {blackoutForm.action === "terminate_immediate" && "All active streams will be immediately terminated"}
                {blackoutForm.action === "warn_then_terminate" && "Streams will be terminated after the delay period"}
                {blackoutForm.action === "block_new_only" && "Existing streams continue, but new streams are terminated"}
              </p>
            </div>

            {/* Delay (only for warn_then_terminate) */}
            {blackoutForm.action === "warn_then_terminate" && (
              <div className="space-y-1.5">
                <Label>Delay (seconds)</Label>
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={blackoutForm.delay}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 0)
                      setBlackoutForm((f) => ({ ...f, delay: val }));
                  }}
                  className="w-full sm:w-24"
                />
              </div>
            )}

            {/* Message */}
            <div className="space-y-1.5">
              <Label>Termination Message</Label>
              <Input
                placeholder="Message shown to users..."
                value={blackoutForm.message}
                onChange={(e) => setBlackoutForm((f) => ({ ...f, message: e.target.value }))}
              />
            </div>

            {/* Excluded users */}
            <ExcludedUsersSelect
              selected={blackoutForm.excludedUsers}
              onChange={(users) => setBlackoutForm((f) => ({ ...f, excludedUsers: users }))}
              knownUsers={knownUsers}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBlackoutDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={saveBlackout}
              disabled={blackoutSaving || !blackoutForm.name.trim()}
            >
              {blackoutSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {editingBlackout ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Blackout Delete Confirmation */}
      <AlertDialog open={!!deleteBlackoutId} onOpenChange={(open) => { if (!open) setDeleteBlackoutId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Blackout Schedule</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this blackout schedule. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteBlackoutId) deleteBlackout(deleteBlackoutId);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Terminate Dialog */}
      <AlertDialog open={terminateDialogOpen} onOpenChange={setTerminateDialogOpen}>
        <AlertDialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {terminateTarget === "all"
                ? `Terminate All Streams (${sessions.length})`
                : terminateTarget === "selected"
                  ? `Terminate Selected Streams (${selectedKeys.size})`
                  : terminateTarget
                    ? `Terminate Stream \u2014 ${terminateTarget.username}`
                    : "Terminate Stream"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Select a message to display on the client when the stream is terminated.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <MessageSelector
            selectedMessage={selectedMessage}
            onSelect={setSelectedMessage}
            customMessage={customMessage}
            onCustomChange={setCustomMessage}
          />

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={executeTerminate}
              disabled={!selectedMessage || terminating}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {terminating ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <XCircle className="h-4 w-4 mr-1.5" />
              )}
              Terminate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Media Detail Sheet */}
      <Sheet open={!!sheetSession} onOpenChange={(open) => { if (!open) setSheetSession(null); }}>
        <SheetContent side="right" className="overflow-y-auto">
          {sheetSession && (
            <>
              <SheetHeader>
                <SheetTitle className="wrap-break-word">{formatMediaTitle(sheetSession)}</SheetTitle>
                <SheetDescription>
                  {sheetSession.type === "episode" ? "TV Episode" : sheetSession.type === "movie" ? "Movie" : sheetSession.type === "track" ? "Track" : sheetSession.type}
                  {sheetSession.year ? ` (${sheetSession.year})` : ""}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-5 px-4 pb-4">
                {/* Large artwork */}
                {(() => {
                  const artUrl = getSessionArtworkUrl(sheetSession);
                  return artUrl ? (
                    <div className="flex justify-center px-4">
                      <div className="overflow-hidden rounded-xl">
                        <FadeImage
                          src={artUrl}
                          alt={sheetSession.title}
                          loading="lazy"
                          className="block max-w-full"
                          style={{ maxHeight: "400px" }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                    </div>
                  ) : null;
                })()}

                {/* Overview */}
                {(sheetSession.tagline || sheetSession.summary || sheetSession.contentRating || sheetSession.studio || sheetSession.genres) && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Overview</h4>
                    {sheetSession.tagline && (
                      <p className="text-xs italic text-muted-foreground">{sheetSession.tagline}</p>
                    )}
                    {sheetSession.summary && (
                      <p className="text-sm text-muted-foreground leading-relaxed">{sheetSession.summary}</p>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {sheetSession.contentRating && (
                        <Badge variant="outline" className="text-[10px]">{sheetSession.contentRating}</Badge>
                      )}
                      {sheetSession.studio && (
                        <Badge variant="secondary" className="text-[10px]">{sheetSession.studio}</Badge>
                      )}
                      {sheetSession.rating != null && (
                        <Badge variant="secondary" className="text-[10px]">Rating: {sheetSession.rating.toFixed(1)}</Badge>
                      )}
                      {sheetSession.audienceRating != null && (
                        <Badge variant="secondary" className="text-[10px]">Audience: {sheetSession.audienceRating.toFixed(1)}</Badge>
                      )}
                    </div>
                    {sheetSession.genres && sheetSession.genres.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {sheetSession.genres.map(g => (
                          <ColorChip key={g} className="bg-white/10 text-white/80 border-white/20">{g}</ColorChip>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Stream Info */}
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Stream Info</h4>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary" className="text-[10px] gap-1">
                      <User className="h-2.5 w-2.5" />
                      {sheetSession.username}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {sheetSession.player.product} on {sheetSession.player.platform}
                    </Badge>
                    {sheetSession.player.address && (
                      <Badge variant="secondary" className="text-[10px] gap-1">
                        <Globe className="h-2.5 w-2.5" />
                        {sheetSession.player.address}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-[10px] gap-1">
                      {sheetSession.player.local ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
                      {sheetSession.player.local ? "LAN" : "WAN"}
                    </Badge>
                    {sheetSession.session.bandwidth > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        {formatBandwidth(sheetSession.session.bandwidth)}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-[10px] gap-1">
                      <Server className="h-2.5 w-2.5" />
                      {sheetSession.serverType !== "PLEX" && (
                        <span className="font-semibold">{sheetSession.serverType === "JELLYFIN" ? "JF" : sheetSession.serverType === "EMBY" ? "Emby" : ""} &middot;</span>
                      )}
                      {sheetSession.serverName}
                    </Badge>
                    {sheetSession.startedAt > 0 && (
                      <Badge variant="secondary" className="text-[10px] gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        Started {formatTime(sheetSession.startedAt)}
                      </Badge>
                    )}
                    {sheetSession.session.location && (
                      <Badge variant="secondary" className="text-[10px]">
                        {sheetSession.session.location}
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Media Info */}
                {(sheetSession.mediaWidth || sheetSession.videoCodec || sheetSession.audioCodec || sheetSession.container) && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Media Info</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {sheetSession.mediaWidth && sheetSession.mediaHeight && (
                        <Badge variant="outline" className="text-[10px]">
                          {sheetSession.mediaWidth}x{sheetSession.mediaHeight}
                        </Badge>
                      )}
                      {sheetSession.videoResolution && (
                        <Badge
                          variant="secondary"
                          className="text-[10px]"
                          style={getBadgeStyle("resolution", normalizeResolutionLabel(sheetSession.videoResolution))}
                        >
                          {normalizeResolutionLabel(sheetSession.videoResolution)}
                        </Badge>
                      )}
                      {sheetSession.aspectRatio && (
                        <Badge variant="secondary" className="text-[10px]">
                          {sheetSession.aspectRatio}
                        </Badge>
                      )}
                      {sheetSession.videoCodec && (
                        <Badge variant="secondary" className="text-[10px]">
                          Video: {sheetSession.videoCodec.toUpperCase()}
                          {sheetSession.videoProfile ? ` (${sheetSession.videoProfile})` : ""}
                        </Badge>
                      )}
                      {sheetSession.audioCodec && (
                        <Badge
                          variant="secondary"
                          className="text-[10px]"
                          style={sheetSession.audioProfile ? getBadgeStyle("audioProfile", sheetSession.audioProfile) : undefined}
                        >
                          Audio: {sheetSession.audioCodec.toUpperCase()}
                          {sheetSession.audioProfile ? ` (${sheetSession.audioProfile})` : ""}
                        </Badge>
                      )}
                      {sheetSession.audioChannels != null && (
                        <Badge variant="secondary" className="text-[10px]">
                          {sheetSession.audioChannels}ch
                        </Badge>
                      )}
                      {sheetSession.container && (
                        <Badge variant="secondary" className="text-[10px]">
                          {sheetSession.container.toUpperCase()}
                        </Badge>
                      )}
                      {sheetSession.bitrate != null && (
                        <Badge variant="secondary" className="text-[10px]">
                          {sheetSession.bitrate > 1000
                            ? `${(sheetSession.bitrate / 1000).toFixed(1)} Mbps`
                            : `${sheetSession.bitrate} kbps`}
                        </Badge>
                      )}
                      {sheetSession.optimizedForStreaming != null && (
                        <Badge variant="secondary" className="text-[10px]">
                          {sheetSession.optimizedForStreaming ? "Optimized" : "Not Optimized"}
                        </Badge>
                      )}
                      {sheetSession.partSize != null && (
                        <Badge variant="secondary" className="text-[10px]">
                          {sheetSession.partSize > 1073741824
                            ? `${(sheetSession.partSize / 1073741824).toFixed(1)} GB`
                            : `${(sheetSession.partSize / 1048576).toFixed(0)} MB`}
                        </Badge>
                      )}
                    </div>
                    {sheetSession.partFile && (
                      <p className="text-[11px] text-muted-foreground break-all mt-1">{sheetSession.partFile}</p>
                    )}
                  </div>
                )}

                {/* Transcode Details */}
                {sheetSession.transcoding && (sheetSession.transcoding.videoDecision === "transcode" || sheetSession.transcoding.audioDecision === "transcode") && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Transcode Details</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {sheetSession.transcoding.sourceVideoCodec && (
                        <Badge variant="outline" className="text-[10px] bg-amber/10 text-amber border-amber/30">
                          Video: {sheetSession.transcoding.sourceVideoCodec.toUpperCase()} &rarr; {sheetSession.transcoding.videoDecision}
                        </Badge>
                      )}
                      {sheetSession.transcoding.sourceAudioCodec && (
                        <Badge variant="outline" className="text-[10px] bg-amber/10 text-amber border-amber/30">
                          Audio: {sheetSession.transcoding.sourceAudioCodec.toUpperCase()} &rarr; {sheetSession.transcoding.audioDecision}
                        </Badge>
                      )}
                      {sheetSession.transcoding.transcodeHwRequested !== undefined && (
                        <Badge variant="secondary" className="text-[10px]">
                          HW Accel: {sheetSession.transcoding.transcodeHwRequested ? "Yes" : "No"}
                        </Badge>
                      )}
                      {sheetSession.transcoding.speed !== undefined && (
                        <Badge variant="secondary" className="text-[10px]">
                          Speed: {sheetSession.transcoding.speed.toFixed(1)}x
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-[10px]">
                        Throttled: {sheetSession.transcoding.throttled ? "Yes" : "No"}
                      </Badge>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
