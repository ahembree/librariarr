"use client";

import React, { memo, useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { QualityChip } from "@/components/quality-chips";
import {
  audioProfileChipLabel,
  dynamicRangeChipLabel,
  qualityChips,
  resolutionChipLabel,
  type QualityChipSpec,
} from "@/lib/media/quality-chips";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronUp, ChevronDown, ChevronsUpDown, Columns3, ShieldOff } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
// The table renders list payloads, which carry no `summary` — see MediaListItem.
import type { MediaListItem } from "@/lib/types";
import { ServerChips } from "@/components/server-chips";
import { useColumnResize } from "@/hooks/use-column-resize";
import { useShellSettings, useShellSnapshot } from "@/components/shell-settings-provider";
import { toast } from "sonner";
import { formatFileSize, formatDuration, formatDate, formatDateOnly, formatChannels } from "@/lib/format";
import { formatEpisodeCode } from "@/lib/media/display-title";
import { intentHandlers } from "@/lib/intent-prefetch";
import { prefetchMediaRecord } from "@/lib/media/detail-prefetch";

/**
 * Generic over the row type so callers keep whatever they actually have.
 * `MediaListItem` is the floor — the table itself only ever reads list fields —
 * while the lifecycle preview passes a richer row and still gets that richer
 * type back in its callbacks. Pinning this to one concrete type would either
 * hide the preview's extra fields or hand list pages a `summary` their endpoint
 * never sent.
 */
interface MediaTableProps<T extends MediaListItem = MediaListItem> {
  items: T[];
  onItemClick: (item: T) => void;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  onSort?: (field: string) => void;
  mediaType?: string;
  hideParentTitle?: boolean;
  /** Ref to expose scrollToIndex for alphabet navigation */
  scrollToIndexRef?: React.RefObject<((index: number) => void) | null>;
  /** Set of media item IDs that have lifecycle exceptions — shows indicator icon */
  exceptedItemIds?: Set<string>;
  /** Hide the servers column (e.g. when only one server is connected) */
  hideServers?: boolean;
  /** Optional callback to add extra CSS classes to a row based on the item */
  rowClassName?: (item: T) => string | undefined;
  /** Optional render function for hover popover content on each row */
  renderHoverContent?: (item: T) => React.ReactNode;
}

// --- Column Definitions ---

interface ColumnDef {
  id: string;
  label: string;
  field: string;
  group: "core" | "video" | "audio" | "file" | "playback" | "content";
  defaultVisible: boolean;
  defaultWidth: number;
  sortable?: boolean;
  className?: string;
  render: (item: MediaListItem) => React.ReactNode;
}

/** One quality chip in a cell, or "-" when the item has no such value. */
function chipCell(chip: QualityChipSpec | null) {
  return chip ? <QualityChip chip={chip} /> : <span className="text-muted-foreground">-</span>;
}

function formatEpisodeLabel(item: MediaListItem, isMusic: boolean): string | null {
  if (!item.parentTitle) return null;
  if (isMusic) {
    return item.episodeNumber != null ? String(item.episodeNumber) : null;
  }
  return formatEpisodeCode(item.seasonNumber, item.episodeNumber);
}

