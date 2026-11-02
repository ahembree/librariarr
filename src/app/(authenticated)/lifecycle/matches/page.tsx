"use client";

import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { toast } from "sonner";
import { useLocalStorage, useLocalStorageJSON } from "@/hooks/use-local-storage";
import Link from "next/link";
import { useColumnResize } from "@/hooks/use-column-resize";
import { useMediaDetailPanel } from "@/hooks/use-media-detail-panel";
import { groupOfRow, toDetailPanelMediaType } from "@/lib/media/detail-panel-item";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { ruleBuilderConfig } from "@/components/rule-builder";
import type { BaseGroup, BaseRule, BuilderConfig } from "@/components/builder/types";
import type { LifecycleRuleGroup } from "@/lib/rules/types";
import { EmptyState } from "@/components/empty-state";
import { IntegrationUnreachableBanner } from "@/components/integration-unreachable-banner";
import { useIntegrationsHealth } from "@/hooks/use-integrations-health";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { MediaCard } from "@/components/media-card";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine } from "@/components/metadata-line";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { useChipColors } from "@/components/chip-color-provider";
import { type ChipColorCategory } from "@/lib/theme/chip-colors";
import { formatFileSize, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MediaItemWithRelations } from "@/lib/types";
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Inbox,
  LayoutGrid,
  Loader2,
  RefreshCw,
  ShieldOff,
  TableProperties,
} from "lucide-react";
import { TabNav } from "@/components/tab-nav";
import { ColorChip } from "@/components/color-chip";
import { MediaHoverPopover, hoverDataFromListItem } from "@/components/media-hover-popover";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-header";
import { LoadingButton } from "@/components/loading-button";
import { ExcludeReasonDialog } from "@/components/exclude-reason-dialog";
import { RuleSetGroupCard, LIFECYCLE_MEDIA_TYPE_TABS } from "@/components/rule-set-group-card";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import { useVirtualPosterGrid, POSTER_ASPECT, SQUARE_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT } from "@/hooks/use-library-grid";
import { useRuleSetTypeFilter } from "@/hooks/use-rule-set-type-filter";
import { useLifecycleExceptions } from "@/hooks/use-lifecycle-exceptions";
import { useRealtimeRefetch } from "@/hooks/use-realtime-refetch";
import { useSetState } from "@/hooks/use-set-state";

interface MatchedCriterion {
  ruleId: string;
  field: string;
  operator: string;
  value: string;
  negate: boolean;
  groupName?: string;
  actualValue?: string;
}

interface MatchedMediaItem extends MediaItemWithRelations {
  matchedCriteria?: MatchedCriterion[];
  actualValues?: Record<string, string>;
  arrId?: number | null;
  detectedAt?: string;
}

interface RuleSetMatch {
  ruleSet: {
    id: string;
    name: string;
    type: string;
    actionEnabled: boolean;
    actionType: string | null;
    actionDelayDays: number;
    arrInstanceId: string | null;
    targetQualityProfileId: number | null;
    addImportExclusion: boolean;
    searchAfterAction: boolean;
    addArrTags: string[];
    removeArrTags: string[];
    rules: LifecycleRuleGroup[] | unknown[];
    collectionName: string | null;
  };
  items: MatchedMediaItem[];
  count: number;
}

type MatchRuleSet = RuleSetMatch["ruleSet"];

interface MatchItemsViewProps {
  items: MatchedMediaItem[];
  ruleSet: MatchRuleSet;
  /** Stable: the views memoise their rows and cards on it. */
  onItemClick: (item: MatchedMediaItem, ruleSet: MatchRuleSet) => void;
  onExclude: (item: MatchedMediaItem) => void;
  excludingItems: ReadonlySet<string>;
  exceptedItemIds: ReadonlySet<string>;
  getHex: (category: ChipColorCategory, value: string) => string;
  show: (section: "badges" | "metadata", key: string) => boolean;
  columnVisibility: Record<string, boolean>;
}

/** How a match names its item: the show or artist with the member's own title. */
function matchTitle(item: MatchedMediaItem, separator: string): string {
  return item.parentTitle ? `${item.parentTitle} ${separator} ${item.title}` : item.title;
}

/** The item's artwork — a show's or artist's for a member row. */
function matchImageUrl(item: MatchedMediaItem, type: string): string {
  return `/api/media/${item.id}/image${type !== "MOVIE" ? "?type=parent" : ""}`;
}

