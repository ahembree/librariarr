"use client";

import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { toast } from "sonner";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMediaDetailPanel } from "@/hooks/use-media-detail-panel";
import { groupOfRow, toDetailPanelMediaType } from "@/lib/media/detail-panel-item";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { EmptyState } from "@/components/empty-state";
import { IntegrationUnreachableBanner } from "@/components/integration-unreachable-banner";
import { useIntegrationsHealth } from "@/hooks/use-integrations-health";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  LayoutGrid,
  Loader2,
  Play,
  RotateCcw,
  ShieldOff,
  TableProperties,
  Trash2,
  XCircle,
} from "lucide-react";
import { MediaCard } from "@/components/media-card";
import { useChipColors } from "@/components/chip-color-provider";
import { type ChipColorCategory } from "@/lib/theme/chip-colors";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { useCardSize } from "@/hooks/use-card-size";
import { CardSizeControl } from "@/components/card-size-control";
import { formatDuration, formatFileSize } from "@/lib/format";
import { formatActionTypeLabel } from "@/lib/lifecycle/action-types";
import { MetadataLine } from "@/components/metadata-line";
import { TabNav } from "@/components/tab-nav";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MediaHoverPopover, hoverDataFromListItem } from "@/components/media-hover-popover";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { PageHeader } from "@/components/page-header";
import { LoadingButton } from "@/components/loading-button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ExcludeReasonDialog } from "@/components/exclude-reason-dialog";
import { RuleSetGroupCard, LIFECYCLE_MEDIA_TYPE_TABS } from "@/components/rule-set-group-card";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import { useVirtualPosterGrid, POSTER_ASPECT, SQUARE_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT } from "@/hooks/use-library-grid";
import { useRuleSetTypeFilter } from "@/hooks/use-rule-set-type-filter";
import { useLifecycleExceptions } from "@/hooks/use-lifecycle-exceptions";
import { useRealtimeRefetch } from "@/hooks/use-realtime-refetch";
import { useSetState } from "@/hooks/use-set-state";

interface ActionItem {
  id: string;
  actionType: string;
  addImportExclusion: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  targetQualityProfileId: number | null;
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
    audioCodec?: string | null;
    fileSize?: string | null;
    genres?: string[] | null;
    studio?: string | null;
    playCount?: number;
    lastPlayedAt?: string | null;
    addedAt?: string | null;
    matchedEpisodes?: number | null;
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
    searchAfterAction: boolean;
    addArrTags: string[];
    removeArrTags: string[];
    arrInstanceId: string | null;
    targetQualityProfileId?: number | null;
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
  PENDING: "bg-amber/20 text-amber border-amber/30",
  COMPLETED: "bg-green/20 text-green border-green/30",
  FAILED: "bg-red/20 text-red border-red/30",
};

type ActionMediaItem = ActionItem["mediaItem"];

/** How a row names its item: the show or artist with the member's own title. */
function actionItemTitle(mi: ActionMediaItem): string {
  return mi.parentTitle ? `${mi.parentTitle} — ${mi.title}` : mi.title;
}

