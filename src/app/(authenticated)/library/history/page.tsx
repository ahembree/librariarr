"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { TableRowsSkeleton } from "@/components/skeletons";
import { ColorChip } from "@/components/color-chip";
import { ServerChips } from "@/components/server-chips";
import { getDuplicateServerNames } from "@/lib/server-styles";
import { ServerTypeChip } from "@/components/server-type-chip";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  History,
  Loader2,
  RefreshCw,
  Search,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { QueryProgress, useStreamProgress } from "@/components/query-progress";
import { consumeProgressStream } from "@/lib/progress/client";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { usePanelResize } from "@/hooks/use-panel-resize";
import { useServers } from "@/hooks/use-servers";
import { useChipColors } from "@/components/chip-color-provider";
import { formatFileSize, formatDuration } from "@/lib/format";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { MEDIA_TYPE_BADGE_COLORS, MEDIA_TYPE_LABELS } from "@/lib/theme/media-type-colors";
import { EmptyState } from "@/components/empty-state";
import type { MediaItemWithRelations } from "@/lib/types";

// ── Types ────────────────────────────────────────────────────────

interface WatchHistoryItem {
  id: string;
  serverUsername: string;
  watchedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  // Provenance + stream facts. Only a Tracearr-sourced play carries these — a
  // media server's own history API reports that something was played, not how
  // completely or through which transcode — so every one is null on a NATIVE
  // row and the columns rendering them default to hidden.
  source: string;
  watched: boolean | null;
  percentComplete: number | null;
  isTranscode: boolean | null;
  videoDecision: string | null;
  audioDecision: string | null;
  player: string | null;
  product: string | null;
  /** The resolution actually delivered, which a transcode drops below the file's. */
  resolution: string | null;
  bitrate: number | null;
  segmentCount: number | null;
  durationMs: number | null;
  totalDurationMs: number | null;
  progressMs: number | null;
  mediaItem: {
    id: string;
    title: string;
    titleSort: string | null;
    parentTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    year: number | null;
    type: string;
    resolution: string | null;
    dynamicRange: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    audioChannels: number | null;
    audioProfile: string | null;
    fileSize: string | null;
    duration: number | null;
    summary: string | null;
    contentRating: string | null;
    rating: number | null;
    ratingImage: string | null;
    audienceRating: number | null;
    audienceRatingImage: string | null;
    studio: string | null;
    playCount: number;
    lastPlayedAt: string | null;
    addedAt: string | null;
    genres: string[] | null;
  };
  server: { id: string; name: string; type: string };
}

// ── Constants ────────────────────────────────────────────────────

const PAGE_SIZE = 100;

/**
 * How often the Tracearr import status is re-read while a backfill is still
 * running. Slow on purpose — the backfill walks a large archive over minutes
 * in five-minute job slices, so this only needs to notice that it finished,
 * and it stops entirely once a SUCCESSFUL read reports nothing pending (a
 * failed read means "unknown", which is a reason to keep asking, not to stop).
 */
const TRACEARR_IMPORT_POLL_MS = 30_000;

const COLUMN_TO_SORT_FIELD: Record<string, string> = {
  title: "title",
  type: "type",
  serverUsername: "serverUsername",
  watchedAt: "watchedAt",
  year: "year",
  resolution: "resolution",
  dynamicRange: "dynamicRange",
  duration: "duration",
  fileSize: "fileSize",
  deviceName: "deviceName",
  platform: "platform",
  server: "serverUsername",
  // Tracearr stream facts. `streamResolution` maps to its own API sort key
  // rather than reusing `resolution`, which sorts the FILE's resolution on the
  // MediaItem — the two disagree on any transcoded play.
  transcode: "isTranscode",
  completion: "percentComplete",
  player: "player",
  streamResolution: "streamResolution",
};

const VISIBLE_KEY = "history-visible-columns";

