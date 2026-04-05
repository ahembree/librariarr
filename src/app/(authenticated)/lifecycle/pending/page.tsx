"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { toast } from "sonner";
import { useVirtualizer } from "@tanstack/react-virtual";
import { usePanelResize } from "@/hooks/use-panel-resize";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ColorChip } from "@/components/color-chip";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Loader2,
  XCircle,
  Play,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  ShieldOff,
  Film,
  Tv,
  Music,
  LayoutGrid,
  TableProperties,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { MediaCard } from "@/components/media-card";
import { useCardSize, estimateContentWidth } from "@/hooks/use-card-size";
import { CardSizeControl } from "@/components/card-size-control";
import { formatDuration, formatFileSize } from "@/lib/format";
import { MetadataLine } from "@/components/metadata-line";
import { TabNav, type TabNavItem } from "@/components/tab-nav";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import type { MediaItemWithRelations } from "@/lib/types";
import { useRealtime } from "@/hooks/use-realtime";

interface ActionItem {
  id: string;
  actionType: string;
  addImportExclusion: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  status: string;
  scheduledFor: string;
  executedAt: string | null;
  error: string | null;
  createdAt: string;
  estimated: boolean;
  mediaItem: {
    id: string | null;
    title: string;
    parentTitle: string | null;
    type: string;
    year?: number | null;
    summary?: string | null;
    contentRating?: string | null;
    rating?: number | null;
    ratingImage?: string | null;
    audienceRating?: number | null;
    audienceRatingImage?: string | null;
    duration?: number | null;
    resolution?: string | null;
    dynamicRange?: string | null;
    audioProfile?: string | null;
    fileSize?: string | null;
    genres?: string[] | null;
    studio?: string | null;
    playCount?: number;
    lastPlayedAt?: string | null;
    addedAt?: string | null;
    servers?: Array<{ serverId: string; serverName: string; serverType: string }>;
  };
}

interface RuleSetGroup {
  ruleSet: {
    id: string;
    name: string;
    type: string;
    actionType: string | null;
    actionDelayDays: number;
    addImportExclusion: boolean;
    searchAfterDelete: boolean;
    addArrTags: string[];
    removeArrTags: string[];
    arrInstanceId: string | null;
    deleted?: boolean;
  };
  items: ActionItem[];
  count: number;
}

const STATUS_FILTERS = ["PENDING", "COMPLETED", "FAILED", "ALL"];

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  COMPLETED: "Completed",
  FAILED: "Failed",
  ALL: "All",
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  COMPLETED: "bg-green-500/20 text-green-400 border-green-500/30",
  FAILED: "bg-red-500/20 text-red-400 border-red-500/30",
};

function formatActionType(type: string): string {
  const map: Record<string, string> = {
    DO_NOTHING: "Monitor Only",
    DELETE_RADARR: "Delete from Radarr",
    DELETE_SONARR: "Delete from Sonarr",
    DELETE_LIDARR: "Delete from Lidarr",
    UNMONITOR_RADARR: "Unmonitor in Radarr",
    UNMONITOR_SONARR: "Unmonitor in Sonarr",
    UNMONITOR_LIDARR: "Unmonitor in Lidarr",
    UNMONITOR_DELETE_FILES_RADARR: "Unmonitor & Delete Files (Radarr)",
    UNMONITOR_DELETE_FILES_SONARR: "Unmonitor & Delete Files (Sonarr)",
    UNMONITOR_DELETE_FILES_LIDARR: "Unmonitor & Delete Files (Lidarr)",
    MONITOR_DELETE_FILES_RADARR: "Monitor & Delete Files (Radarr)",
    MONITOR_DELETE_FILES_SONARR: "Monitor & Delete Files (Sonarr)",
    MONITOR_DELETE_FILES_LIDARR: "Monitor & Delete Files (Lidarr)",
    DELETE_FILES_RADARR: "Delete Files Only (Radarr)",
    DELETE_FILES_SONARR: "Delete Files Only (Sonarr)",
    DELETE_FILES_LIDARR: "Delete Files Only (Lidarr)",
  };
  return map[type] ?? type;
}

/* ---------- Virtualized action table for a single group ---------- */