/** The hover popover's fields, the same in the table and the card view. */
function actionHoverContent(mi: ActionMediaItem, withImage: boolean) {
  return (
    <MediaHoverPopover
      imageUrl={withImage ? `/api/media/${mi.id}/image${mi.type !== "MOVIE" ? "?type=parent" : ""}` : undefined}
      imageAspect={mi.type === "MUSIC" ? "square" : "poster"}
      data={hoverDataFromListItem(mi, { title: actionItemTitle(mi) })}
    />
  );
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
  executingItems: ReadonlySet<string>;
  retryingItems: ReadonlySet<string>;
  excludingItems: ReadonlySet<string>;
  exceptedItemIds: ReadonlySet<string>;
  onExecuteItem: (ruleSetId: string, mediaItemId: string) => void;
  onRemoveAction: (id: string) => void;
  onRetryAction: (action: ActionItem) => void;
  onExclude: (action: ActionItem) => void;
  onItemClick: (action: ActionItem) => void;
  isDeletedRuleSet?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedErrors, { toggle: toggleError }] = useSetState<string>();

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
      <div ref={scrollRef} className="md:max-h-[60dvh] overflow-auto">
        <table className="w-full caption-bottom text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b bg-muted/50">
              <th className="h-10 px-4 text-left align-middle font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Title</th>
              <th className="h-10 px-4 text-left align-middle font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Size</th>
              <th className="h-10 px-4 text-left align-middle font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Action</th>
              <th className="h-10 px-4 text-left align-middle font-mono text-[11px] uppercase tracking-[0.08em] text-faint">{isPending ? "Scheduled" : "Date"}</th>
              <th className="h-10 px-4 text-left align-middle font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Status</th>
              {isPending && <th className="h-10 px-4 w-30 text-left align-middle font-mono text-[11px] uppercase tracking-[0.08em] text-faint" />}
              {!isPending && items.some((a) => a.status === "FAILED") && (
                <th className="h-10 px-4 w-12 text-left align-middle font-mono text-[11px] uppercase tracking-[0.08em] text-faint" />
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
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <ShieldOff className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                            </TooltipTrigger>
                            <TooltipContent>Excluded from lifecycle actions</TooltipContent>
                          </Tooltip>
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
                  <td className="p-4 align-middle text-sm text-muted-foreground">
                    {action.mediaItem.fileSize ? formatFileSize(action.mediaItem.fileSize) : "—"}
                  </td>
                  <td className="p-4 align-middle">
                    <div className="space-y-1">
                      <p className="text-sm">
                        {formatActionTypeLabel(action.actionType, action.targetQualityProfileId)}
                      </p>
                      {action.addImportExclusion && (
                        <ColorChip className="bg-muted/40 text-muted-foreground">+ List exclusion</ColorChip>
                      )}
                      {action.addArrTags?.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {action.addArrTags.map((tag) => (
                            <ColorChip
                              key={tag}
                              className="bg-green/20 text-green border-green/30"
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
                              className="bg-red/20 text-red border-red/30"
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
                          className={`text-xs text-red ${expandedErrors.has(action.id) ? "whitespace-pre-wrap wrap-break-word" : "truncate"}`}
                        >
                          {action.error}
                        </p>
                        {action.error.length > 40 && (
                          <button
                            className="text-[10px] text-muted-foreground hover:text-foreground mt-0.5"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleError(action.id);
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
                    {actionHoverContent(action.mediaItem, true)}
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

const actionKey = (action: ActionItem) => action.id;

interface PendingActionCardProps {
  action: ActionItem;
  isMusic: boolean;
  isMovie: boolean;
  priority: boolean;
  excepted: boolean;
  onItemClick: (action: ActionItem) => void;
  getHex: (category: ChipColorCategory, value: string) => string;
}

/**
 * One action's card, memoised on what it shows: the grid re-renders on every
 * virtualizer range change, and the card's metadata and hover content are
 * new elements each time.
 */
const PendingActionCard = memo(function PendingActionCard({
  action,
  isMusic,
  isMovie,
  priority,
  excepted,
  onItemClick,
  getHex,
}: PendingActionCardProps) {
  const mi = action.mediaItem;
  return (
    <div className="relative">
      {excepted && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="absolute top-2 left-2 z-20 h-6 w-6 rounded-md bg-orange-500/90 backdrop-blur-sm flex items-center justify-center">
              <ShieldOff className="h-3.5 w-3.5 text-white" />
            </div>
          </TooltipTrigger>
          <TooltipContent>Excluded from lifecycle actions</TooltipContent>
        </Tooltip>
      )}
      <MediaCard
        imageUrl={`/api/media/${mi.id}/image${!isMovie ? "?type=parent" : ""}`}
        title={actionItemTitle(mi)}
        fallbackIcon={isMovie ? "movie" : isMusic ? "music" : "series"}
        aspectRatio={isMusic ? "square" : "poster"}
        priority={priority}
        prefetchMediaId={mi.id ?? undefined}
        onClick={() => onItemClick(action)}
        hoverContent={actionHoverContent(mi, false)}
        metadata={
          <MetadataLine>
            {mi.year && <span>{mi.year}</span>}
            {formatDuration(mi.duration ?? null) && <span>{formatDuration(mi.duration ?? null)}</span>}
            {formatFileSize(mi.fileSize ?? null) && <span>{formatFileSize(mi.fileSize ?? null)}</span>}
          </MetadataLine>
        }
        qualityBar={
          // A grouped row's own values are one episode's or track's.
          mi.matchedEpisodes ? undefined : qualitySegments(qualityChips(mi, isMusic ? "music" : "video"), getHex)
        }
        badges={
          <ColorChip className={STATUS_COLORS[action.status] || "bg-muted text-muted-foreground"}>
            {STATUS_LABELS[action.status] ?? action.status}
          </ColorChip>
        }
      />
    </div>
  );
});

function PendingActionCardGrid({
  items,
  ruleSetType,
  onItemClick,
  exceptedItemIds,
}: {
  items: ActionItem[];
  ruleSetType: string;
  /** Stable: the cards are memoised on it. */
  onItemClick: (action: ActionItem) => void;
  exceptedItemIds: ReadonlySet<string>;
}) {
  const { columns } = useCardSize();
  const { getHex } = useChipColors();
  const isMusic = ruleSetType === "MUSIC";
  const isMovie = ruleSetType === "MOVIE";

  const filteredItems = useMemo(
    () => items.filter((a) => a.mediaItem.id !== null),
    [items],
  );

  const grid = useVirtualPosterGrid({
    count: filteredItems.length,
    columns,
    aspect: isMusic ? SQUARE_ASPECT : POSTER_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "own",
    overscan: 5,
  });

  const renderCard = useCallback(
    (action: ActionItem, { priority }: GridCardContext) => (
      <PendingActionCard
        action={action}
        isMusic={isMusic}
        isMovie={isMovie}
        priority={priority}
        excepted={exceptedItemIds.has(action.mediaItem.id!)}
        onItemClick={onItemClick}
        getHex={getHex}
      />
    ),
    [isMusic, isMovie, exceptedItemIds, onItemClick, getHex],
  );

  return (
    <VirtualCardGrid
      grid={grid}
      items={filteredItems}
      getKey={actionKey}
      renderItem={renderCard}
      className="md:max-h-[60dvh] overflow-y-auto"
    />
  );
}

/* ---------- Main page ---------- */

const ruleSetOfGroup = (g: RuleSetGroup) => g.ruleSet;

// Detection is what CREATES pending actions, and an execute removes them and
// moves the deletion stats: the listing and the stats card above it re-read
// on both, so the two halves of this page never disagree.
const PENDING_EVENTS = ["lifecycle:action-executed", "lifecycle:detection-completed"] as const;

/** The execute route's announcement of the run this page asked for. */
const isOwnExecute = (result: { executed?: unknown; failed?: unknown }) => (data: Record<string, unknown>) =>
  data.manual === true && data.executed === result.executed && data.failed === result.failed;

export default function PendingActionsPage() {
  const [groups, setGroups] = useState<RuleSetGroup[]>([]);
  const { tab: mediaTypeTab, setTab: setMediaTypeTab, filtered: filteredGroups } =
    useRuleSetTypeFilter(groups, ruleSetOfGroup);
  const [loading, setLoading] = useState(true);
  const { health: integrationsHealth } = useIntegrationsHealth();
  const arrInstanceIds = useMemo<readonly string[]>(
    () => Array.from(new Set(
      groups
        .map((g) => g.ruleSet.arrInstanceId)
        .filter((id): id is string => !!id),
    )),
    [groups],
  );
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const { size: cardSize, setSize: setCardSize } = useCardSize();
  const [expandedRules, { toggle: toggleExpand }] = useSetState<string>();
  const [executingRules, executingRuleActions] = useSetState<string>();
  const [executingItems, executingItemActions] = useSetState<string>();
  const [executeResults, setExecuteResults] = useState<Record<string, { executed: number; failed: number; errors: string[] }>>({});
  const [confirmExecuteRuleSetId, setConfirmExecuteRuleSetId] = useState<string | null>(null);

  const detailPanel = useMediaDetailPanel();

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

  const handleResetStats = async () => {
    setResettingStats(true);
    try {
      const response = await fetch("/api/lifecycle/stats/reset", { method: "POST" });
      if (response.ok) {
        await fetchDeletionStats();
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

  // Only the latest request may write. The Pending listing is the slow one
  // (it estimates rows for matches without an action), so switching to
  // Completed while it loaded let it land second and fill the Completed tab
  // with pending rows — without their Execute buttons, which follow the tab.
  const actionsReqToken = useRef(0);
  const fetchActions = useCallback(async () => {
    const token = ++actionsReqToken.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: statusFilter });
      const response = await fetch(`/api/lifecycle/actions?${params}`);
      const data = await response.json();
      if (token !== actionsReqToken.current) return;
      setGroups(data.groups || []);
    } catch (error) {
      console.error("Failed to fetch actions:", error);
    } finally {
      if (token === actionsReqToken.current) setLoading(false);
    }
  }, [statusFilter]);

  const refreshPage = useCallback(
    () => Promise.all([fetchActions(), fetchDeletionStats()]),
    [fetchActions, fetchDeletionStats],
  );
  const pageRefetch = useRealtimeRefetch(PENDING_EVENTS, refreshPage);

  useEffect(() => {
    fetchActions();
  }, [fetchActions]);

  const removeAction = async (id: string) => {
    try {
      const response = await fetch(`/api/lifecycle/actions/${id}`, { method: "DELETE" });
      if (!response.ok) {
        toast.error("Failed to remove action");
        return;
      }
      await fetchActions();
      void fetchDeletionStats();
      toast.success("Action removed");
    } catch (error) {
      console.error("Failed to remove action:", error);
      toast.error("Failed to remove action");
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

    retryingActions.add(action.id);
    try {
      const params = retrySkipTitle ? "?skipTitleValidation=true" : "";
      const response = await fetch(`/api/lifecycle/actions/${action.id}${params}`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.failed > 0) {
        toast.error("Retry failed", {
          description: data.errors?.join("\n") || data.error,
        });
      } else {
        toast.success("Action executed", { description: action.mediaItem.title });
      }
      await fetchActions();
      void fetchDeletionStats();
    } catch (error) {
      console.error("Failed to retry action:", error);
      toast.error("Retry failed");
    } finally {
      retryingActions.remove(action.id);
    }
  };

  // Execute All and a row's Execute re-read the listing and the stats when
  // they answer. The route announces a run that executed or failed anything
  // with `lifecycle:action-executed`, whose re-read is the one kept when it
  // reaches the page (`useRealtimeRefetch`); a refusal re-reads at once.
  const executeAll = async (ruleSetId: string) => {
    setConfirmExecuteRuleSetId(null);
    executingRuleActions.add(ruleSetId);
    setExecuteResults((prev) => {
      const next = { ...prev };
      delete next[ruleSetId];
      return next;
    });
    const ticket = pageRefetch.begin();
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
        } else if (data.executed > 0) {
          toast.success(`${data.executed} action${data.executed !== 1 ? "s" : ""} executed`);
        }
      } else {
        setExecuteResults((prev) => ({
          ...prev,
          [ruleSetId]: { executed: 0, failed: 0, errors: [data.error || "Unknown error"] },
        }));
        toast.error(data.error || "Failed to execute actions");
      }
      await ticket.settle({
        expectEvent: response.ok && (data.executed > 0 || data.failed > 0),
        isOwn: isOwnExecute(data),
      });
    } catch (error) {
      setExecuteResults((prev) => ({
        ...prev,
        [ruleSetId]: { executed: 0, failed: 0, errors: [String(error)] },
      }));
    } finally {
      ticket.cancel();
      executingRuleActions.remove(ruleSetId);
    }
  };

  const executeItem = async (ruleSetId: string, mediaItemId: string) => {
    const key = `${ruleSetId}:${mediaItemId}`;
    executingItemActions.add(key);
    const ticket = pageRefetch.begin();
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
      } else {
        toast.success("Action executed");
      }
      await ticket.settle({
        expectEvent: response.ok && (data.executed > 0 || data.failed > 0),
        isOwn: isOwnExecute(data),
      });
    } catch (error) {
      console.error("Failed to execute item:", error);
      toast.error("Failed to execute action");
    } finally {
      ticket.cancel();
      executingItemActions.remove(key);
    }
  };

  // Which items have lifecycle exceptions, and filing new ones.
  const { exceptedIds: exceptedItemIds, excludingIds: excludingItems, exclude } =
    useLifecycleExceptions({ announce: true });
  const [retryingItems, retryingActions] = useSetState<string>();
  const [excludePromptAction, setExcludePromptAction] = useState<ActionItem | null>(null);

  const confirmExclude = async (action: ActionItem, reason: string) => {
    if (!action.mediaItem.id) return;
    // Filing an exception emits no event, so the page re-reads by itself.
    if (!(await exclude(action.mediaItem.id, { reason, label: action.mediaItem.title }))) return;
    await fetchActions();
    void fetchDeletionStats();
  };

  const excludeItem = (action: ActionItem) => {
    setExcludePromptAction(action);
  };

  const { open: openPanel } = detailPanel;
  const openDetailPanel = useCallback((action: ActionItem) => {
    if (!action.mediaItem.id) return;
    const mediaType = toDetailPanelMediaType(action.mediaItem.type);
    void openPanel({
      id: action.mediaItem.id,
      mediaType,
      group: groupOfRow(action.mediaItem),
      // A series action is named as its row names it — the show, or
      // "<Show> SxxExx" for an action on one episode — not by the episode it
      // is stored against.
      title: mediaType === "SERIES" ? action.mediaItem.title : undefined,
      label: action.mediaItem.parentTitle
        ? `${action.mediaItem.parentTitle} - ${action.mediaItem.title}`
        : action.mediaItem.title,
    });
  }, [openPanel]);

  const isPending = statusFilter === "PENDING";
  const confirmExecuteGroup = confirmExecuteRuleSetId
    ? groups.find((g) => g.ruleSet.id === confirmExecuteRuleSetId)
    : undefined;

  return (
    <TooltipProvider>
      <div className="p-4 sm:p-6 lg:p-8 overflow-auto h-full">
        <PageHeader
          className="mb-6"
          title="Pending Actions"
          description="Scheduled lifecycle actions awaiting execution, grouped by rule set."
        />

        {/* Integration connectivity warning — pending actions that depend on Arr will fail until reachable */}
        <div className="mb-6">
          <IntegrationUnreachableBanner
            health={integrationsHealth}
            hasArrRules={arrInstanceIds.length > 0}
            hasSeerrRules={false}
            arrInstanceIds={arrInstanceIds}
            subjectLabel="Pending actions"
          />
        </div>

        {/* Deletion stats banner */}
        {deletionStats && (deletionStats.actionCount > 0 || deletionStats.pendingCount > 0 || deletionStats.resetAt) && (
          <div className="flex items-center gap-4 mb-6 rounded-xl border bg-card px-4 py-3 shadow-[var(--shadow-card)]">
            <Trash2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {deletionStats.pendingCount > 0 && (
                <>
                  <span>
                    <span className="font-medium text-amber">{formatFileSize(deletionStats.pendingBytes)}</span>
                    <span className="text-muted-foreground ml-1">pending</span>
                  </span>
                  <span className="hidden text-muted-foreground sm:inline">·</span>
                  <span>
                    <span className="font-medium text-amber">{deletionStats.pendingCount}</span>
                    <span className="text-muted-foreground ml-1">{deletionStats.pendingCount === 1 ? "action" : "actions"} queued</span>
                  </span>
                </>
              )}
              {deletionStats.pendingCount > 0 && deletionStats.actionCount > 0 && (
                <span className="hidden text-muted-foreground sm:inline">·</span>
              )}
              {deletionStats.actionCount > 0 && (
                <>
                  <span>
                    <span className="font-medium">{formatFileSize(deletionStats.totalBytesDeleted)}</span>
                    <span className="text-muted-foreground ml-1">deleted</span>
                  </span>
                  <span className="hidden text-muted-foreground sm:inline">·</span>
                  <span>
                    <span className="font-medium">{deletionStats.actionCount}</span>
                    <span className="text-muted-foreground ml-1">{deletionStats.actionCount === 1 ? "action" : "actions"} completed</span>
                  </span>
                </>
              )}
              {deletionStats.resetAt && (
                <>
                  <span className="hidden text-muted-foreground sm:inline">·</span>
                  <span className="text-xs text-muted-foreground">
                    since {new Date(deletionStats.resetAt).toLocaleDateString()}
                  </span>
                </>
              )}
            </div>
            <div className="ml-auto">
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
            </div>
          </div>
        )}

        <TabNav tabs={LIFECYCLE_MEDIA_TYPE_TABS} activeTab={mediaTypeTab} onTabChange={setMediaTypeTab} className="mb-6" />

        {/* Status filter + view toggle */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex flex-wrap gap-2">
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
              <Button variant={viewMode === "table" ? "secondary" : "ghost"} size="icon" className="h-8 w-8 rounded-r-none" onClick={() => setViewMode("table")} aria-label="Table view" title="Table view"><TableProperties className="h-4 w-4" /></Button>
              <Button variant={viewMode === "cards" ? "secondary" : "ghost"} size="icon" className="h-8 w-8 rounded-l-none" onClick={() => setViewMode("cards")} aria-label="Card view" title="Card view"><LayoutGrid className="h-4 w-4" /></Button>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredGroups.length === 0 ? (
          <EmptyState
            icon={statusFilter === "FAILED" ? CheckCircle2 : Inbox}
            title={
              statusFilter === "FAILED"
                ? "No failed actions"
                : statusFilter === "COMPLETED"
                  ? "No completed actions yet"
                  : statusFilter === "PENDING"
                    ? "No pending actions"
                    : "No actions"
            }
            description={
              statusFilter === "FAILED"
                ? "Everything ran cleanly. Failed actions will appear here if any rule execution fails."
                : statusFilter === "COMPLETED"
                  ? "Completed actions will appear here once your rules start running."
                  : statusFilter === "PENDING"
                    ? "Lifecycle rules will queue up actions here when items match."
                    : "No actions matching this filter."
            }
          />
        ) : (
          <div className="space-y-4">
            {filteredGroups.map((group) => {
              const isExpanded = expandedRules.has(group.ruleSet.id);
              const isExecuting = executingRules.has(group.ruleSet.id);
              const result = executeResults[group.ruleSet.id];

              // Per-rule deletion stats — contextual to active tab
              const rs = ruleSetStatsMap.get(group.ruleSet.id);
              const showPending = statusFilter === "PENDING" || statusFilter === "ALL";
              const showDeleted = statusFilter !== "PENDING";
              const stats =
                rs && ((showPending && rs.pendingCount > 0) || (showDeleted && rs.deletedCount > 0)) ? (
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {showPending && rs.pendingCount > 0 && (
                      <span>
                        <span className="text-amber">{formatFileSize(rs.pendingBytes)}</span> pending
                      </span>
                    )}
                    {showDeleted && rs.deletedCount > 0 && (
                      <span>
                        {formatFileSize(rs.deletedBytes)} deleted ({rs.deletedCount})
                      </span>
                    )}
                  </div>
                ) : null;

              return (
                <RuleSetGroupCard
                  key={group.ruleSet.id}
                  ruleSet={group.ruleSet}
                  countLabel={`${group.count} item${group.count !== 1 ? "s" : ""}`}
                  expanded={isExpanded}
                  onToggle={() => toggleExpand(group.ruleSet.id)}
                  meta={stats}
                  actions={
                    // Execute All button (only for PENDING filter, not for deleted rule sets)
                    isPending && group.count > 0 && !group.ruleSet.deleted ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {result && (
                          <span className="text-xs">
                            {result.failed === 0 ? (
                              <span className="text-green flex items-center gap-1">
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
                        <LoadingButton
                          size="sm"
                          variant="default"
                          onClick={() => setConfirmExecuteRuleSetId(group.ruleSet.id)}
                          loading={isExecuting}
                          icon={Play}
                          iconClassName="h-4 w-4 mr-1"
                        >
                          {isExecuting ? "Executing..." : "Execute All"}
                        </LoadingButton>
                      </div>
                    ) : undefined
                  }
                >
                  {group.items.length > 0 ? (
                    viewMode === "table" ? (
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
                    )
                  ) : (
                    <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                      <Inbox className="h-4 w-4" />
                      No items in this group.
                    </p>
                  )}
                </RuleSetGroupCard>
              );
            })}
          </div>
        )}

        {/* Execute All confirmation dialog */}
        <ConfirmDialog
          open={!!confirmExecuteRuleSetId}
          onOpenChange={(open) => { if (!open) setConfirmExecuteRuleSetId(null); }}
          title="Execute All Actions"
          description={
            confirmExecuteGroup
              ? `This will immediately execute ${formatActionTypeLabel(confirmExecuteGroup.ruleSet.actionType ?? "DO_NOTHING", confirmExecuteGroup.ruleSet.targetQualityProfileId)} on ${confirmExecuteGroup.count} item${confirmExecuteGroup.count !== 1 ? "s" : ""} for "${confirmExecuteGroup.ruleSet.name}". This action cannot be undone.`
              : "Are you sure?"
          }
          confirmLabel="Execute"
          onConfirm={() => {
            if (confirmExecuteRuleSetId) void executeAll(confirmExecuteRuleSetId);
          }}
        />

        {/* Reset deletion stats confirmation */}
        <ConfirmDialog
          open={confirmResetStats}
          onOpenChange={setConfirmResetStats}
          title="Reset Deletion Stats"
          description="This will reset the deletion stats counter. Historical action records will not be affected — only the stats display will start counting from now."
          confirmLabel="Reset"
          pending={resettingStats}
          onConfirm={handleResetStats}
        />

        {/* Force retry confirmation dialog */}
        <ConfirmDialog
          open={!!confirmRetryAction}
          onOpenChange={(open) => { if (!open) setConfirmRetryAction(null); }}
          title="Force Retry Action"
          description={
            <>
              Retry {formatActionTypeLabel(confirmRetryAction?.actionType ?? "", confirmRetryAction?.targetQualityProfileId)} for &quot;{confirmRetryAction?.mediaItem.title}&quot;?
            </>
          }
          confirmLabel="Retry"
          onConfirm={() => {
            void executeRetry();
          }}
        >
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
        </ConfirmDialog>
      </div>

      {detailPanel.panelProps && <MediaDetailSidePanel {...detailPanel.panelProps} />}

      <ExcludeReasonDialog
        itemLabel={excludePromptAction ? actionItemTitle(excludePromptAction.mediaItem) : null}
        onCancel={() => setExcludePromptAction(null)}
        onConfirm={(reason) => {
          const action = excludePromptAction;
          setExcludePromptAction(null);
          if (action) void confirmExclude(action, reason);
        }}
      />
    </TooltipProvider>
  );
}