function buildColumns(): ColumnDef[] {
  return [
  // Core (always title first, then contextual episode/year)
  {
    id: "year",
    label: "Year",
    field: "year",
    group: "core",
    defaultVisible: true,
    defaultWidth: 70,
    render: (item) => <span className="text-muted-foreground">{item.year ?? "-"}</span>,
  },
  {
    id: "servers",
    label: "Servers",
    field: "servers",
    group: "core",
    defaultVisible: true,
    defaultWidth: 110,
    sortable: false,
    render: (item) =>
      item.servers && item.servers.length > 0 ? (
        <ServerChips servers={item.servers} />
      ) : null,
  },
  {
    id: "resolution",
    label: "Resolution",
    field: "resolution",
    group: "video",
    defaultVisible: true,
    defaultWidth: 100,
    render: (item) => {
      const label = resolutionChipLabel(item.resolution);
      return chipCell(label ? { category: "resolution", label } : null);
    },
  },
  {
    id: "dynamicRange",
    label: "HDR",
    field: "dynamicRange",
    group: "video",
    defaultVisible: true,
    defaultWidth: 90,
    render: (item) => {
      const label = dynamicRangeChipLabel(item.dynamicRange);
      return chipCell(label ? { category: "dynamicRange", label } : null);
    },
  },
  {
    id: "videoCodec",
    label: "Video Codec",
    field: "videoCodec",
    group: "video",
    defaultVisible: true,
    defaultWidth: 110,
    render: (item) => (
      <span className="text-muted-foreground">{item.videoCodec?.toUpperCase() ?? "-"}</span>
    ),
  },
  {
    id: "audioCodec",
    label: "Audio Codec",
    field: "audioCodec",
    group: "audio",
    defaultVisible: true,
    defaultWidth: 130,
    render: (item) => chipCell(qualityChips(item, "music", { channels: true })[0] ?? null),
  },
  {
    id: "fileSize",
    label: "Size",
    field: "fileSize",
    group: "file",
    defaultVisible: true,
    defaultWidth: 90,
    render: (item) => (
      <span className="text-muted-foreground">{formatFileSize(item.fileSize)}</span>
    ),
  },
  {
    id: "duration",
    label: "Duration",
    field: "duration",
    group: "file",
    defaultVisible: true,
    defaultWidth: 90,
    render: (item) => (
      <span className="text-muted-foreground">{formatDuration(item.duration)}</span>
    ),
  },
  {
    id: "playCount",
    label: "Plays",
    field: "playCount",
    group: "playback",
    defaultVisible: true,
    defaultWidth: 70,
    className: "text-right",
    render: (item) =>
      item.playCount > 0 ? (
        <span className="text-green">{item.playCount}</span>
      ) : (
        <span className="text-muted-foreground">0</span>
      ),
  },
  // Additional columns (hidden by default)
  {
    id: "audioProfile",
    label: "Audio Profile",
    field: "audioProfile",
    group: "audio",
    defaultVisible: false,
    defaultWidth: 120,
    render: (item) => {
      const label = audioProfileChipLabel(item.audioProfile);
      return chipCell(label ? { category: "audioProfile", label } : null);
    },
  },
  {
    id: "audioChannels",
    label: "Channels",
    field: "audioChannels",
    group: "audio",
    defaultVisible: false,
    defaultWidth: 90,
    render: (item) => (
      <span className="text-muted-foreground">{item.audioChannels == null ? "-" : formatChannels(item.audioChannels)}</span>
    ),
  },
  {
    id: "container",
    label: "Container",
    field: "container",
    group: "file",
    defaultVisible: false,
    defaultWidth: 90,
    render: (item) => (
      <span className="text-muted-foreground">{item.container?.toUpperCase() ?? "-"}</span>
    ),
  },
  {
    id: "contentRating",
    label: "Content Rating",
    field: "contentRating",
    group: "content",
    defaultVisible: false,
    defaultWidth: 110,
    render: (item) => (
      <span className="text-muted-foreground">{item.contentRating ?? "-"}</span>
    ),
  },
  {
    id: "studio",
    label: "Studio",
    field: "studio",
    group: "content",
    defaultVisible: false,
    defaultWidth: 120,
    render: (item) => (
      <span className="text-muted-foreground truncate max-w-30 inline-block">{item.studio ?? "-"}</span>
    ),
  },
  {
    id: "videoBitDepth",
    label: "Bit Depth",
    field: "videoBitDepth",
    group: "video",
    defaultVisible: false,
    defaultWidth: 90,
    render: (item) => (
      <span className="text-muted-foreground">{item.videoBitDepth ? `${item.videoBitDepth}-bit` : "-"}</span>
    ),
  },
  {
    id: "videoFrameRate",
    label: "Frame Rate",
    field: "videoFrameRate",
    group: "video",
    defaultVisible: false,
    defaultWidth: 100,
    render: (item) => (
      <span className="text-muted-foreground">{item.videoFrameRate ?? "-"}</span>
    ),
  },
  {
    id: "videoBitrate",
    label: "Video Bitrate",
    field: "videoBitrate",
    group: "video",
    defaultVisible: false,
    defaultWidth: 110,
    render: (item) => (
      <span className="text-muted-foreground">
        {item.videoBitrate ? `${(item.videoBitrate / 1000).toFixed(1)} Mbps` : "-"}
      </span>
    ),
  },
  {
    id: "aspectRatio",
    label: "Aspect Ratio",
    field: "aspectRatio",
    group: "video",
    defaultVisible: false,
    defaultWidth: 100,
    render: (item) => (
      <span className="text-muted-foreground">{item.aspectRatio ?? "-"}</span>
    ),
  },
  {
    id: "lastPlayedAt",
    label: "Last Played",
    field: "lastPlayedAt",
    group: "playback",
    defaultVisible: false,
    defaultWidth: 110,
    render: (item) => (
      <span className="text-muted-foreground">{formatDate(item.lastPlayedAt)}</span>
    ),
  },
  {
    id: "addedAt",
    label: "Added",
    field: "addedAt",
    group: "playback",
    defaultVisible: false,
    defaultWidth: 100,
    render: (item) => (
      <span className="text-muted-foreground">{formatDate(item.addedAt)}</span>
    ),
  },
  {
    id: "originallyAvailableAt",
    label: "Released",
    field: "originallyAvailableAt",
    group: "content",
    defaultVisible: false,
    defaultWidth: 100,
    render: (item) => (
      <span className="text-muted-foreground">{formatDateOnly(item.originallyAvailableAt)}</span>
    ),
  },
  {
    id: "rating",
    label: "Rating",
    field: "rating",
    group: "content",
    defaultVisible: false,
    defaultWidth: 80,
    render: (item) => (
      <span className="text-muted-foreground">{item.rating?.toFixed(1) ?? "-"}</span>
    ),
  },
  {
    id: "audienceRating",
    label: "Audience Rating",
    field: "audienceRating",
    group: "content",
    defaultVisible: false,
    defaultWidth: 120,
    render: (item) => (
      <span className="text-muted-foreground">{item.audienceRating?.toFixed(1) ?? "-"}</span>
    ),
  },
  ];
}