function loadVisibleColumns(): Set<string> {
  try {
    const stored = localStorage.getItem(VISIBLE_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* use defaults */ }
  return new Set<string>();
}

function saveVisibleColumns(cols: Set<string>) {
  try {
    localStorage.setItem(VISIBLE_KEY, JSON.stringify([...cols]));
  } catch { /* private mode / quota — ignore */ }
}

function formatResolution(res: string | null) {
  if (!res) return "";
  const label = normalizeResolutionLabel(res);
  return label === "Other" ? res : label;
}

/**
 * Three-way stream decision, mirroring the Stream Manager's `getStreamDecision`
 * (`/tools/streams`) so the same play reads the same in both places: any
 * re-encode is a Transcode, a container-only "copy" is a Direct Stream, and
 * everything else is Direct Play. Tracearr's `is_transcode` already covers an
 * audio-only re-encode, which must not be shown with the greener Direct Stream
 * styling. Returns null for a NATIVE row, which records no decision at all.
 */
function getStreamDecision(item: WatchHistoryItem): { label: string; direct: boolean } | null {
  if (item.isTranscode == null) return null;
  if (item.isTranscode) return { label: "Transcode", direct: false };
  if (item.videoDecision === "copy" || item.audioDecision === "copy") {
    return { label: "Direct Stream", direct: true };
  }
  return { label: "Direct Play", direct: true };
}

/**
 * Tooltip for the transcode chip: the per-track decisions behind the label plus
 * the delivered bitrate, so a "Transcode" chip can say what was re-encoded.
 */
function getStreamDecisionTitle(item: WatchHistoryItem): string | undefined {
  const parts: string[] = [];
  if (item.videoDecision) parts.push(`video: ${item.videoDecision}`);
  if (item.audioDecision) parts.push(`audio: ${item.audioDecision}`);
  if (item.bitrate != null) parts.push(`${item.bitrate.toLocaleString()} kbps`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Tracearr's `percentComplete` (0-100, one decimal) as a whole percentage. */
function formatCompletion(pct: number | null): string {
  if (pct == null) return "-";
  return `${Math.round(pct)}%`;
}

/**
 * Tooltip for the completion cell: how far into the runtime the play reached,
 * plus the resume-chain length when Tracearr folded more than one session into
 * it (segmentCount is the only field that reveals a resumed play).
 */
function getCompletionTitle(item: WatchHistoryItem): string | undefined {
  const parts: string[] = [];
  if (item.progressMs != null && item.totalDurationMs != null) {
    parts.push(`${formatDuration(item.progressMs)} of ${formatDuration(item.totalDurationMs)}`);
  }
  if (item.segmentCount != null && item.segmentCount > 1) {
    parts.push(`${item.segmentCount} sessions`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatWatchedAt(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const watchDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - watchDay.getTime()) / 86400000);

  if (diffDays === 0) {
    return `Today ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } else if (diffDays === 1) {
    return `Yesterday ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function getItemTitle(item: WatchHistoryItem): string {
  const mi = item.mediaItem;
  if (mi.type === "SERIES" && mi.parentTitle) {
    const ep = mi.seasonNumber != null && mi.episodeNumber != null
      ? ` - S${String(mi.seasonNumber).padStart(2, "0")}E${String(mi.episodeNumber).padStart(2, "0")}`
      : "";
    return `${mi.parentTitle}${ep} - ${mi.title}`;
  }
  if (mi.type === "MUSIC" && mi.parentTitle) {
    return `${mi.parentTitle} - ${mi.title}`;
  }
  return mi.title;
}

function getItemDetailUrl(item: WatchHistoryItem): string {
  switch (item.mediaItem.type) {
    case "MOVIE": return `/library/movies/${item.mediaItem.id}`;
    case "SERIES": return `/library/series/episode/${item.mediaItem.id}`;
    case "MUSIC": return `/library/music/track/${item.mediaItem.id}`;
    default: return `/library/movies/${item.mediaItem.id}`;
  }
}

// ── Column groups ────────────────────────────────────────────────

interface HistoryColumn extends DataTableColumn<WatchHistoryItem> {
  group: string;
  defaultVisible: boolean;
}

const COLUMN_GROUPS: Record<string, string> = {
  core: "Core",
  playback: "Playback",
  video: "Video",
  audio: "Audio",
  file: "File",
  device: "Device",
  // Stream facts only a Tracearr-linked server records. Kept as its own group
  // so "Resolution" (the file) and "Stream Resolution" (what was delivered)
  // can't be mistaken for each other in the visibility menu.
  stream: "Stream",
};

// ── Component ────────────────────────────────────────────────────

export default function HistoryPage() {
  const { servers } = useServers();
  const { getBadgeStyle } = useChipColors();
  const { width: panelWidth, resizeHandleProps } = usePanelResize({
    storageKey: "library-history-panel-width",
    defaultWidth: 480,
    minWidth: 360,
    maxWidth: 800,
  });

  // Data
  const [items, setItems] = useState<WatchHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // Live progress for the foreground watch-history sync. `syncing` still owns
  // the button's disabled/spinner treatment; this only drives the bar, so a
  // stream that never emits a plan simply leaves the old spinner-only look.
  const {
    state: syncProgress,
    handleUpdate: onSyncProgress,
    reset: resetSyncProgress,
  } = useStreamProgress();
  // True while at least one Tracearr-mapped server still owes a backfill, as of
  // the last SUCCESSFUL status read. A large archive is imported newest-first
  // over many background job slices, so this table can be showing a genuinely
  // partial history with no other clue that older plays are still on their way.
  const [importBackfillPending, setImportBackfillPending] = useState(false);
  // Whether a successful read has ever reported every mapped server finished.
  // This — not the pending flag — gates the poll, because the two answers
  // differ on exactly the case that matters. A failed read is "unknown", and
  // unknown must keep asking; when the poll was gated on the pending flag and a
  // failure cleared it, one blip (a deploy, a 500, a momentary network drop)
  // latched the note off and stopped the poll for the rest of the session while
  // the archive walk was still running.
  const [importBackfillSettled, setImportBackfillSettled] = useState(false);
  // How far that backfill has got, as a whole percentage of the archive's time
  // span, or null when no honest number exists yet. Null is NOT zero: it means
  // the start of the archive hasn't been measured, so the note keeps its
  // original wording rather than claiming 0%.
  const [importBackfillPercent, setImportBackfillPercent] = useState<number | null>(null);
  const [selectedItem, setSelectedItem] = useState<MediaItemWithRelations | null>(null);
  const [selectedItemType, setSelectedItemType] = useState<"MOVIE" | "SERIES" | "MUSIC">("MOVIE");
  const [selectedDetailUrl, setSelectedDetailUrl] = useState<string>("");
  const [, setLoadingDetail] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // Sort (server-side)
  const [sortBy, setSortBy] = useState("watchedAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Filter dropdowns data
  const [usernames, setUsernames] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);

  // Filters
  const [search, setSearch] = useState("");
  // Debounced search value drives fetching so each keystroke doesn't fire a request.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string>("all");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedUsernames, setSelectedUsernames] = useState<Set<string>>(new Set());
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [selectedResolutions] = useState<Set<string>>(new Set());

  // Column visibility
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => loadVisibleColumns());

  // ── Column definitions ──────────────────────────────────────────

  const allColumns: HistoryColumn[] = useMemo(() => [
    {
      id: "title",
      header: "Title",
      defaultWidth: 250,
      group: "core",
      defaultVisible: true,
      accessor: (item) => (
        <span className="truncate font-medium" title={getItemTitle(item)}>
          {getItemTitle(item)}
        </span>
      ),
      sortValue: (item) => item.mediaItem.titleSort ?? item.mediaItem.title,
    },
    {
      id: "type",
      header: "Type",
      defaultWidth: 80,
      group: "core",
      defaultVisible: true,
      accessor: (item) => (
        <ColorChip className={cn("text-xs", MEDIA_TYPE_BADGE_COLORS[item.mediaItem.type])}>
          {MEDIA_TYPE_LABELS[item.mediaItem.type] ?? item.mediaItem.type}
        </ColorChip>
      ),
      sortValue: (item) => item.mediaItem.type,
    },
    {
      id: "serverUsername",
      header: "User",
      defaultWidth: 120,
      group: "playback",
      defaultVisible: true,
      className: "text-muted-foreground",
      accessor: (item) => item.serverUsername,
      sortValue: (item) => item.serverUsername,
    },
    {
      id: "watchedAt",
      header: "Watched At",
      defaultWidth: 140,
      group: "playback",
      defaultVisible: true,
      accessor: (item) => (
        <span className="text-muted-foreground" title={item.watchedAt ?? undefined}>
          {formatWatchedAt(item.watchedAt)}
        </span>
      ),
      sortValue: (item) => item.watchedAt ? new Date(item.watchedAt).getTime() : 0,
    },
    {
      id: "year",
      header: "Year",
      defaultWidth: 70,
      group: "core",
      defaultVisible: false,
      className: "text-muted-foreground",
      accessor: (item) => item.mediaItem.year ?? "-",
      sortValue: (item) => item.mediaItem.year,
    },
    {
      id: "resolution",
      header: "Resolution",
      defaultWidth: 100,
      group: "video",
      defaultVisible: true,
      accessor: (item) => {
        const res = item.mediaItem.resolution;
        if (!res) return "-";
        const label = formatResolution(res);
        return (
          <ColorChip style={getBadgeStyle("resolution", label)}>
            {label}
          </ColorChip>
        );
      },
      sortValue: (item) => item.mediaItem.resolution,
    },
    {
      id: "dynamicRange",
      header: "HDR",
      defaultWidth: 90,
      group: "video",
      defaultVisible: true,
      accessor: (item) => {
        const dr = item.mediaItem.dynamicRange;
        if (!dr) return "-";
        return (
          <ColorChip style={getBadgeStyle("dynamicRange", dr)}>
            {dr}
          </ColorChip>
        );
      },
      sortValue: (item) => item.mediaItem.dynamicRange,
    },
    {
      id: "videoCodec",
      header: "Video Codec",
      defaultWidth: 100,
      group: "video",
      defaultVisible: false,
      className: "text-muted-foreground",
      accessor: (item) => item.mediaItem.videoCodec ?? "-",
      sortValue: (item) => item.mediaItem.videoCodec,
    },
    {
      id: "duration",
      header: "Duration",
      defaultWidth: 90,
      group: "file",
      defaultVisible: true,
      className: "text-right text-muted-foreground",
      headerClassName: "text-right",
      accessor: (item) => formatDuration(item.mediaItem.duration),
      sortValue: (item) => item.mediaItem.duration,
    },
    {
      id: "fileSize",
      header: "Size",
      defaultWidth: 90,
      group: "file",
      defaultVisible: false,
      className: "text-right text-muted-foreground",
      headerClassName: "text-right",
      accessor: (item) => formatFileSize(item.mediaItem.fileSize),
      sortValue: (item) => (item.mediaItem.fileSize ? Number(item.mediaItem.fileSize) : null),
    },
    {
      id: "audioCodec",
      header: "Audio",
      defaultWidth: 130,
      group: "audio",
      defaultVisible: false,
      className: "text-muted-foreground",
      accessor: (item) => {
        const codec = item.mediaItem.audioCodec ?? "";
        const ch = item.mediaItem.audioChannels;
        return ch ? `${codec} ${ch}ch` : codec || "-";
      },
      sortValue: (item) => item.mediaItem.audioCodec,
    },
    {
      id: "deviceName",
      header: "Device",
      defaultWidth: 120,
      group: "device",
      defaultVisible: true,
      className: "text-muted-foreground",
      accessor: (item) => item.deviceName ?? "-",
      sortValue: (item) => item.deviceName,
    },
    {
      id: "platform",
      header: "Platform",
      defaultWidth: 100,
      group: "device",
      defaultVisible: true,
      className: "text-muted-foreground",
      accessor: (item) => item.platform ?? "-",
      sortValue: (item) => item.platform,
    },
    // ── Tracearr stream facts ────────────────────────────────────
    // All default-hidden: they are null for a NATIVE row, so the table a user
    // without a Tracearr-linked server sees is unchanged.
    {
      id: "transcode",
      header: "Transcode",
      defaultWidth: 110,
      group: "stream",
      defaultVisible: false,
      accessor: (item) => {
        const decision = getStreamDecision(item);
        if (!decision) return "-";
        return (
          <ColorChip
            title={getStreamDecisionTitle(item)}
            className={
              decision.direct
                ? "bg-green-dim text-green border-green/25"
                : "bg-amber-dim text-amber border-amber/25"
            }
          >
            {decision.label}
          </ColorChip>
        );
      },
      // Sorting is server-side (see COLUMN_TO_SORT_FIELD → isTranscode);
      // sortValue only has to exist for DataTable to make the header sortable.
      sortValue: (item) => (item.isTranscode == null ? null : item.isTranscode ? 1 : 0),
    },
    {
      id: "completion",
      header: "Completion",
      defaultWidth: 100,
      group: "stream",
      defaultVisible: false,
      className: "text-right text-muted-foreground tabular-nums",
      headerClassName: "text-right",
      accessor: (item) => (
        <span title={getCompletionTitle(item)}>{formatCompletion(item.percentComplete)}</span>
      ),
      sortValue: (item) => item.percentComplete,
    },
    {
      id: "player",
      header: "Player",
      defaultWidth: 120,
      group: "stream",
      defaultVisible: false,
      className: "text-muted-foreground",
      // `product` is the client app ("Plex for Apple TV") and `player` the
      // player/device name; the product rides along in the tooltip rather than
      // costing a second column.
      accessor: (item) => (
        <span className="truncate" title={item.product ?? undefined}>
          {item.player ?? "-"}
        </span>
      ),
      sortValue: (item) => item.player,
    },
    {
      id: "streamResolution",
      header: "Stream Resolution",
      defaultWidth: 130,
      group: "stream",
      defaultVisible: false,
      accessor: (item) => {
        const res = item.resolution;
        if (!res) return "-";
        const label = formatResolution(res);
        return (
          <ColorChip style={getBadgeStyle("resolution", label)}>
            {label}
          </ColorChip>
        );
      },
      sortValue: (item) => item.resolution,
    },
    {
      id: "server",
      header: "Server",
      defaultWidth: 110,
      group: "core",
      defaultVisible: true,
      accessor: (item) => (
        <ServerChips servers={[{ serverId: item.server.id, serverName: item.server.name, serverType: item.server.type }]} />
      ),
      sortValue: (item) => item.server.name,
    },
  ], [getBadgeStyle]);

  // ── Column visibility ──────────────────────────────────────────

  const activeColumns = useMemo(() => {
    if (visibleCols.size === 0) {
      return allColumns.filter((c) => c.defaultVisible);
    }
    return allColumns.filter((c) => visibleCols.has(c.id));
  }, [allColumns, visibleCols]);

  const toggleColumn = useCallback((colId: string) => {
    setVisibleCols((prev) => {
      const next = new Set(prev.size === 0
        ? allColumns.filter((c) => c.defaultVisible).map((c) => c.id)
        : prev,
      );
      if (next.has(colId)) next.delete(colId);
      else next.add(colId);
      saveVisibleColumns(next);
      return next;
    });
  }, [allColumns]);

  const effectiveVisible = useMemo(() => {
    if (visibleCols.size === 0) {
      return new Set(allColumns.filter((c) => c.defaultVisible).map((c) => c.id));
    }
    return visibleCols;
  }, [visibleCols, allColumns]);

  // ── Data fetching ──────────────────────────────────────────────

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timeout);
  }, [search]);

  // Token guards against a stale slow response landing after a quick
  // filter/page flip and overwriting the current result set.
  const reqToken = useRef(0);
  // Separate token for the detail panel so rapidly clicking two rows doesn't
  // let the slower /api/media/:id response win and show the wrong item.
  const detailReqToken = useRef(0);

  const fetchHistory = useCallback(async (fetchPage: number) => {
    const token = ++reqToken.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(fetchPage),
        limit: String(PAGE_SIZE),
        sortBy,
        sortOrder,
      });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (selectedServerId !== "all") params.set("serverId", selectedServerId);
      if (selectedTypes.size > 0) params.set("type", [...selectedTypes].join("|"));
      if (selectedUsernames.size > 0) params.set("username", [...selectedUsernames].join("|"));
      if (selectedPlatforms.size > 0) params.set("platform", [...selectedPlatforms].join("|"));
      if (selectedResolutions.size > 0) params.set("resolution", [...selectedResolutions].join("|"));

      const res = await fetch(`/api/media/history?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (token !== reqToken.current) return;
      setItems(data.items || []);
      setTotalCount(data.pagination?.totalCount ?? 0);
      setHasMore(data.pagination?.hasMore ?? false);
      setPage(fetchPage);
      setUsernames(data.usernames ?? []);
      setPlatforms(data.platforms ?? []);
    } catch {
      if (token !== reqToken.current) return;
      setItems([]);
      setTotalCount(0);
      setHasMore(false);
    } finally {
      if (token === reqToken.current) setLoading(false);
    }
  }, [debouncedSearch, selectedServerId, selectedTypes, selectedUsernames, selectedPlatforms, selectedResolutions, sortBy, sortOrder]);

  // Reset to page 1 when filters change
  useEffect(() => {
    void (async () => { await fetchHistory(1); })();
  }, [fetchHistory]);

  // ── Tracearr import progress ───────────────────────────────────

  /**
   * Asks whether any mapped server is still importing. The endpoint reports
   * only Tracearr-mapped servers, so a setup with no Tracearr answers with an
   * empty list — which resolves to "nothing pending" and, because that answer
   * retires the poll below, means the common native-history setup makes exactly
   * one request and never polls.
   *
   * A failure (a 500 mid-deploy, a dropped connection, a 401 on a dead session)
   * means UNKNOWN, not finished, so it deliberately changes nothing: the last
   * known state stays on screen and the poll keeps asking. Only a successful
   * response can move the flags. Resolving a failure to "nothing pending"
   * instead is what made one transient error hide the note permanently — the
   * flag it cleared also gated the poll, so nothing ever asked again even
   * though the backfill was still running. It stays silent either way: this is
   * a background note about someone else's job, never an error toast.
   */
  const fetchImportBackfillPending = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/tracearr/status");
      if (!res.ok) return;
      const data = (await res.json()) as {
        servers?: { backfillComplete: boolean; backfillFraction: number | null }[];
      };
      const pending = (data.servers ?? []).filter((s) => !s.backfillComplete);
      setImportBackfillPending(pending.length > 0);
      // Recomputed from every successful read rather than latched, so a backfill
      // that appears later (a server mapped to Tracearr after this page loaded,
      // or the archive walk a foreground sync just queued) re-arms the poll.
      setImportBackfillSettled(pending.length === 0);
      // The note clears only once EVERY mapped server is finished, so the
      // number that describes it is the least-advanced server's — an average
      // would keep climbing while the laggard that actually gates the note sat
      // still. One unmeasured server makes the whole note indeterminate: a
      // server with no fraction could be anywhere, so there is no floor to
      // report and null (not 0) is the honest answer.
      const known = pending
        .map((s) => s.backfillFraction)
        .filter((fraction): fraction is number => fraction !== null);
      setImportBackfillPercent(
        pending.length > 0 && known.length === pending.length
          ? Math.round(Math.min(...known) * 100)
          : null,
      );
    } catch {
      // Unknown, not finished — see above. No state change, on purpose: the
      // note (and its percentage) keeps saying whatever the last successful
      // read said, and the poll stays armed to ask again.
    }
  }, []);

  useEffect(() => {
    // Kicked off from an async IIFE (the idiom the initial-load effects use)
    // rather than called directly: the fetch sets state before its first await,
    // and a setState that runs synchronously inside an effect body triggers a
    // cascading render.
    void (async () => {
      await fetchImportBackfillPending();
    })();
  }, [fetchImportBackfillPending]);

  // Poll until a successful read says the import is done, so the note can clear
  // itself without a reload; the interval is torn down then and on unmount.
  //
  // It starts armed rather than waiting for a "pending" answer, because the
  // mount read can fail too — arming on the pending flag would mean a first
  // failed read leaves the page with nothing scheduled to ever correct it. The
  // common setup with nothing to import still costs exactly one request: the
  // mount read answers "complete" and clears this interval long before its
  // first 30s tick. The dependency is the boolean, not a response object, so a
  // poll that changes nothing doesn't rebuild the timer.
  useEffect(() => {
    if (importBackfillSettled) return;
    const interval = setInterval(() => { void fetchImportBackfillPending(); }, TRACEARR_IMPORT_POLL_MS);
    return () => clearInterval(interval);
  }, [importBackfillSettled, fetchImportBackfillPending]);

  // ── Sort handler (server-side) ─────────────────────────────────

  const handleSortChange = useCallback((colId: string, order: "asc" | "desc") => {
    const apiSortBy = COLUMN_TO_SORT_FIELD[colId] ?? "watchedAt";
    setSortBy(apiSortBy);
    setSortOrder(order);
  }, []);

  // ── Sync handler ───────────────────────────────────────────────

  // Cancellation for the in-flight sync. Aborting the FETCH is the entire chain:
  // it tears down the response stream, which aborts the route's request signal,
  // which the Tracearr importer checks at the top of every page and passes into
  // its HTTP call — so a Stop lands within one page instead of after all ~1,600
  // of them. Nothing else in the UI has to be wired for cancellation to work.
  const syncAbortRef = useRef<AbortController | null>(null);
  // Guards the post-abort bookkeeping. Unmounting aborts too (below), and a
  // toast plus a refetch fired at a page the user already navigated away from
  // is noise at best.
  const syncMountedRef = useRef(true);
  useEffect(() => {
    syncMountedRef.current = true;
    return () => {
      syncMountedRef.current = false;
      // Don't leave the request — and therefore the importer — grinding through
      // pages for a page nobody is looking at.
      syncAbortRef.current?.abort();
    };
  }, []);

  const handleStopSync = useCallback(() => {
    syncAbortRef.current?.abort();
  }, []);

  // This is the one sync a user waits on in the foreground, and a first Tracearr
  // import pulls a server's whole history (minutes, not seconds), so the route
  // streams NDJSON progress — one phase per server — instead of resolving as a
  // single opaque JSON blob at the very end.
  const handleSync = async () => {
    resetSyncProgress();
    setSyncing(true);
    const controller = new AbortController();
    syncAbortRef.current = controller;
    try {
      const body: Record<string, string> = {};
      if (selectedServerId !== "all") body.serverId = selectedServerId;
      const response = await fetch("/api/media/history/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Auth/validation/not-found failures are answered as plain JSON BEFORE the
      // stream opens, so a non-OK response is not NDJSON — read the error body
      // here rather than handing it to consumeProgressStream, which would only
      // report a parse failure and lose the server's actual reason.
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error("Sync failed", {
          description: data?.error ?? "The watch-history sync could not be started.",
        });
        return;
      }

      // Throws on an in-band { type: "error" } event or a stream that ends
      // without a result — both land in the catch below rather than becoming an
      // unhandled rejection that stops the bar with no explanation.
      const result = await consumeProgressStream<{
        success: boolean;
        counts: Record<string, number>;
        cancelled: boolean;
      }>(response, onSyncProgress);
      await fetchHistory(1);

      // The run reached its terminal result but stopped early — the route's
      // 30-minute lifetime cap fired. (A Stop from this page can't land here:
      // aborting the fetch tears the stream down client-side, so that path
      // rejects into the catch below and never sees a result.) A first import
      // of a very large history genuinely outlasts the cap, so say plainly that
      // what's on screen is incomplete — otherwise the user reads a finished
      // progress bar as a finished history and never runs the second pass.
      if (result?.cancelled) {
        toast.warning("Sync stopped at the time limit", {
          description: "The import ran long and is incomplete. Run Refresh again to continue from where it stopped.",
        });
      }

      // A per-server count of -1 means that server threw; the run as a whole
      // still succeeded for the others, so name the ones that failed instead of
      // silently presenting a history that's missing a server's plays.
      const failed = Object.entries(result?.counts ?? {})
        .filter(([, count]) => count < 0)
        .map(([serverId]) => servers.find((s) => s.id === serverId)?.name ?? serverId);
      if (failed.length > 0) {
        toast.warning(`Couldn't sync ${failed.length === 1 ? "a server" : "some servers"}`, {
          description: `${failed.join(", ")} — check the server's connection and try again.`,
        });
      }
    } catch (err) {
      // Nothing to report to a page the user has already left (the unmount
      // cleanup aborts, which lands right here).
      if (!syncMountedRef.current) return;

      // The user pressed Stop. `fetch`/`consumeProgressStream` reject with an
      // AbortError, but this is the outcome that was asked for, not a failure —
      // so no error toast. Everything already imported is durable: the Tracearr
      // importer appends/upserts and advances its watermark page by page, so
      // the next Refresh literally resumes from where this run stopped.
      if ((err as { name?: string } | null)?.name === "AbortError") {
        toast.info("Sync stopped", {
          description: "Plays already imported were kept. Run Refresh again to continue from where it stopped.",
        });
      } else {
        // Network failure or an in-band stream error. Any server that finished
        // before the failure has already committed its rows, so refresh anyway —
        // then say what happened, because a bar that just stops explains nothing.
        toast.error("Sync failed", {
          description: "The watch-history sync stopped before it finished. Some plays may still have been imported.",
        });
      }
      // Partial rows are real rows either way, so show them.
      await fetchHistory(1);
    } finally {
      setSyncing(false);
      resetSyncProgress();
      syncAbortRef.current = null;
      // A foreground sync only runs the bounded forward pass for a Tracearr
      // server and hands the archive walk to the job queue, so the background
      // note may have just become true (or, on a run that finished the walk,
      // false). Re-ask now instead of leaving it up to 30s stale.
      if (syncMountedRef.current) void fetchImportBackfillPending();
    }
  };

  // ── Multi-select toggle helpers ────────────────────────────────

  const toggleType = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleUsername = (username: string) => {
    setSelectedUsernames((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  };

  const togglePlatform = (platform: string) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  };

  // ── Detail panel ──────────────────────────────────────────────

  const openDetailPanel = useCallback(async (historyItem: WatchHistoryItem) => {
    const token = ++detailReqToken.current;
    const mediaType = historyItem.mediaItem.type as "MOVIE" | "SERIES" | "MUSIC";
    setSelectedItemType(mediaType);
    setSelectedDetailUrl(getItemDetailUrl(historyItem));
    setLoadingDetail(true);
    try {
      const response = await fetch(`/api/media/${historyItem.mediaItem.id}`);
      // Ignore a stale response superseded by a newer click.
      if (token !== detailReqToken.current) return;
      if (response.ok) {
        const data = await response.json();
        setSelectedItem(data.item ?? data);
      }
    } catch (error) {
      console.error("Failed to fetch media item:", error);
    } finally {
      if (token === detailReqToken.current) setLoadingDetail(false);
    }
  }, []);

  // ── Pagination info ───────────────────────────────────────────

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const rangeStart = (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);

  // Map current sortBy back to DataTable column ID for sort indicator
  const activeColumnSortId = useMemo(() => {
    const reverse = Object.fromEntries(
      Object.entries(COLUMN_TO_SORT_FIELD).map(([col, field]) => [field, col]),
    );
    return reverse[sortBy] ?? "watchedAt";
  }, [sortBy]);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <>
      <div className="p-4 sm:p-6 lg:p-8 overflow-x-clip">
          {/* Header */}
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Watch History</h1>
                {!loading && totalCount > 0 && (
                  <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
                    {totalCount.toLocaleString()} {totalCount === 1 ? "play" : "plays"}
                  </span>
                )}
              </div>
              <p className="text-muted-foreground mt-1">
                Play events across your connected media servers — filter by user, platform, server, or media type.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
              className="shrink-0"
            >
              {syncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {syncing ? "Syncing..." : "Refresh"}
            </Button>
          </div>

          {/* Streamed sync progress — one phase per server — with the Stop
              control that cancels it. Sits directly under the Refresh button
              that started it, which is where the user is already looking, and
              mounts/unmounts exactly once per sync: the phase events only
              repaint inside this fixed-height block, so the filters and table
              below never shuffle as progress ticks. Gated on `syncing` alone
              rather than on the phase list, so Stop exists for the whole run
              including the moment before the plan event lands — a sync a user
              can't reach the brakes for is the bug this fixes. It also renders
              above the empty state, so the "Sync Now" path gets the same
              control. */}
          {syncing && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3">
              <div className="min-w-0 flex-1">
                {syncProgress.phases.length > 0 ? (
                  <QueryProgress state={syncProgress} />
                ) : (
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground/90">
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                    Starting sync…
                  </span>
                )}
              </div>
              {/* Ghost + destructive tint, never a primary button: stopping is a
                  corrective action, not the thing we want the user to do. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStopSync}
                title="Stop the watch-history sync"
                className="shrink-0 self-start text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Square className="mr-2 h-3.5 w-3.5" />
                Stop
              </Button>
            </div>
          )}

          {/* A partial table with no explanation reads as missing data. This
              says why — quietly: muted text, no border, no card, no
              destructive/amber tint, because nothing is wrong. It disappears
              on its own when the poll above sees every mapped server complete.
              Suppressed during a foreground sync, where the progress bar
              directly above is already saying the same thing more precisely. */}
          {importBackfillPending && !syncing && (
            <p className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              {/* The percentage is of the archive's TIME SPAN, said out loud:
                  plays whose media has since been deleted can't be stored, so a
                  count-based reading of "63%" against this table's row count
                  would never add up. Without a measured span there is no honest
                  number, so the note keeps its original wording rather than
                  showing 0%. */}
              {importBackfillPercent === null
                ? "Still importing older history in the background."
                : `Still importing older history in the background — ${importBackfillPercent}% of the time span covered.`}
            </p>
          )}

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {/* Search */}
            <div className="relative w-56">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search titles..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9"
              />
            </div>

            {/* Server filter */}
            {servers.length > 1 && (() => {
              const dupeNames = getDuplicateServerNames(servers);
              return (
                <Select value={selectedServerId} onValueChange={setSelectedServerId}>
                  <SelectTrigger className="w-40 h-9">
                    <SelectValue placeholder="All Servers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Servers</SelectItem>
                    {servers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="inline-flex items-center gap-1.5">
                          {s.name}
                          {dupeNames.has(s.name) && s.type && <ServerTypeChip type={s.type} />}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            })()}

            {/* Type toggles */}
            <div className="flex items-center rounded-lg border h-9 p-0.5">
              {(["MOVIE", "SERIES", "MUSIC"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={cn(
                    "rounded-md px-3 h-full text-xs font-medium transition-colors",
                    selectedTypes.has(t)
                      ? MEDIA_TYPE_BADGE_COLORS[t]
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {MEDIA_TYPE_LABELS[t]}
                </button>
              ))}
            </div>

            {/* Username filter */}
            {usernames.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="default">
                    Users{selectedUsernames.size > 0 ? ` (${selectedUsernames.size})` : ""}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-60 overflow-y-auto p-2">
                  {usernames.map((u) => (
                    <label key={u} className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-accent rounded text-sm">
                      <Checkbox
                        checked={selectedUsernames.has(u)}
                        onCheckedChange={() => toggleUsername(u)}
                      />
                      {u}
                    </label>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Platform filter */}
            {platforms.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="default">
                    Platforms{selectedPlatforms.size > 0 ? ` (${selectedPlatforms.size})` : ""}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-60 overflow-y-auto p-2">
                  {platforms.map((p) => (
                    <label key={p} className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-accent rounded text-sm">
                      <Checkbox
                        checked={selectedPlatforms.has(p)}
                        onCheckedChange={() => togglePlatform(p)}
                      />
                      {p}
                    </label>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Column visibility */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="default" className="ml-auto">
                  <Columns3 className="mr-2 h-4 w-4" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-2rem)] max-h-80 overflow-y-auto p-2">
                {Object.entries(COLUMN_GROUPS).map(([groupKey, groupLabel]) => {
                  const groupCols = allColumns.filter((c) => c.group === groupKey);
                  if (groupCols.length === 0) return null;
                  return (
                    <div key={groupKey} className="mb-2">
                      <div className="px-2 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                        {groupLabel}
                      </div>
                      {groupCols.map((col) => (
                        <label
                          key={col.id}
                          className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-accent rounded text-sm"
                        >
                          <Checkbox
                            checked={effectiveVisible.has(col.id)}
                            onCheckedChange={() => toggleColumn(col.id)}
                          />
                          {col.header}
                        </label>
                      ))}
                    </div>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Table */}
          {loading ? (
            <TableRowsSkeleton rows={10} columns={5} />
          ) : items.length === 0 && totalCount === 0 ? (
            <EmptyState
              icon={History}
              title="No watch history"
              description="Watch history is synced automatically during server sync. You can also sync now to fetch the latest plays."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSync}
                  disabled={syncing}
                >
                  {syncing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {syncing ? "Syncing..." : "Sync Now"}
                </Button>
              }
            />
          ) : (
            <>
              <DataTable
                columns={activeColumns}
                data={items}
                onRowClick={openDetailPanel}
                keyExtractor={(item) => item.id}
                defaultSortId={activeColumnSortId}
                defaultSortOrder={sortOrder}
                onSortChange={handleSortChange}
                resizeStorageKey="history-col-widths"
                renderHoverContent={(item) => (
                  <MediaHoverPopover
                    imageUrl={`/api/media/${item.mediaItem.id}/image${item.mediaItem.parentTitle ? "?type=parent" : ""}`}
                    data={{
                      title: item.mediaItem.parentTitle
                        ? `${item.mediaItem.parentTitle} — ${item.mediaItem.title}`
                        : item.mediaItem.title,
                      year: item.mediaItem.year,
                      summary: item.mediaItem.summary,
                      contentRating: item.mediaItem.contentRating,
                      rating: item.mediaItem.rating,
                      audienceRating: item.mediaItem.audienceRating,
                      ratingImage: item.mediaItem.ratingImage,
                      audienceRatingImage: item.mediaItem.audienceRatingImage,
                      duration: item.mediaItem.duration,
                      resolution: item.mediaItem.resolution,
                      dynamicRange: item.mediaItem.dynamicRange,
                      audioProfile: item.mediaItem.audioProfile,
                      fileSize: item.mediaItem.fileSize,
                      genres: item.mediaItem.genres,
                      studio: item.mediaItem.studio,
                      playCount: item.mediaItem.playCount,
                      lastPlayedAt: item.mediaItem.lastPlayedAt,
                      addedAt: item.mediaItem.addedAt,
                      servers: [{ serverId: item.server.id, serverName: item.server.name, serverType: item.server.type }],
                    }}
                  />
                )}
              />

              {/* Pagination */}
              {totalCount > 0 && (
                <div className="flex items-center justify-between mt-6 text-sm text-muted-foreground">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {rangeStart.toLocaleString()}-{rangeEnd.toLocaleString()} of {totalCount.toLocaleString()}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      disabled={page <= 1}
                      onClick={() => fetchHistory(page - 1)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="px-2 text-sm">
                      Page {page} of {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      disabled={!hasMore}
                      onClick={() => fetchHistory(page + 1)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

      {/* Detail side panel */}
      {selectedItem && (
        <MediaDetailSidePanel
          item={selectedItem}
          mediaType={selectedItemType}
          onClose={() => setSelectedItem(null)}
          width={panelWidth}
          resizeHandleProps={resizeHandleProps}
          detailUrl={selectedDetailUrl}
        />
      )}
    </>
  );
}