function VirtualizedActionTable({
  items,
  ruleSetId,
  isPending,
  executingItems,
  retryingItems,
  excludingItems,
  exceptedItemIds,
  onExecuteItem,
  onRemoveAction,
  onRetryAction,
  onExclude,
  onItemClick,
  isDeletedRuleSet,
}: {
  items: ActionItem[];
  ruleSetId: string;
  isPending: boolean;
  executingItems: Set<string>;
  retryingItems: Set<string>;
  excludingItems: Set<string>;
  exceptedItemIds: Set<string>;
  onExecuteItem: (ruleSetId: string, mediaItemId: string) => void;
  onRemoveAction: (id: string) => void;
  onRetryAction: (action: ActionItem) => void;
  onExclude: (action: ActionItem) => void;
  onItemClick: (action: ActionItem) => void;
  isDeletedRuleSet?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 10,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0;

  return (
    <div className="rounded-lg border">
      <div ref={scrollRef} className="md:max-h-[60vh] overflow-auto">
        <table className="w-full caption-bottom text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b bg-muted/50">
              <th className="h-10 px-4 text-left align-middle font-display text-xs uppercase tracking-wider text-muted-foreground">Title</th>
              <th className="h-10 px-4 text-left align-middle font-display text-xs uppercase tracking-wider text-muted-foreground">Action</th>
              <th className="h-10 px-4 text-left align-middle font-display text-xs uppercase tracking-wider text-muted-foreground">{isPending ? "Scheduled" : "Date"}</th>
              <th className="h-10 px-4 text-left align-middle font-display text-xs uppercase tracking-wider text-muted-foreground">Status</th>
              {isPending && <th className="h-10 px-4 w-30 text-left align-middle font-display text-xs uppercase tracking-wider text-muted-foreground" />}
              {!isPending && items.some((a) => a.status === "FAILED") && (
                <th className="h-10 px-4 w-12 text-left align-middle font-display text-xs uppercase tracking-wider text-muted-foreground" />
              )}
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {paddingTop > 0 && (
              <tr aria-hidden="true"><td style={{ height: paddingTop }} /></tr>
            )}
            {virtualRows.map((virtualRow) => {
              const action = items[virtualRow.index];
              const hasMediaItem = action.mediaItem.id !== null;
              const itemKey = hasMediaItem ? `${ruleSetId}:${action.mediaItem.id}` : "";
              const isItemExecuting = hasMediaItem && executingItems.has(itemKey);

              const tableRow = (
                <tr
                  key={action.id}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className={`transition-colors duration-200 even:bg-white/1.5 ${hasMediaItem ? "hover:bg-white/3 hover:ring-1 hover:ring-primary/20 cursor-pointer" : ""}`}
                  onClick={hasMediaItem ? () => onItemClick(action) : undefined}
                >
                  <td className="p-4 align-middle">
                    <div>
                      <p className="font-medium inline-flex items-center gap-1.5">
                        {hasMediaItem && exceptedItemIds.has(action.mediaItem.id!) && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <ShieldOff className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>Excluded from lifecycle actions</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {action.mediaItem.title}
                      </p>
                      {action.mediaItem.parentTitle && (
                        <p className="text-xs text-muted-foreground">
                          {action.mediaItem.parentTitle}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="p-4 align-middle">
                    <div className="space-y-1">
                      <p className="text-sm">
                        {formatActionType(action.actionType)}
                      </p>
                      {action.addImportExclusion && (
                        <Badge variant="outline" className="text-[10px]">
                          + List exclusion
                        </Badge>
                      )}
                      {action.addArrTags?.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {action.addArrTags.map((tag) => (
                            <ColorChip
                              key={tag}
                              className="bg-green-500/20 text-green-400 border-green-500/30"
                            >
                              +{tag}
                            </ColorChip>
                          ))}
                        </div>
                      )}
                      {action.removeArrTags?.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {action.removeArrTags.map((tag) => (
                            <ColorChip
                              key={tag}
                              className="bg-red-500/20 text-red-400 border-red-500/30"
                            >
                              -{tag}
                            </ColorChip>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="p-4 align-middle text-sm">
                    {new Date(action.executedAt ?? action.scheduledFor).toLocaleDateString()}
                    <br />
                    <span className="text-xs text-muted-foreground">
                      {new Date(action.executedAt ?? action.scheduledFor).toLocaleTimeString()}
                    </span>
                    {action.estimated && (
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                        (estimated)
                      </p>
                    )}
                  </td>
                  <td className="p-4 align-middle">
                    <ColorChip
                      className={STATUS_COLORS[action.status] || "bg-muted text-muted-foreground"}
                    >
                      {STATUS_LABELS[action.status] ?? action.status}
                    </ColorChip>
                    {action.error && (
                      <div className="mt-1 max-w-64">
                        <p
                          className={`text-xs text-red-400 ${expandedErrors.has(action.id) ? "whitespace-pre-wrap wrap-break-word" : "truncate"}`}
                        >
                          {action.error}
                        </p>
                        {action.error.length > 40 && (
                          <button
                            className="text-[10px] text-muted-foreground hover:text-foreground mt-0.5"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedErrors((prev) => {
                                const next = new Set(prev);
                                if (next.has(action.id)) {
                                  next.delete(action.id);
                                } else {
                                  next.add(action.id);
                                }
                                return next;
                              });
                            }}
                          >
                            {expandedErrors.has(action.id) ? "Show less" : "Show more"}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  {isPending && (
                    <td className="p-4 align-middle">
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => hasMediaItem && onExecuteItem(ruleSetId, action.mediaItem.id!)}
                          disabled={isItemExecuting || !hasMediaItem}
                          title="Execute now"
                        >
                          {isItemExecuting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onExclude(action)}
                          disabled={!hasMediaItem || excludingItems.has(action.mediaItem.id!)}
                          title="Exclude from lifecycle actions"
                        >
                          {hasMediaItem && excludingItems.has(action.mediaItem.id!) ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ShieldOff className="h-4 w-4 text-orange-400" />
                          )}
                        </Button>
                      </div>
                    </td>
                  )}
                  {!isPending && !action.estimated && action.status === "FAILED" && (
                    <td className="p-4 align-middle">
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {action.status === "FAILED" && !isDeletedRuleSet && hasMediaItem && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onRetryAction(action)}
                            disabled={retryingItems.has(action.id)}
                            title="Force retry"
                          >
                            {retryingItems.has(action.id) ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4 text-yellow-500" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onRemoveAction(action.id)}
                          title="Remove from list"
                        >
                          <XCircle className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              );

              if (!hasMediaItem) return tableRow;

              return (
                <HoverCard key={action.id} openDelay={400} closeDelay={150}>
                  <HoverCardTrigger asChild>
                    {tableRow}
                  </HoverCardTrigger>
                  <HoverCardContent side="bottom" align="start" sideOffset={4} className="w-72 p-0 duration-200">
                    <MediaHoverPopover
                      imageUrl={`/api/media/${action.mediaItem.id}/image${action.mediaItem.type !== "MOVIE" ? "?type=parent" : ""}`}
                      imageAspect={action.mediaItem.type === "MUSIC" ? "square" : "poster"}
                      data={{
                        title: action.mediaItem.parentTitle
                          ? `${action.mediaItem.parentTitle} — ${action.mediaItem.title}`
                          : action.mediaItem.title,
                        year: action.mediaItem.year,
                        summary: action.mediaItem.summary,
                        contentRating: action.mediaItem.contentRating,
                        rating: action.mediaItem.rating,
                        audienceRating: action.mediaItem.audienceRating,
                        ratingImage: action.mediaItem.ratingImage,
                        audienceRatingImage: action.mediaItem.audienceRatingImage,
                        duration: action.mediaItem.duration,
                        resolution: action.mediaItem.resolution,
                        dynamicRange: action.mediaItem.dynamicRange,
                        audioProfile: action.mediaItem.audioProfile,
                        fileSize: action.mediaItem.fileSize,
                        genres: action.mediaItem.genres,
                        studio: action.mediaItem.studio,
                        playCount: action.mediaItem.playCount,
                        lastPlayedAt: action.mediaItem.lastPlayedAt,
                        addedAt: action.mediaItem.addedAt,
                        servers: action.mediaItem.servers,
                      }}
                    />
                  </HoverCardContent>
                </HoverCard>
              );
            })}
            {paddingBottom > 0 && (
              <tr aria-hidden="true"><td style={{ height: paddingBottom }} /></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- Card grid for a single group ---------- */

const CARD_GAP = 16;
const CARD_CONTENT_HEIGHT = 128;

function PendingActionCardGrid({
  items,
  ruleSetType,
  onItemClick,
  exceptedItemIds,
}: {
  items: ActionItem[];
  ruleSetType: string;
  onItemClick: (action: ActionItem) => void;
  exceptedItemIds: Set<string>;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { columns: actualColumns } = useCardSize();
  const isMusic = ruleSetType === "MUSIC";
  const isMovie = ruleSetType === "MOVIE";
  const fallbackIcon = isMovie ? "movie" as const : isMusic ? "music" as const : "series" as const;
  const aspectRatio = isMusic ? "square" as const : "poster" as const;

  const filteredItems = useMemo(
    () => items.filter((a) => a.mediaItem.id !== null),
    [items],
  );

  const rowCount = useMemo(
    () => (filteredItems.length > 0 ? Math.ceil(filteredItems.length / actualColumns) : 0),
    [filteredItems.length, actualColumns],
  );

  const estimateSize = useCallback(() => {
    const container = scrollContainerRef.current;
    const containerWidth = container?.offsetWidth || estimateContentWidth(window.innerWidth);
    const columnWidth = (containerWidth - CARD_GAP * (actualColumns - 1)) / actualColumns;
    const posterHeight = columnWidth * (isMusic ? 1 : 1.5);
    return Math.round(posterHeight + CARD_CONTENT_HEIGHT + CARD_GAP);
  }, [actualColumns, isMusic]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize,
    overscan: 5,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [actualColumns, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div ref={scrollContainerRef} className="md:max-h-[60vh] overflow-y-auto">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualRows.map((virtualRow) => {
          const rowStart = virtualRow.index * actualColumns;
          const rowItems = filteredItems.slice(rowStart, rowStart + actualColumns);
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                paddingBottom: CARD_GAP,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gap: `${CARD_GAP}px`,
                  gridTemplateColumns: `repeat(${actualColumns}, minmax(0, 1fr))`,
                }}
              >
                {rowItems.map((action) => {
                  const mi = action.mediaItem;
                  return (
                    <div key={action.id} className="relative">
                      {exceptedItemIds.has(mi.id!) && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="absolute top-2 left-2 z-20 h-6 w-6 rounded-md bg-orange-500/90 backdrop-blur-sm flex items-center justify-center">
                                <ShieldOff className="h-3.5 w-3.5 text-white" />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>Excluded from lifecycle actions</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      <MediaCard
                        imageUrl={`/api/media/${mi.id}/image${!isMovie ? "?type=parent" : ""}`}
                        title={mi.parentTitle ? `${mi.parentTitle} — ${mi.title}` : mi.title}
                        fallbackIcon={fallbackIcon}
                        aspectRatio={aspectRatio}
                        onClick={() => onItemClick(action)}
                        hoverContent={
                          <MediaHoverPopover
                            imageAspect={aspectRatio}
                            data={{
                              title: mi.parentTitle ? `${mi.parentTitle} — ${mi.title}` : mi.title,
                              year: mi.year,
                              summary: mi.summary,
                              contentRating: mi.contentRating,
                              rating: mi.rating,
                              audienceRating: mi.audienceRating,
                              ratingImage: mi.ratingImage,
                              audienceRatingImage: mi.audienceRatingImage,
                              duration: mi.duration,
                              resolution: mi.resolution,
                              dynamicRange: mi.dynamicRange,
                              audioProfile: mi.audioProfile,
                              fileSize: mi.fileSize,
                              genres: mi.genres,
                              studio: mi.studio,
                              playCount: mi.playCount,
                              lastPlayedAt: mi.lastPlayedAt,
                              addedAt: mi.addedAt,
                              servers: mi.servers,
                            }}
                          />
                        }
                        metadata={
                          <MetadataLine>
                            {mi.year && <span>{mi.year}</span>}
                            {formatDuration(mi.duration ?? null) && <span>{formatDuration(mi.duration ?? null)}</span>}
                            {formatFileSize(mi.fileSize ?? null) && <span>{formatFileSize(mi.fileSize ?? null)}</span>}
                          </MetadataLine>
                        }
                        badges={
                          <ColorChip className={STATUS_COLORS[action.status] || "bg-muted text-muted-foreground"}>
                            {STATUS_LABELS[action.status] ?? action.status}
                          </ColorChip>
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Main page ---------- */

type MediaTypeTab = "all" | "movies" | "series" | "music";

const MEDIA_TYPE_TABS: TabNavItem<MediaTypeTab>[] = [
  { value: "all", label: "All" },
  { value: "movies", label: "Movies", icon: Film },
  { value: "series", label: "Series", icon: Tv },
  { value: "music", label: "Music", icon: Music },
];

const TAB_TO_TYPE: Record<MediaTypeTab, string | null> = {
  all: null,
  movies: "MOVIE",
  series: "SERIES",
  music: "MUSIC",
};

export default function PendingActionsPage() {
  const [mediaTypeTab, setMediaTypeTab] = useState<MediaTypeTab>("all");
  const [groups, setGroups] = useState<RuleSetGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const { size: cardSize, setSize: setCardSize } = useCardSize();
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  const [executingRules, setExecutingRules] = useState<Set<string>>(new Set());
  const [executingItems, setExecutingItems] = useState<Set<string>>(new Set());
  const [executeResults, setExecuteResults] = useState<Record<string, { executed: number; failed: number; errors: string[] }>>({});
  const [confirmExecuteRuleSetId, setConfirmExecuteRuleSetId] = useState<string | null>(null);

  // Media detail panel state
  const [selectedItem, setSelectedItem] = useState<MediaItemWithRelations | null>(null);
  const [selectedItemType, setSelectedItemType] = useState<"MOVIE" | "SERIES" | "MUSIC">("MOVIE");
  const [, setLoadingDetail] = useState(false);
  const { width: panelWidth, resizeHandleProps } = usePanelResize({
    storageKey: "lifecycle-pending-panel-width",
    defaultWidth: 480,
    minWidth: 360,
    maxWidth: 800,
  });

  // Deletion stats
  const [deletionStats, setDeletionStats] = useState<{
    totalBytesDeleted: string;
    actionCount: number;
    pendingBytes: string;
    pendingCount: number;
    byRuleSet: Array<{
      ruleSetId: string | null;
      ruleSetName: string;
      ruleSetType: string | null;
      deleted: boolean;
      deletedBytes: string;
      deletedCount: number;
      pendingBytes: string;
      pendingCount: number;
    }>;
    resetAt: string | null;
  } | null>(null);
  const [resettingStats, setResettingStats] = useState(false);
  const [confirmResetStats, setConfirmResetStats] = useState(false);

  const fetchDeletionStats = useCallback(async () => {
    try {
      const response = await fetch("/api/lifecycle/stats");
      if (response.ok) {
        const data = await response.json();
        setDeletionStats(data);
      }
    } catch {
      // Non-critical — don't block the page
    }
  }, []);

  useEffect(() => {
    fetchDeletionStats();
  }, [fetchDeletionStats]);

  // Refresh stats when actions are executed or detection runs (pending changes)
  useRealtime("lifecycle:action-executed", fetchDeletionStats);
  useRealtime("lifecycle:detection-completed", fetchDeletionStats);

  const handleResetStats = async () => {
    setResettingStats(true);
    try {
      const response = await fetch("/api/lifecycle/stats/reset", { method: "POST" });
      if (response.ok) {
        const data = await response.json();
        setDeletionStats(data);
        toast.success("Deletion stats reset");
      } else {
        toast.error("Failed to reset stats");
      }
    } catch {
      toast.error("Failed to reset stats");
    } finally {
      setResettingStats(false);
      setConfirmResetStats(false);
    }
  };

  const filteredGroups = useMemo(() => {
    const typeFilter = TAB_TO_TYPE[mediaTypeTab];
    if (!typeFilter) return groups;
    return groups.filter((g) => g.ruleSet.type === typeFilter);
  }, [groups, mediaTypeTab]);

  // Per-rule-set stats lookup
  const ruleSetStatsMap = useMemo(() => {
    const map = new Map<string, { deletedBytes: string; deletedCount: number; pendingBytes: string; pendingCount: number }>();
    if (!deletionStats?.byRuleSet) return map;
    for (const rs of deletionStats.byRuleSet) {
      if (rs.ruleSetId) {
        map.set(rs.ruleSetId, rs);
      }
    }
    return map;
  }, [deletionStats?.byRuleSet]);

  const fetchActions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: statusFilter });
      const response = await fetch(`/api/lifecycle/actions?${params}`);
      const data = await response.json();
      setGroups(data.groups || []);
    } catch (error) {
      console.error("Failed to fetch actions:", error);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useRealtime("lifecycle:action-executed", fetchActions);

  useEffect(() => {
    fetchActions();
  }, [fetchActions]);

  const toggleExpand = (ruleSetId: string) => {
    setExpandedRules((prev) => {
      const next = new Set(prev);
      if (next.has(ruleSetId)) {
        next.delete(ruleSetId);
      } else {
        next.add(ruleSetId);
      }
      return next;
    });
  };

  const removeAction = async (id: string) => {
    try {
      await fetch(`/api/lifecycle/actions/${id}`, { method: "DELETE" });
      await fetchActions();
    } catch (error) {
      console.error("Failed to remove action:", error);
    }
  };

  const [confirmRetryAction, setConfirmRetryAction] = useState<ActionItem | null>(null);
  const [retrySkipTitle, setRetrySkipTitle] = useState(false);

  const retryAction = async (action: ActionItem) => {
    // If it's a title mismatch error, show confirmation dialog with skip option
    setConfirmRetryAction(action);
    setRetrySkipTitle(false);
  };

  const executeRetry = async () => {
    const action = confirmRetryAction;
    if (!action) return;
    setConfirmRetryAction(null);

    setRetryingItems((prev) => new Set(prev).add(action.id));
    try {
      const params = retrySkipTitle ? "?skipTitleValidation=true" : "";
      await fetch(`/api/lifecycle/actions/${action.id}${params}`, { method: "POST" });
      await fetchActions();
    } catch (error) {
      console.error("Failed to retry action:", error);
    } finally {
      setRetryingItems((prev) => {
        const next = new Set(prev);
        next.delete(action.id);
        return next;
      });
    }
  };

  const executeAll = async (ruleSetId: string) => {
    setConfirmExecuteRuleSetId(null);
    setExecutingRules((prev) => new Set(prev).add(ruleSetId));
    setExecuteResults((prev) => {
      const next = { ...prev };
      delete next[ruleSetId];
      return next;
    });
    try {
      const response = await fetch("/api/lifecycle/actions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleSetId }),
      });
      const data = await response.json();
      if (response.ok) {
        setExecuteResults((prev) => ({
          ...prev,
          [ruleSetId]: { executed: data.executed, failed: data.failed, errors: data.errors || [] },
        }));
        if (data.failed > 0 && data.errors?.length > 0) {
          toast.error(`${data.failed} action${data.failed !== 1 ? "s" : ""} failed`, {
            description: data.errors.join("\n"),
          });
        }
      } else {
        setExecuteResults((prev) => ({
          ...prev,
          [ruleSetId]: { executed: 0, failed: 0, errors: [data.error || "Unknown error"] },
        }));
        toast.error(data.error || "Failed to execute actions");
      }
      await fetchActions();
    } catch (error) {
      setExecuteResults((prev) => ({
        ...prev,
        [ruleSetId]: { executed: 0, failed: 0, errors: [String(error)] },
      }));
    } finally {
      setExecutingRules((prev) => {
        const next = new Set(prev);
        next.delete(ruleSetId);
        return next;
      });
    }
  };

  const executeItem = async (ruleSetId: string, mediaItemId: string) => {
    const key = `${ruleSetId}:${mediaItemId}`;
    setExecutingItems((prev) => new Set(prev).add(key));
    try {
      const response = await fetch("/api/lifecycle/actions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleSetId, mediaItemIds: [mediaItemId] }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error || "Failed to execute action");
      } else if (data.failed > 0 && data.errors?.length > 0) {
        toast.error("Action failed", {
          description: data.errors.join("\n"),
        });
      }
      await fetchActions();
    } catch (error) {
      console.error("Failed to execute item:", error);
    } finally {
      setExecutingItems((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  // Track which items have lifecycle exceptions
  const [exceptedItemIds, setExceptedItemIds] = useState<Set<string>>(new Set());

  const fetchExceptions = useCallback(async () => {
    try {
      const response = await fetch("/api/lifecycle/exceptions");
      if (response.ok) {
        const data = await response.json();
        setExceptedItemIds(new Set((data.exceptions || []).map((e: { mediaItem: { id: string } }) => e.mediaItem.id)));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchExceptions();
  }, [fetchExceptions]);

  const [retryingItems, setRetryingItems] = useState<Set<string>>(new Set());
  const [excludingItems, setExcludingItems] = useState<Set<string>>(new Set());
  const [excludePromptAction, setExcludePromptAction] = useState<ActionItem | null>(null);
  const [excludeReason, setExcludeReason] = useState("");

  const confirmExclude = async (action: ActionItem, reason: string) => {
    if (!action.mediaItem.id) return;
    const mediaItemId = action.mediaItem.id;
    setExcludingItems((prev) => new Set(prev).add(mediaItemId));
    try {
      const response = await fetch("/api/lifecycle/exceptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaItemId, reason: reason || undefined }),
      });
      if (response.ok) {
        setExceptedItemIds((prev) => new Set(prev).add(mediaItemId));
        await fetchActions();
      }
    } catch (error) {
      console.error("Failed to exclude item:", error);
    } finally {
      setExcludingItems((prev) => {
        const next = new Set(prev);
        next.delete(mediaItemId);
        return next;
      });
    }
  };

  const excludeItem = (action: ActionItem) => {
    setExcludeReason("");
    setExcludePromptAction(action);
  };

  const openDetailPanel = async (action: ActionItem) => {
    const mediaType = action.mediaItem.type as "MOVIE" | "SERIES" | "MUSIC";
    setSelectedItemType(mediaType);
    if (!action.mediaItem.id) return;
    setLoadingDetail(true);
    try {
      const response = await fetch(`/api/media/${action.mediaItem.id}`);
      if (response.ok) {
        const data = await response.json();
        setSelectedItem(data.item ?? data);
      }
    } catch (error) {
      console.error("Failed to fetch media item:", error);
    } finally {
      setLoadingDetail(false);
    }
  };

  const isPending = statusFilter === "PENDING";

  return (
    <>
      <div className="p-4 sm:p-6 lg:p-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Pending Actions</h1>
          <p className="text-muted-foreground mt-1">Scheduled lifecycle actions awaiting execution, grouped by rule set.</p>
        </div>

        {/* Deletion stats banner */}
        {deletionStats && (deletionStats.actionCount > 0 || deletionStats.pendingCount > 0 || deletionStats.resetAt) && (
          <div className="flex items-center gap-4 mb-6 rounded-lg border bg-muted/30 px-4 py-3">
            <Trash2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-4 text-sm flex-wrap">
              {deletionStats.pendingCount > 0 && (
                <>
                  <span>
                    <span className="font-medium text-amber-400">{formatFileSize(deletionStats.pendingBytes)}</span>
                    <span className="text-muted-foreground ml-1">pending</span>
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span>
                    <span className="font-medium text-amber-400">{deletionStats.pendingCount}</span>
                    <span className="text-muted-foreground ml-1">{deletionStats.pendingCount === 1 ? "action" : "actions"} queued</span>
                  </span>
                </>
              )}
              {deletionStats.pendingCount > 0 && deletionStats.actionCount > 0 && (
                <span className="text-muted-foreground">|</span>
              )}
              {deletionStats.actionCount > 0 && (
                <>
                  <span>
                    <span className="font-medium">{formatFileSize(deletionStats.totalBytesDeleted)}</span>
                    <span className="text-muted-foreground ml-1">deleted</span>
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span>
                    <span className="font-medium">{deletionStats.actionCount}</span>
                    <span className="text-muted-foreground ml-1">{deletionStats.actionCount === 1 ? "action" : "actions"} completed</span>
                  </span>
                </>
              )}
              {deletionStats.resetAt && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">
                    since {new Date(deletionStats.resetAt).toLocaleDateString()}
                  </span>
                </>
              )}
            </div>
            <div className="ml-auto">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => { e.stopPropagation(); setConfirmResetStats(true); }}
                      disabled={resettingStats}
                    >
                      <RotateCcw className={`h-3.5 w-3.5 ${resettingStats ? "animate-spin" : ""}`} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reset deletion stats</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        )}

        <TabNav tabs={MEDIA_TYPE_TABS} activeTab={mediaTypeTab} onTabChange={setMediaTypeTab} className="mb-6" />

        {/* Status filter + view toggle */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2">
            {STATUS_FILTERS.map((status) => (
              <Button
                key={status}
                variant={statusFilter === status ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter(status)}
              >
                {STATUS_LABELS[status] ?? status}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {viewMode === "cards" && <CardSizeControl size={cardSize} onChange={setCardSize} />}
            <div className="flex rounded-md border">
              <Button variant={viewMode === "table" ? "secondary" : "ghost"} size="icon" className="h-8 w-8 rounded-r-none" onClick={() => setViewMode("table")}><TableProperties className="h-4 w-4" /></Button>
              <Button variant={viewMode === "cards" ? "secondary" : "ghost"} size="icon" className="h-8 w-8 rounded-l-none" onClick={() => setViewMode("cards")}><LayoutGrid className="h-4 w-4" /></Button>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredGroups.length === 0 ? (
          <p className="text-center py-12 text-muted-foreground">
            No {(STATUS_LABELS[statusFilter] ?? statusFilter).toLowerCase()} actions found.
          </p>
        ) : (
          <div className="space-y-4">
            {filteredGroups.map((group) => {
              const isExpanded = expandedRules.has(group.ruleSet.id);
              const isExecuting = executingRules.has(group.ruleSet.id);
              const result = executeResults[group.ruleSet.id];

              return (
                <Card key={group.ruleSet.id}>
                  <CardHeader
                    className="cursor-pointer"
                    onClick={() => toggleExpand(group.ruleSet.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {isExpanded ? (
                          <ChevronDown className="h-5 w-5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-5 w-5 text-muted-foreground" />
                        )}
                        <div>
                          <CardTitle className="text-lg">
                            {group.ruleSet.name}
                            {group.ruleSet.deleted && (
                              <span className="ml-2 text-sm font-normal text-muted-foreground">(Deleted)</span>
                            )}
                          </CardTitle>
                          <div className="flex items-center gap-2 mt-1">
                            <ColorChip className="border-border text-muted-foreground">
                              {group.ruleSet.type === "MOVIE" ? "Movie" : group.ruleSet.type === "MUSIC" ? "Music" : "Series"}
                            </ColorChip>
                            <Badge variant="secondary">
                              {group.count} item{group.count !== 1 && "s"}
                            </Badge>
                            {group.ruleSet.actionType && (
                              <span className="text-xs text-muted-foreground">
                                Action: {formatActionType(group.ruleSet.actionType)}
                              </span>
                            )}
                            {(group.ruleSet.addArrTags?.length > 0 || group.ruleSet.removeArrTags?.length > 0) && (
                              <div className="flex flex-wrap gap-1">
                                {group.ruleSet.addArrTags?.map((tag) => (
                                  <ColorChip
                                    key={`add-${tag}`}
                                    className="bg-green-500/20 text-green-400 border-green-500/30"
                                  >
                                    +{tag}
                                  </ColorChip>
                                ))}
                                {group.ruleSet.removeArrTags?.map((tag) => (
                                  <ColorChip
                                    key={`rm-${tag}`}
                                    className="bg-red-500/20 text-red-400 border-red-500/30"
                                  >
                                    -{tag}
                                  </ColorChip>
                                ))}
                              </div>
                            )}
                            {/* Per-rule deletion stats */}
                            {(() => {
                              const rs = ruleSetStatsMap.get(group.ruleSet.id);
                              if (!rs || (rs.deletedCount === 0 && rs.pendingCount === 0)) return null;
                              return (
                                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                  {rs.pendingCount > 0 && (
                                    <span>
                                      <span className="text-amber-400">{formatFileSize(rs.pendingBytes)}</span> pending
                                    </span>
                                  )}
                                  {rs.deletedCount > 0 && (
                                    <span>
                                      {formatFileSize(rs.deletedBytes)} deleted ({rs.deletedCount})
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      </div>

                      {/* Execute All button (only for PENDING filter, not for deleted rule sets) */}
                      {isPending && group.count > 0 && !group.ruleSet.deleted && (
                        <div
                          className="flex items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {result && (
                            <span className="text-xs">
                              {result.failed === 0 ? (
                                <span className="text-green-500 flex items-center gap-1">
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  {result.executed} executed
                                </span>
                              ) : (
                                <span className="text-yellow-500 flex items-center gap-1">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  {result.executed} ok, {result.failed} failed
                                </span>
                              )}
                            </span>
                          )}
                          <Button
                            size="sm"
                            variant="default"
                            onClick={() => setConfirmExecuteRuleSetId(group.ruleSet.id)}
                            disabled={isExecuting}
                          >
                            {isExecuting ? (
                              <Loader2 className="h-4 w-4 animate-spin mr-1" />
                            ) : (
                              <Play className="h-4 w-4 mr-1" />
                            )}
                            {isExecuting ? "Executing..." : "Execute All"}
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardHeader>

                  {isExpanded && group.items.length > 0 && (
                    <CardContent>
                      {viewMode === "table" ? (
                        <VirtualizedActionTable
                          items={group.items}
                          ruleSetId={group.ruleSet.id}
                          isPending={isPending}
                          executingItems={executingItems}
                          retryingItems={retryingItems}
                          excludingItems={excludingItems}
                          exceptedItemIds={exceptedItemIds}
                          onExecuteItem={executeItem}
                          onRemoveAction={removeAction}
                          onRetryAction={(action) => retryAction(action)}
                          onExclude={excludeItem}
                          onItemClick={openDetailPanel}
                          isDeletedRuleSet={group.ruleSet.deleted}
                        />
                      ) : (
                        <PendingActionCardGrid
                          items={group.items}
                          ruleSetType={group.ruleSet.type}
                          onItemClick={openDetailPanel}
                          exceptedItemIds={exceptedItemIds}
                        />
                      )}
                    </CardContent>
                  )}

                  {isExpanded && group.items.length === 0 && (
                    <CardContent>
                      <p className="text-center text-muted-foreground py-4">
                        No items in this group.
                      </p>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {/* Execute All confirmation dialog */}
        <AlertDialog
          open={!!confirmExecuteRuleSetId}
          onOpenChange={(open) => { if (!open) setConfirmExecuteRuleSetId(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Execute All Actions</AlertDialogTitle>
              <AlertDialogDescription>
                {(() => {
                  const group = groups.find((g) => g.ruleSet.id === confirmExecuteRuleSetId);
                  if (!group) return "Are you sure?";
                  return `This will immediately execute ${formatActionType(group.ruleSet.actionType ?? "DO_NOTHING")} on ${group.count} item${group.count !== 1 ? "s" : ""} for "${group.ruleSet.name}". This action cannot be undone.`;
                })()}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirmExecuteRuleSetId) executeAll(confirmExecuteRuleSetId);
                }}
              >
                Execute
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Reset deletion stats confirmation */}
        <AlertDialog open={confirmResetStats} onOpenChange={setConfirmResetStats}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset Deletion Stats</AlertDialogTitle>
              <AlertDialogDescription>
                This will reset the deletion stats counter. Historical action records will not be affected — only the stats display will start counting from now.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleResetStats} disabled={resettingStats}>
                {resettingStats ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Reset
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Force retry confirmation dialog */}
        <AlertDialog
          open={!!confirmRetryAction}
          onOpenChange={(open) => { if (!open) setConfirmRetryAction(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Force Retry Action</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <p>
                    Retry {formatActionType(confirmRetryAction?.actionType ?? "")} for &quot;{confirmRetryAction?.mediaItem.title}&quot;?
                  </p>
                  {confirmRetryAction?.error?.includes("title mismatch") && (() => {
                    const arrTitleMatch = confirmRetryAction.error?.match(/Arr returned "([^"]+)"/);
                    return (
                      <div className="space-y-2">
                        {arrTitleMatch && (
                          <p className="text-sm text-yellow-500">
                            Arr title: &quot;{arrTitleMatch[1]}&quot;
                          </p>
                        )}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={retrySkipTitle}
                            onCheckedChange={(checked) => setRetrySkipTitle(checked === true)}
                          />
                          <span className="text-sm">Skip title validation check</span>
                        </label>
                      </div>
                    );
                  })()}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={executeRetry}>
                Retry
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {selectedItem && (
        <MediaDetailSidePanel
          item={selectedItem}
          mediaType={selectedItemType}
          onClose={() => setSelectedItem(null)}
          width={panelWidth}
          resizeHandleProps={resizeHandleProps}
        />
      )}

      {/* Exclude reason prompt */}
      <Dialog open={!!excludePromptAction} onOpenChange={(open) => { if (!open) setExcludePromptAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Exclude from lifecycle actions</DialogTitle>
            <DialogDescription>
              &quot;{excludePromptAction?.mediaItem.parentTitle
                ? `${excludePromptAction.mediaItem.parentTitle} — ${excludePromptAction.mediaItem.title}`
                : excludePromptAction?.mediaItem.title}&quot; will be excluded from all lifecycle rules. Optionally provide a reason.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Reason (optional)"
            value={excludeReason}
            onChange={(e) => setExcludeReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && excludePromptAction) {
                setExcludePromptAction(null);
                confirmExclude(excludePromptAction, excludeReason);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setExcludePromptAction(null)}>
              Cancel
            </Button>
            <Button onClick={() => {
              if (excludePromptAction) {
                setExcludePromptAction(null);
                confirmExclude(excludePromptAction, excludeReason);
              }
            }}>
              Exclude
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