const GROUP_LABELS: Record<string, string> = {
  core: "Core",
  video: "Video",
  audio: "Audio",
  file: "File",
  playback: "Playback",
  content: "Content",
};

function getDefaultVisibility(columns: ColumnDef[]): Record<string, boolean> {
  const vis: Record<string, boolean> = {};
  for (const col of columns) {
    vis[col.id] = col.defaultVisible;
  }
  return vis;
}

// The key a table's columns are saved under.
function columnPrefKey(mediaType: string | undefined): string {
  return mediaType === "MUSIC" ? "MUSIC" : mediaType === "SERIES" ? "SERIES" : "MOVIE";
}

// Saved columns are visible, every other column hidden; nothing saved for the
// type keeps the defaults.
function visibilityFromPreferences(
  prefs: Record<string, unknown> | null | undefined,
  prefKey: string,
  columns: ColumnDef[],
): Record<string, boolean> {
  const saved = prefs?.[prefKey];
  if (!Array.isArray(saved)) return getDefaultVisibility(columns);
  const vis: Record<string, boolean> = {};
  for (const col of columns) {
    vis[col.id] = saved.includes(col.id);
  }
  return vis;
}

// Column IDs that are video-specific and should be hidden for MUSIC
const VIDEO_COLUMN_IDS = new Set([
  "resolution",
  "dynamicRange",
  "videoCodec",
  "videoBitDepth",
  "videoFrameRate",
  "videoBitrate",
  "aspectRatio",
]);