/** The hover popover's fields, the same in the table and the card view. */
function matchHoverContent(item: MatchedMediaItem, type: string, withImage: boolean) {
  return (
    <MediaHoverPopover
      imageUrl={withImage ? matchImageUrl(item, type) : undefined}
      imageAspect={type === "MUSIC" ? "square" : "poster"}
      data={hoverDataFromListItem(item, { title: matchTitle(item, "—") })}
    />
  );
}

const ALL_MATCH_COLUMNS: MatchColumnDef[] = [
  { id: "title", label: "Title", defaultWidth: 240, alwaysVisible: true },
  { id: "matchDate", label: "Match Date", defaultWidth: 130, defaultVisible: true },
  { id: "matchedCriteria", label: "Matched Criteria", defaultWidth: 280, defaultVisible: true },
  { id: "action", label: "", defaultWidth: 100, alwaysVisible: true },
];

interface MatchColumnDef {
  id: string;
  label: string;
  defaultWidth: number;
  alwaysVisible?: boolean;
  defaultVisible?: boolean;
}

const MATCH_COLUMN_STORAGE_KEY = "match-table-column-visibility";

function getDefaultMatchColumnVisibility(): Record<string, boolean> {
  const vis: Record<string, boolean> = {};
  for (const col of ALL_MATCH_COLUMNS) {
    vis[col.id] = col.alwaysVisible || col.defaultVisible || false;
  }
  return vis;
}

function mergeColumnVisibility(stored: Record<string, boolean> | null): Record<string, boolean> {
  const defaults = getDefaultMatchColumnVisibility();
  if (!stored) return defaults;
  for (const col of ALL_MATCH_COLUMNS) {
    if (col.id in stored && !col.alwaysVisible) {
      defaults[col.id] = stored[col.id];
    }
  }
  return defaults;
}

function CollapsibleCriteria({ criteria }: { criteria: MatchedCriterion[] }) {
  const [expanded, setExpanded] = useState(false);

  if (criteria.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  function renderBadge(c: MatchedCriterion, idx: number) {
    const badge = (
      <ColorChip
        key={idx}
        className="border-border text-muted-foreground text-[11px] font-normal"
      >
        {c.groupName && (
          <span className="text-sky mr-0.5">[{c.groupName}]</span>
        )}
        {c.negate && (
          <span className="text-red mr-0.5">NOT</span>
        )}
        <span className="text-muted-foreground">{c.field}</span>
        {" "}
        <span>{c.operator}</span>
        {" "}
        <span className="font-medium">{c.value}</span>
      </ColorChip>
    );
    if (c.actualValue) {
      return (
        <Tooltip key={idx}>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent>Actual: {c.actualValue}</TooltipContent>
        </Tooltip>
      );
    }
    return badge;
  }

  if (!expanded) {
    return (
      <button
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(true);
        }}
      >
        <ChevronRight className="h-3 w-3" />
        {criteria.length} {criteria.length === 1 ? "criterion" : "criteria"}
      </button>
    );
  }

  return (
    <div>
      <button
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(false);
        }}
      >
        <ChevronDown className="h-3 w-3" />
        {criteria.length} {criteria.length === 1 ? "criterion" : "criteria"}
      </button>
      <div className="flex flex-wrap gap-1">
        {criteria.map((c, idx) => renderBadge(c, idx))}
      </div>
    </div>
  );
}