function MediaTableInner<T extends MediaListItem>({ items, onItemClick, sortBy, sortOrder, onSort, mediaType, hideParentTitle, scrollToIndexRef, exceptedItemIds, hideServers, rowClassName, renderHoverContent }: MediaTableProps<T>) {
  const allColumns = useMemo(() => buildColumns(), []);
  // Inside the shell the saved columns are the settings store's: the layout
  // seeded it, so the table opens with them (fetched after mount, it drew the
  // default columns first), and a save in another tab or on another device
  // shows here once the store refreshes. Only outside the shell (or when the
  // layout could not read them) are they fetched and saved here.
  const shell = useShellSettings();
  const shellSnapshot = useShellSnapshot();
  const prefKey = columnPrefKey(mediaType);
  const savedColumns = shellSnapshot?.columnPreferences?.[prefKey];
  const shellVisibility = useMemo(
    () => (shell ? visibilityFromPreferences({ [prefKey]: savedColumns }, prefKey, allColumns) : null),
    [shell, savedColumns, prefKey, allColumns],
  );
  const [fetchedVisibility, setColumnVisibility] = useState<Record<string, boolean>>(() =>
    getDefaultVisibility(allColumns),
  );
  const columnVisibility = shellVisibility ?? fetchedVisibility;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Row Virtualization ---
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    // Walk up the DOM to find the nearest scrollable ancestor (overflow-y: auto/scroll)
    let el = tableContainerRef.current?.parentElement ?? null;
    while (el) {
      const style = getComputedStyle(el);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        scrollElementRef.current = el;
        break;
      }
      el = el.parentElement;
    }
    // Fallback to <main> if no scrollable parent found
    if (!scrollElementRef.current) {
      scrollElementRef.current = document.querySelector<HTMLElement>("main");
    }
  }, []);

  const recalcScrollMargin = useCallback(() => {
    const scrollEl = scrollElementRef.current;
    const tableEl = tableContainerRef.current;
    if (scrollEl && tableEl) {
      const margin = Math.round(
        tableEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
      );
      setScrollMargin(margin);
    }
  }, []);

  useLayoutEffect(() => {
    recalcScrollMargin();
  }, [items.length, recalcScrollMargin]);

  // Recalculate scroll margin when scroll container resizes (e.g. side panel opens/closes)
  useEffect(() => {
    const scrollEl = scrollElementRef.current;
    if (!scrollEl) return;
    const observer = new ResizeObserver(() => {
      recalcScrollMargin();
    });
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [recalcScrollMargin]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 41,
    overscan: 15,
    scrollMargin,
  });

  useEffect(() => {
    if (!scrollToIndexRef) return;
    const ref = scrollToIndexRef;
    ref.current = (index: number) => {
      virtualizer.scrollToIndex(index, { align: "start" });
    };
    return () => { ref.current = null; };
  }, [scrollToIndexRef, virtualizer]);

  // Load column preferences from DB on mount, outside the shell
  useEffect(() => {
    if (shell) return;
    let cancelled = false;
    async function loadPreferences() {
      try {
        const res = await fetch("/api/settings/column-preferences");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.preferences?.[prefKey])) {
          setColumnVisibility(visibilityFromPreferences(data.preferences, prefKey, allColumns));
        }
      } catch {
        // Keep defaults if fetch fails
      }
    }
    loadPreferences();
    return () => { cancelled = true; };
  }, [shell, prefKey, allColumns]);

  // Save column preferences to DB (debounced)
  const savePreferences = useCallback((visibility: Record<string, boolean>) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const visibleCols = Object.entries(visibility)
        .filter(([, visible]) => visible)
        .map(([id]) => id);
      try {
        await fetch("/api/settings/column-preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: prefKey, columns: visibleCols }),
        });
      } catch {
        // Silently fail
      }
    }, 500);
  }, [prefKey]);

  const toggleColumn = useCallback((colId: string, checked: boolean) => {
    if (shell && shellVisibility) {
      const next = { ...shellVisibility, [colId]: checked };
      const visibleCols = allColumns.filter((col) => next[col.id]).map((col) => col.id);
      // Shown at once, sent after a short pause against the store's revision;
      // a list another tab or device saved since is loaded in its place.
      void shell.saveColumns(prefKey, visibleCols).then((outcome) => {
        if (outcome === "conflict") {
          toast.error("The column selection was changed in another tab or on another device. The current one has been loaded; make the change again.");
        }
      });
      return;
    }
    setColumnVisibility((prev) => {
      const next = { ...prev, [colId]: checked };
      savePreferences(next);
      return next;
    });
  }, [shell, shellVisibility, allColumns, prefKey, savePreferences]);

  const isMusic = mediaType === "MUSIC";

  // Filter out video columns entirely for music, then apply user visibility
  const availableColumns = allColumns.filter((col) => {
    if (isMusic && VIDEO_COLUMN_IDS.has(col.id)) return false;
    if (hideServers && col.id === "servers") return false;
    return true;
  });

  const visibleColumns = availableColumns.filter((col) => columnVisibility[col.id]);

  const isShowView = items.some((i) => i.parentTitle);
  const isGroupedShowView = items.some((i) => i.matchedEpisodes);

  // Total column count for spacer row colSpan
  const totalColumnCount = 1 + (isShowView && !isGroupedShowView ? 1 : 0)
    + (isGroupedShowView ? 1 : 0) + visibleColumns.length;

  // Build column width configs for the resize hook
  const resizeColumns = useMemo(() => {
    const cols: { id: string; defaultWidth: number }[] = [
      { id: "_title", defaultWidth: 280 },
    ];
    if (isShowView && !isGroupedShowView) {
      cols.push({ id: "_episode", defaultWidth: 80 });
    }
    if (isGroupedShowView) {
      cols.push({ id: "_episodes", defaultWidth: 80 });
    }
    for (const col of visibleColumns) {
      cols.push({ id: col.id, defaultWidth: col.defaultWidth });
    }
    return cols;
  }, [visibleColumns, isShowView, isGroupedShowView]);

  const { columnWidths, totalWidth, getResizeProps } = useColumnResize({
    columns: resizeColumns,
    storageKey: `media-table-widths-${mediaType}`,
  });

  function renderSortHeader(label: string, field: string, columnId: string, sortable = true, key?: string) {
    const width = columnWidths[columnId];
    const resizeProps = getResizeProps(columnId);

    if (!onSort || !sortable) {
      return (
        <TableHead key={key} className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint" style={{ width, position: "relative" }}>
          {label}
          <div
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/50 active:bg-primary z-10 touch-none"
            onMouseDown={resizeProps.onMouseDown}
            onTouchStart={resizeProps.onTouchStart}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={resizeProps.onDoubleClick}
          />
        </TableHead>
      );
    }
    const isActive = sortBy === field;
    return (
      <TableHead
        key={key}
        className="cursor-pointer select-none hover:text-foreground font-mono text-[11px] uppercase tracking-[0.08em] text-faint"
        style={{ width, position: "relative" }}
        aria-sort={isActive ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
        onClick={() => onSort(field)}
      >
        <div className="flex items-center gap-1">
          {label}
          {isActive ? (
            sortOrder === "asc" ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )
          ) : (
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />
          )}
        </div>
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/50 active:bg-primary z-10 touch-none"
          onMouseDown={resizeProps.onMouseDown}
          onTouchStart={resizeProps.onTouchStart}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={resizeProps.onDoubleClick}
        />
      </TableHead>
    );
  }

  // Group columns for the dropdown (use availableColumns to exclude video for music)
  const columnGroups = Object.entries(GROUP_LABELS).map(([key, label]) => ({
    key,
    label,
    columns: availableColumns.filter((col) => col.group === key),
  })).filter((g) => g.columns.length > 0);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border p-12 text-center">
        <p className="text-muted-foreground">No media items found.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Columns3 className="mr-1.5 h-3.5 w-3.5" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 max-w-[calc(100vw-2rem)] max-h-80 overflow-y-auto">
            {columnGroups.map((group, idx) => (
              <React.Fragment key={group.key}>
                {idx > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {group.label}
                </DropdownMenuLabel>
                {group.columns.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={columnVisibility[col.id]}
                    onCheckedChange={(checked) => toggleColumn(col.id, !!checked)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {col.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div ref={tableContainerRef} className="rounded-lg border overflow-x-auto">
        <Table className="table-fixed" style={{ minWidth: totalWidth }}>
          <TableHeader className="sticky top-0 z-10 bg-background [&_tr]:bg-background shadow-[0_1px_0_oklch(1_0_0/5%)]">
            <TableRow>
              {/* Title is always shown */}
              {renderSortHeader("Title", "title", "_title")}
              {/* Episode / Track # column for show views */}
              {isShowView && !isGroupedShowView && renderSortHeader(isMusic ? "Track #" : "Episode", "", "_episode", false)}
              {isGroupedShowView && renderSortHeader("Episodes", "", "_episodes", false)}
              {/* Dynamic columns */}
              {visibleColumns.map((col) =>
                renderSortHeader(col.label, col.field, col.id, col.sortable !== false, col.id)
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(() => {
              const virtualRows = virtualizer.getVirtualItems();
              if (virtualRows.length === 0) return null;

              const scrollMargin = virtualizer.options.scrollMargin ?? 0;
              const paddingTop = virtualRows[0].start - scrollMargin;
              const paddingBottom = virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end;

              return (
                <>
                  {paddingTop > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={totalColumnCount} style={{ height: paddingTop, padding: 0, border: "none" }} />
                    </tr>
                  )}
                  {virtualRows.map((virtualRow) => {
                    const item = items[virtualRow.index];
                    const epLabel = formatEpisodeLabel(item, isMusic);
                    const hoverContent = renderHoverContent?.(item);

                    const titleContent = (
                      <span className="inline-flex items-center gap-1.5">
                        {exceptedItemIds?.has(item.id) && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <ShieldOff className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>Excluded from lifecycle actions</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {hideParentTitle ? (
                          <span>{item.title}</span>
                        ) : item.matchedEpisodes ? (
                          <span>{item.parentTitle ?? item.title}</span>
                        ) : item.parentTitle ? (
                          <>
                            <span>{item.parentTitle}</span>
                            <span className="text-xs text-muted-foreground ml-1.5">— {item.title}</span>
                          </>
                        ) : (
                          <span>{item.title}</span>
                        )}
                      </span>
                    );

                    const tableRow = (
                      <TableRow
                        data-index={virtualRow.index}
                        onClick={() => onItemClick(item)}
                        // A row opens its item — a detail page or the side
                        // panel — and both read the item's record by this id.
                        {...intentHandlers(() => prefetchMediaRecord(item.id))}
                        className={`cursor-pointer transition-colors duration-200 hover:bg-white/3 even:bg-white/1.5 hover:ring-1 hover:ring-primary/20 ${rowClassName?.(item) ?? ""}`}
                      >
                        {/* Title cell - always shown */}
                        <TableCell className="font-medium overflow-hidden text-ellipsis">
                          {titleContent}
                        </TableCell>
                        {/* Episode column */}
                        {isShowView && !isGroupedShowView && (
                          <TableCell className="text-muted-foreground font-mono text-xs">
                            {epLabel ?? "-"}
                          </TableCell>
                        )}
                        {isGroupedShowView && (
                          <TableCell className="text-muted-foreground text-xs">
                            {item.matchedEpisodes ?? "-"}
                          </TableCell>
                        )}
                        {/* Dynamic column cells */}
                        {visibleColumns.map((col) => (
                          <TableCell key={col.id} className={`overflow-hidden ${col.className ?? ""}`}>
                            {col.render(item)}
                          </TableCell>
                        ))}
                      </TableRow>
                    );

                    if (!hoverContent) return <React.Fragment key={item.id}>{tableRow}</React.Fragment>;

                    return (
                      <HoverCard key={item.id} openDelay={400} closeDelay={150}>
                        <HoverCardTrigger asChild>
                          {tableRow}
                        </HoverCardTrigger>
                        <HoverCardContent
                          side="bottom"
                          align="start"
                          sideOffset={4}
                          className="w-72 p-0 duration-200"
                        >
                          {hoverContent}
                        </HoverCardContent>
                      </HoverCard>
                    );
                  })}
                  {paddingBottom > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={totalColumnCount} style={{ height: paddingBottom, padding: 0, border: "none" }} />
                    </tr>
                  )}
                </>
              );
            })()}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// memo() erases the generic call signature, so restore it with a cast — the
// runtime value is the memoised component either way.
export const MediaTable = memo(MediaTableInner) as typeof MediaTableInner;