function MatchItemsTableView({
  items,
  ruleSet,
  onItemClick,
  onExclude,
  excludingItems,
  exceptedItemIds,
  columnVisibility,
}: MatchItemsViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const visibleColumns = useMemo(
    () => ALL_MATCH_COLUMNS.filter((col) => columnVisibility[col.id]),
    [columnVisibility],
  );

  const resizeColumns = useMemo(
    () => visibleColumns.map((col) => ({ id: col.id, defaultWidth: col.defaultWidth })),
    [visibleColumns],
  );

  const { columnWidths, totalWidth, getResizeProps } = useColumnResize({
    columns: resizeColumns,
    storageKey: "match-table-widths",
  });

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 45,
    overscan: 10,
  });

  function resizeHandle(columnId: string) {
    const props = getResizeProps(columnId);
    return (
      <div
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/50 active:bg-primary z-10 touch-none"
        onMouseDown={props.onMouseDown}
        onTouchStart={props.onTouchStart}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={props.onDoubleClick}
      />
    );
  }

  return (
    <div ref={scrollContainerRef} className="md:max-h-[60dvh] overflow-y-auto rounded-lg border">
      <table className="w-full text-sm table-fixed" style={{ minWidth: totalWidth }}>
        <thead className="sticky top-0 z-10 bg-background" style={{ display: "block" }}>
          <tr className="border-b bg-muted/50" style={{ display: "table", tableLayout: "fixed", width: "100%", minWidth: totalWidth }}>
            {visibleColumns.map((col) => (
              <th
                key={col.id}
                className={cn(
                  "px-4 py-2 font-medium relative",
                  col.id === "action" ? "text-center" : "text-left",
                )}
                style={{ width: columnWidths[col.id] }}
              >
                {col.label}
                {resizeHandle(col.id)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ height: virtualizer.getTotalSize(), position: "relative", display: "block" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];

            const tableRow = (
              <tr
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="transition-all duration-200 hover:bg-white/3 even:bg-white/1.5 hover:ring-1 hover:ring-primary/20 hover:shadow-md hover:shadow-primary/10 cursor-pointer"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  display: "table",
                  tableLayout: "fixed",
                  transform: `translateY(${virtualRow.start}px)`,
                  minWidth: totalWidth,
                }}
                onClick={() => onItemClick(item, ruleSet)}
              >
                {columnVisibility.title && (
                  <td
                    className="px-4 py-2 overflow-hidden text-ellipsis"
                    style={{ width: columnWidths.title }}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {exceptedItemIds.has(item.id) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <ShieldOff className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                          </TooltipTrigger>
                          <TooltipContent>Excluded from lifecycle actions</TooltipContent>
                        </Tooltip>
                      )}
                      {item.parentTitle ? (
                        <>
                          <span>{item.parentTitle}</span>
                          <span className="text-xs text-muted-foreground ml-1.5">— {item.title}</span>
                        </>
                      ) : (
                        <span>{item.title}</span>
                      )}
                    </span>
                  </td>
                )}
                {columnVisibility.matchDate && (
                  <td className="px-4 py-2 text-muted-foreground overflow-hidden" style={{ width: columnWidths.matchDate }}>
                    {item.detectedAt ? new Date(item.detectedAt).toLocaleDateString() : "-"}
                  </td>
                )}
                {columnVisibility.matchedCriteria && (
                  <td className="px-4 py-2 overflow-hidden" style={{ width: columnWidths.matchedCriteria }}>
                    <CollapsibleCriteria criteria={item.matchedCriteria || []} />
                  </td>
                )}
                {columnVisibility.action && (
                  <td className="px-2 py-2 text-center" style={{ width: columnWidths.action }}>
                    <button
                      className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium border border-orange-500/40 text-orange-400 hover:bg-orange-500/10 hover:border-orange-500/60 transition-colors disabled:opacity-50"
                      onClick={(e) => {
                        e.stopPropagation();
                        onExclude(item);
                      }}
                      disabled={excludingItems.has(item.id)}
                    >
                      {excludingItems.has(item.id) ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldOff className="h-3.5 w-3.5" />
                      )}
                      Exclude
                    </button>
                  </td>
                )}
              </tr>
            );

            return (
              <HoverCard key={item.id} openDelay={400} closeDelay={150}>
                <HoverCardTrigger asChild>
                  {tableRow}
                </HoverCardTrigger>
                <HoverCardContent side="bottom" align="start" sideOffset={4} className="w-72 p-0 duration-200">
                  {matchHoverContent(item, ruleSet.type, true)}
                </HoverCardContent>
              </HoverCard>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const matchKey = (item: MatchedMediaItem) => item.id;

interface MatchCardProps {
  item: MatchedMediaItem;
  ruleSet: MatchRuleSet;
  priority: boolean;
  excluding: boolean;
  excepted: boolean;
  onItemClick: MatchItemsViewProps["onItemClick"];
  onExclude: MatchItemsViewProps["onExclude"];
  getHex: MatchItemsViewProps["getHex"];
  show: MatchItemsViewProps["show"];
}

/**
 * One match card, memoised on what it shows: the grid re-renders on every
 * virtualizer range change, and the card's metadata, quality bar and hover
 * content are new elements each time.
 */
const MatchCard = memo(function MatchCard({
  item,
  ruleSet,
  priority,
  excluding,
  excepted,
  onItemClick,
  onExclude,
  getHex,
  show,
}: MatchCardProps) {
  const isMusic = ruleSet.type === "MUSIC";
  const fallbackIcon = ruleSet.type === "MOVIE" ? "movie" as const : isMusic ? "music" as const : "series" as const;
  return (
    <div className="relative group">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="absolute top-2 right-2 z-20 h-7 w-7 rounded-md bg-background/80 backdrop-blur-sm flex items-center justify-center text-muted-foreground hover:text-orange-400 hover:bg-background/90 transition-all opacity-0 group-hover:opacity-100 disabled:opacity-50"
            onClick={(e) => {
              e.stopPropagation();
              onExclude(item);
            }}
            disabled={excluding}
          >
            {excluding ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldOff className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>Exclude from lifecycle actions</TooltipContent>
      </Tooltip>
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
        imageUrl={matchImageUrl(item, ruleSet.type)}
        title={matchTitle(item, "-")}
        fallbackIcon={fallbackIcon}
        aspectRatio={isMusic ? "square" : "poster"}
        priority={priority}
        prefetchMediaId={item.id}
        onClick={() => onItemClick(item, ruleSet)}
        hoverContent={matchHoverContent(item, ruleSet.type, false)}
        metadata={
          <MetadataLine>
            {show("metadata", "year") && item.year && <span>{item.year}</span>}
            {show("metadata", "duration") && formatDuration(item.duration) && <span>{formatDuration(item.duration)}</span>}
            {show("metadata", "fileSize") && formatFileSize(item.fileSize) && <span>{formatFileSize(item.fileSize)}</span>}
          </MetadataLine>
        }
        qualityBar={qualitySegments(
          // An artist row is stored against one of its tracks, whose codec
          // is not the artist's, so it draws no codec segment.
          isMusic && item.matchedEpisodes ? [] : qualityChips(item, isMusic ? "music" : "video"),
          getHex,
          (toggle) => show("badges", toggle),
        )}
        badges={
          item.matchedCriteria && item.matchedCriteria.length > 0 ? (
            <ColorChip className="border-border text-muted-foreground">
              {item.matchedCriteria.length} {item.matchedCriteria.length === 1 ? "match" : "matches"}
            </ColorChip>
          ) : undefined
        }
      />
    </div>
  );
});

function MatchItemsCardView({
  items,
  ruleSet,
  onItemClick,
  onExclude,
  excludingItems,
  exceptedItemIds,
  getHex,
  show,
}: MatchItemsViewProps) {
  const { columns } = useCardSize();
  const grid = useVirtualPosterGrid({
    count: items.length,
    columns,
    aspect: ruleSet.type === "MUSIC" ? SQUARE_ASPECT : POSTER_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "own",
    overscan: 5,
  });

  const renderCard = useCallback(
    (item: MatchedMediaItem, { priority }: GridCardContext) => (
      <MatchCard
        item={item}
        ruleSet={ruleSet}
        priority={priority}
        excluding={excludingItems.has(item.id)}
        excepted={exceptedItemIds.has(item.id)}
        onItemClick={onItemClick}
        onExclude={onExclude}
        getHex={getHex}
        show={show}
      />
    ),
    [ruleSet, excludingItems, exceptedItemIds, onItemClick, onExclude, getHex, show],
  );

  return (
    <VirtualCardGrid
      grid={grid}
      items={items}
      getKey={matchKey}
      renderItem={renderCard}
      className="md:max-h-[60dvh] overflow-y-auto"
    />
  );
}

function MatchItemsView({
  viewMode,
  ...props
}: MatchItemsViewProps & { viewMode: "cards" | "table" }) {
  if (viewMode === "cards") {
    return <MatchItemsCardView {...props} />;
  }
  return <MatchItemsTableView {...props} />;
}

const ruleSetOfMatch = (m: RuleSetMatch) => m.ruleSet;

/** Detection's announcement of the run this page asked for (`/api/lifecycle/rules/run`). */
const isOwnRun = (ruleSetId: string | null) => (data: Record<string, unknown>) =>
  data.manual === true && "ruleSetId" in data && (data.ruleSetId ?? null) === ruleSetId;

// Executing an action cascade-deletes the RuleMatch rows this page renders,
// and a sync or purge can remove the underlying media — so detection alone
// was never enough to keep the list honest.
const MATCH_EVENTS = ["lifecycle:detection-completed", "lifecycle:action-executed", "sync:completed"] as const;

export default function RuleMatchesPage() {
  const detailPanel = useMediaDetailPanel();
  const [ruleMatches, setRuleMatches] = useState<RuleSetMatch[]>([]);
  const { tab: mediaTypeTab, setTab: setMediaTypeTab, filtered: filteredRuleMatches } =
    useRuleSetTypeFilter(ruleMatches, ruleSetOfMatch);
  const { health: integrationsHealth } = useIntegrationsHealth();
  const arrInstanceIds = useMemo<readonly string[]>(
    () => Array.from(new Set(
      ruleMatches
        .map((m) => m.ruleSet.arrInstanceId)
        .filter((id): id is string => !!id),
    )),
    [ruleMatches],
  );
  const [loading, setLoading] = useState(true);
  const [expandedRules, { toggle: toggleExpand }] = useSetState<string>();
  const [viewMode, handleViewModeChange] = useLocalStorage<"cards" | "table">("matches-view-mode", "table");
  const [runningRules, { add: markRunning, remove: unmarkRunning }] = useSetState<string>();
  const [reEvalRunning, setReEvalRunning] = useState(false);
  const { size, setSize } = useCardSize();
  const { getHex } = useChipColors();
  const { show, setVisible, prefs } = useCardDisplay("MOVIE");
  const [storedColumnVisibility, setColumnVisibility] = useLocalStorageJSON<Record<string, boolean> | null>(
    MATCH_COLUMN_STORAGE_KEY,
    null,
  );
  const columnVisibility = useMemo(
    () => mergeColumnVisibility(storedColumnVisibility),
    [storedColumnVisibility],
  );

  const toggleColumn = useCallback((colId: string, checked: boolean) => {
    setColumnVisibility({ ...columnVisibility, [colId]: checked });
  }, [columnVisibility, setColumnVisibility]);

  // Only the latest read may write. Every run re-reads the whole listing when
  // it returns, and runs of different rule sets overlap: a read issued when
  // the first run returned could answer after one issued when the second did,
  // putting the second rule set's pre-run matches back on screen.
  const matchesReqToken = useRef(0);
  const fetchMatches = useCallback(async () => {
    const token = ++matchesReqToken.current;
    try {
      const response = await fetch("/api/lifecycle/rules/matches");
      const data = await response.json();
      if (token !== matchesReqToken.current) return;
      setRuleMatches(data.ruleMatches || []);
    } catch (error) {
      console.error("Failed to fetch matches:", error);
    } finally {
      if (token === matchesReqToken.current) setLoading(false);
    }
  }, []);

  const matchesRefetch = useRealtimeRefetch(MATCH_EVENTS, fetchMatches);

  useEffect(() => {
    void (async () => { await fetchMatches(); })();
  }, [fetchMatches]);

  // Which items have lifecycle exceptions, and filing new ones.
  const { exceptedIds: exceptedItemIds, excludingIds: excludingItems, exclude } = useLifecycleExceptions();
  const [excludePromptItem, setExcludePromptItem] = useState<MatchedMediaItem | null>(null);

  const confirmExclude = useCallback(async (item: MatchedMediaItem, reason: string) => {
    if (!(await exclude(item.id, { reason }))) return;
    setRuleMatches((prev) =>
      prev.map((match) => {
        const filtered = match.items.filter((i) => i.id !== item.id);
        return { ...match, items: filtered, count: filtered.length };
      })
    );
  }, [exclude]);

  const { open: openPanel } = detailPanel;
  const openDetailPanel = useCallback((item: MatchedMediaItem, ruleSet: MatchRuleSet) => {
    // The Logic Preview reads grouped rules; a rule set still stored in the
    // flat legacy shape shows its matched criteria alone.
    const rules = (Array.isArray(ruleSet.rules) ? ruleSet.rules : []) as LifecycleRuleGroup[];
    const grouped = rules.length > 0 && typeof rules[0] === "object" && rules[0] !== null && "rules" in rules[0];
    void openPanel({
      id: item.id,
      mediaType: toDetailPanelMediaType(ruleSet.type),
      seed: item,
      group: groupOfRow(item),
      matchedCriteria: item.matchedCriteria,
      actualValues: item.actualValues,
      ...(grouped && {
        ruleGroups: rules.map((g) => ({ ...g, groups: g.groups ?? [] })) as unknown as BaseGroup<BaseRule>[],
        builderConfig: ruleBuilderConfig as unknown as BuilderConfig<BaseRule, BaseGroup<BaseRule>>,
      }),
    });
  }, [openPanel]);

  const excludeItem = useCallback((item: MatchedMediaItem) => {
    setExcludePromptItem(item);
  }, []);

  // Detection skips a rule set rather than evaluating it whenever it cannot be
  // answered faithfully — an *arr/Seerr instance missing, or a targeted server
  // whose play history isn't established yet (never synced, recently cleared,
  // or a Tracearr import still backfilling). The skip is silent server-side by
  // design (it logs and moves on), so without this the button just spins back
  // to idle and the matches on screen are last run's, not this run's.
  const reportSkipped = useCallback(
    (skipped: unknown) => {
      if (!Array.isArray(skipped) || skipped.length === 0) return;
      const entries = skipped as Array<{ name: string; reason: string }>;
      if (entries.length === 1) {
        toast.warning(`Skipped "${entries[0].name}"`, { description: entries[0].reason });
        return;
      }
      toast.warning(`Skipped ${entries.length} rule sets`, {
        description: entries.map((e) => `${e.name}: ${e.reason}`).join("\n"),
      });
    },
    [],
  );

  // A run re-reads the stored matches rather than splicing in the run's
  // result: detection's result rows are not this page's shape — they lack the
  // collection name, the quality-profile target and every match's
  // `detectedAt` — so the row lost its "Collection:" label, its action label's
  // profile and every Match Date until a reload. The stored matches also keep
  // a skipped rule set's matches, which detection deliberately preserves
  // (blanking the row read as every match lost). The run route announces
  // itself with `lifecycle:detection-completed`, whose re-read is the one kept
  // when it arrives (`useRealtimeRefetch`).
  const runDetection = useCallback(async (ruleSetId: string | null, errorTitle: string) => {
    const ticket = matchesRefetch.begin();
    try {
      const response = await fetch("/api/lifecycle/rules/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ruleSetId ? { ruleSetId, fullReEval: true, processActions: true } : { fullReEval: true, processActions: true }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(errorTitle, {
          description: (data?.error as string) ?? "The detection run failed.",
        });
        return;
      }
      reportSkipped(data.skipped);
      await ticket.settle({ isOwn: isOwnRun(ruleSetId) });
    } catch (error) {
      console.error("Failed to run detection:", error);
      toast.error(errorTitle);
    } finally {
      ticket.cancel();
    }
  }, [matchesRefetch, reportSkipped]);

  const runRule = useCallback(async (ruleSetId: string) => {
    markRunning(ruleSetId);
    try {
      await runDetection(ruleSetId, "Couldn't run the rule");
    } finally {
      unmarkRunning(ruleSetId);
    }
  }, [runDetection, markRunning, unmarkRunning]);

  const reEvalAllRules = useCallback(async () => {
    setReEvalRunning(true);
    try {
      await runDetection(null, "Couldn't re-evaluate rules");
    } finally {
      setReEvalRunning(false);
    }
  }, [runDetection]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="overflow-y-auto h-full">
        <div className="p-4 sm:p-6 lg:p-8">
      {/* Wraps rather than squeezing: beside a long title the toolbar would
          otherwise fold into a column of single buttons on a tablet. */}
      <PageHeader
        className="mb-6 sm:items-center"
        title="Rule Matches"
        description="Media items that match your lifecycle rules, grouped by rule set."
        actions={
          <>
          <div className="flex items-center gap-1 rounded-lg border p-1 h-9">
            <button
              onClick={() => handleViewModeChange("cards")}
              className={cn(
                "rounded-md p-1.5 transition-colors",
                viewMode === "cards"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              title="Card view"
              aria-label="Card view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              onClick={() => handleViewModeChange("table")}
              className={cn(
                "rounded-md p-1.5 transition-colors",
                viewMode === "table"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              title="Table view"
              aria-label="Table view"
            >
              <TableProperties className="h-4 w-4" />
            </button>
          </div>
          {viewMode === "cards" && (
            <>
              <CardSizeControl size={size} onChange={setSize} />
              <CardDisplayControl
                prefs={prefs}
                config={TOGGLE_CONFIGS.MOVIE}
                onToggle={(section, key, visible) => setVisible(section, key, visible)}
              />
            </>
          )}
          {viewMode === "table" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="default">
                  <Columns3 className="mr-1.5 h-3.5 w-3.5" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 max-w-[calc(100vw-2rem)]">
                {ALL_MATCH_COLUMNS.filter((col) => !col.alwaysVisible).map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={columnVisibility[col.id]}
                    onCheckedChange={(checked) => toggleColumn(col.id, !!checked)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {col.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <LoadingButton
                variant="outline"
                onClick={reEvalAllRules}
                loading={reEvalRunning}
                icon={RefreshCw}
              >
                {reEvalRunning ? "Re-evaluating..." : "Re-evaluate All"}
              </LoadingButton>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              Clear all existing matches and re-evaluate from scratch. Items that no longer match will be removed.
            </TooltipContent>
          </Tooltip>
          </>
        }
      />

      <IntegrationUnreachableBanner
        health={integrationsHealth}
        hasArrRules={arrInstanceIds.length > 0}
        hasSeerrRules={false}
        arrInstanceIds={arrInstanceIds}
        subjectLabel="Some matched rule sets"
      />

      <TabNav tabs={LIFECYCLE_MEDIA_TYPE_TABS} activeTab={mediaTypeTab} onTabChange={setMediaTypeTab} className="mb-6 mt-6" />

      {filteredRuleMatches.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="No enabled rule sets"
          description="Create and enable a rule set to start matching media."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/lifecycle/rules">Manage Rules</Link>
            </Button>
          }
        />
      )}

      <div className="space-y-4">
        {filteredRuleMatches.map((match) => {
          const isExpanded = expandedRules.has(match.ruleSet.id);
          const running = runningRules.has(match.ruleSet.id);

          return (
            <RuleSetGroupCard
              key={match.ruleSet.id}
              ruleSet={match.ruleSet}
              countLabel={`${match.count} match${match.count !== 1 ? "es" : ""}`}
              expanded={isExpanded}
              onToggle={() => toggleExpand(match.ruleSet.id)}
              showAction={match.ruleSet.actionEnabled}
              meta={match.ruleSet.collectionName && (
                <span className="text-xs text-sky">
                  Collection: {match.ruleSet.collectionName}
                </span>
              )}
              actions={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <LoadingButton
                      size="sm"
                      variant="outline"
                      onClick={() => runRule(match.ruleSet.id)}
                      loading={running}
                      disabled={reEvalRunning}
                      icon={RefreshCw}
                    >
                      {running ? "Re-evaluating..." : "Re-evaluate"}
                    </LoadingButton>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Clear matches and re-evaluate from scratch. Items that no longer match will be removed.
                  </TooltipContent>
                </Tooltip>
              }
            >
              {match.items.length > 0 ? (
                <MatchItemsView
                  viewMode={viewMode}
                  items={match.items}
                  ruleSet={match.ruleSet}
                  onItemClick={openDetailPanel}
                  onExclude={excludeItem}
                  excludingItems={excludingItems}
                  exceptedItemIds={exceptedItemIds}
                  getHex={getHex}
                  show={show}
                  columnVisibility={columnVisibility}
                />
              ) : (
                <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                  <Inbox className="h-4 w-4" />
                  No matches yet. Click &ldquo;Re-evaluate&rdquo; to search.
                </p>
              )}
            </RuleSetGroupCard>
          );
        })}
      </div>

        </div>
      </div>


      {detailPanel.panelProps && <MediaDetailSidePanel {...detailPanel.panelProps} />}

      <ExcludeReasonDialog
        itemLabel={excludePromptItem ? matchTitle(excludePromptItem, "—") : null}
        onCancel={() => setExcludePromptItem(null)}
        onConfirm={(reason) => {
          const item = excludePromptItem;
          setExcludePromptItem(null);
          if (item) void confirmExclude(item, reason);
        }}
      />
    </TooltipProvider>
  );
}
