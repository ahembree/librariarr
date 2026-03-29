"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useColumnResize } from "@/hooks/use-column-resize";
import { usePanelResize } from "@/hooks/use-panel-resize";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MediaCard } from "@/components/media-card";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine } from "@/components/metadata-line";
import { useChipColors } from "@/components/chip-color-provider";
import { type ChipColorCategory } from "@/lib/theme/chip-colors";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { formatFileSize, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MediaItemWithRelations } from "@/lib/types";
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  LayoutGrid,
  TableProperties,
  Columns3,
  ShieldOff,
  Film,
  Tv,
  Music,
} from "lucide-react";
import { TabNav, type TabNavItem } from "@/components/tab-nav";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRealtime } from "@/hooks/use-realtime";

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
    addImportExclusion: boolean;
    searchAfterDelete: boolean;
    addArrTags: string[];
    removeArrTags: string[];
    collectionEnabled: boolean;
    collectionName: string | null;
  };
  items: MatchedMediaItem[];
  count: number;
}

function formatResolution(resolution: string | null): string {
  if (!resolution) return "";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

interface MatchItemsViewProps {
  items: MatchedMediaItem[];
  ruleSet: RuleSetMatch["ruleSet"];
  onItemClick: (item: MediaItemWithRelations) => void;
  onExclude: (item: MatchedMediaItem) => void;
  excludingItems: Set<string>;
  exceptedItemIds: Set<string>;
  getSolidStyle: (category: ChipColorCategory, value: string) => React.CSSProperties;
  show: (section: "badges" | "metadata", key: string) => boolean;
  columnVisibility: Record<string, boolean>;
}

const GAP = 16;

interface MatchColumnDef {
  id: string;
  label: string;
  defaultWidth: number;
  alwaysVisible?: boolean;
  defaultVisible?: boolean;
}

const ALL_MATCH_COLUMNS: MatchColumnDef[] = [
  { id: "title", label: "Title", defaultWidth: 240, alwaysVisible: true },
  { id: "matchDate", label: "Match Date", defaultWidth: 130, defaultVisible: true },
  { id: "matchedCriteria", label: "Matched Criteria", defaultWidth: 280, defaultVisible: true },
  { id: "action", label: "", defaultWidth: 100, alwaysVisible: true },
];

const MATCH_COLUMN_STORAGE_KEY = "match-table-column-visibility";

function getDefaultMatchColumnVisibility(): Record<string, boolean> {
  const vis: Record<string, boolean> = {};
  for (const col of ALL_MATCH_COLUMNS) {
    vis[col.id] = col.alwaysVisible || col.defaultVisible || false;
  }
  return vis;
}

function loadMatchColumnVisibility(): Record<string, boolean> {
  const defaults = getDefaultMatchColumnVisibility();
  try {
    const stored = localStorage.getItem(MATCH_COLUMN_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, boolean>;
      // Merge: use stored values for known columns, defaults for new ones
      for (const col of ALL_MATCH_COLUMNS) {
        if (col.id in parsed && !col.alwaysVisible) {
          defaults[col.id] = parsed[col.id];
        }
      }
    }
  } catch {
    // use defaults
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
      <Badge
        key={idx}
        variant="outline"
        className="text-[11px] font-normal px-1.5 py-0"
      >
        {c.groupName && (
          <span className="text-blue-400 mr-0.5">[{c.groupName}]</span>
        )}
        {c.negate && (
          <span className="text-red-400 mr-0.5">NOT</span>
        )}
        <span className="text-muted-foreground">{c.field}</span>
        {" "}
        <span>{c.operator}</span>
        {" "}
        <span className="font-medium">{c.value}</span>
      </Badge>
    );
    if (c.actualValue) {
      return (
        <TooltipProvider key={idx}>
          <Tooltip>
            <TooltipTrigger asChild>{badge}</TooltipTrigger>
            <TooltipContent>Actual: {c.actualValue}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
    <div ref={scrollContainerRef} className="md:max-h-[60vh] overflow-y-auto rounded-lg border">
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

            return (
              <tr
                key={item.id}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="border-b last:border-0 hover:bg-muted/30"
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
              >
                {columnVisibility.title && (
                  <td
                    className="px-4 py-2 cursor-pointer overflow-hidden text-ellipsis"
                    style={{ width: columnWidths.title }}
                    onClick={() => onItemClick(item)}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {exceptedItemIds.has(item.id) && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <ShieldOff className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                            </TooltipTrigger>
                            <TooltipContent>Excluded from lifecycle actions</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
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
          })}
        </tbody>
      </table>
    </div>
  );
}

function MatchItemsCardView({
  items,
  ruleSet,
  onItemClick,
  onExclude,
  excludingItems,
  exceptedItemIds,
  getSolidStyle,
  show,
}: MatchItemsViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { columns: actualColumns } = useCardSize();

  const rowCount = useMemo(
    () => (items.length > 0 ? Math.ceil(items.length / actualColumns) : 0),
    [items.length, actualColumns],
  );

  const estimateSize = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return 350;
    const containerWidth = container.offsetWidth;
    const columnWidth = (containerWidth - GAP * (actualColumns - 1)) / actualColumns;
    const posterHeight = columnWidth * (ruleSet.type === "MUSIC" ? 1 : 1.5);
    return Math.round(posterHeight + 80 + GAP);
  }, [actualColumns, ruleSet.type]);

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

  const fallbackIcon = ruleSet.type === "MOVIE" ? "movie" as const
    : ruleSet.type === "MUSIC" ? "music" as const
    : "series" as const;
  const aspectRatio = ruleSet.type === "MUSIC" ? "square" as const : "poster" as const;

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
          const rowItems = items.slice(rowStart, rowStart + actualColumns);
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
                paddingBottom: GAP,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gap: `${GAP}px`,
                  gridTemplateColumns: `repeat(${actualColumns}, minmax(0, 1fr))`,
                }}
              >
                {rowItems.map((item) => {
                  return (
                    <div key={item.id} className="relative group">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              className="absolute top-2 right-2 z-20 h-7 w-7 rounded-md bg-background/80 backdrop-blur-sm flex items-center justify-center text-muted-foreground hover:text-orange-400 hover:bg-background/90 transition-all opacity-0 group-hover:opacity-100 disabled:opacity-50"
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
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Exclude from lifecycle actions</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      {exceptedItemIds.has(item.id) && (
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
                        imageUrl={`/api/media/${item.id}/image${ruleSet.type !== "MOVIE" ? "?type=parent" : ""}`}
                        title={item.parentTitle
                          ? `${item.parentTitle} - ${item.title}`
                          : item.title}
                        fallbackIcon={fallbackIcon}
                        aspectRatio={aspectRatio}
                        onClick={() => onItemClick(item)}
                        metadata={
                          <MetadataLine>
                            {show("metadata", "year") && item.year && <span>{item.year}</span>}
                            {show("metadata", "duration") && formatDuration(item.duration) && <span>{formatDuration(item.duration)}</span>}
                            {show("metadata", "fileSize") && formatFileSize(item.fileSize) && <span>{formatFileSize(item.fileSize)}</span>}
                          </MetadataLine>
                        }
                        badges={
                          <>
                            {show("badges", "resolution") && item.resolution && (
                              <Badge
                                className="text-[10px] px-1.5 py-0"
                                style={getSolidStyle("resolution", formatResolution(item.resolution))}
                              >
                                {formatResolution(item.resolution)}
                              </Badge>
                            )}
                            {show("badges", "dynamicRange") && item.dynamicRange && item.dynamicRange !== "SDR" && (
                              <Badge
                                className="text-[10px] px-1.5 py-0"
                                style={getSolidStyle("dynamicRange", item.dynamicRange)}
                              >
                                {item.dynamicRange}
                              </Badge>
                            )}
                            {item.matchedCriteria && item.matchedCriteria.length > 0 && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {item.matchedCriteria.length} {item.matchedCriteria.length === 1 ? "match" : "matches"}
                              </Badge>
                            )}
                          </>
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

function MatchItemsView({
  viewMode,
  ...props
}: MatchItemsViewProps & { viewMode: "cards" | "table" }) {
  if (viewMode === "cards") {
    return <MatchItemsCardView {...props} />;
  }
  return <MatchItemsTableView {...props} />;
}

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

export default function RuleMatchesPage() {
  const [mediaTypeTab, setMediaTypeTab] = useState<MediaTypeTab>("all");
  const { width: panelWidth, resizeHandleProps } = usePanelResize({
    storageKey: "lifecycle-matches-panel-width",
    defaultWidth: 480,
    minWidth: 360,
    maxWidth: 800,
  });
  const [selectedItem, setSelectedItem] = useState<MatchedMediaItem | null>(null);
  const [selectedItemType, setSelectedItemType] = useState<"MOVIE" | "SERIES" | "MUSIC">("MOVIE");
  const [ruleMatches, setRuleMatches] = useState<RuleSetMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"cards" | "table">("table");
  const [runningRules, setRunningRules] = useState<Set<string>>(new Set());
  const [reEvalRunning, setReEvalRunning] = useState(false);
  const { size, setSize } = useCardSize();
  const { getSolidStyle } = useChipColors();
  const { show, setVisible, prefs } = useCardDisplay("MOVIE");
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(getDefaultMatchColumnVisibility);

  const filteredRuleMatches = useMemo(() => {
    const typeFilter = TAB_TO_TYPE[mediaTypeTab];
    if (!typeFilter) return ruleMatches;
    return ruleMatches.filter((m) => m.ruleSet.type === typeFilter);
  }, [ruleMatches, mediaTypeTab]);

  // Load column visibility from localStorage on mount
  useEffect(() => {
    setColumnVisibility(loadMatchColumnVisibility());
  }, []);

  const toggleColumn = useCallback((colId: string, checked: boolean) => {
    setColumnVisibility((prev) => {
      const next = { ...prev, [colId]: checked };
      localStorage.setItem(MATCH_COLUMN_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("matches-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("matches-view-mode", mode);
  };

  const fetchMatches = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/lifecycle/rules/matches");
      const data = await response.json();
      setRuleMatches(data.ruleMatches || []);
    } catch (error) {
      console.error("Failed to fetch matches:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useRealtime("lifecycle:detection-completed", fetchMatches);

  useEffect(() => {
    fetchMatches();
  }, [fetchMatches]);

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

  const [excludingItems, setExcludingItems] = useState<Set<string>>(new Set());

  const excludeItem = useCallback(async (item: MatchedMediaItem) => {
    setExcludingItems((prev) => new Set(prev).add(item.id));
    try {
      const response = await fetch("/api/lifecycle/exceptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaItemId: item.id }),
      });
      if (response.ok) {
        // Add to excepted set and remove item from matches in UI
        setExceptedItemIds((prev) => new Set(prev).add(item.id));
        setRuleMatches((prev) =>
          prev.map((match) => {
            const filtered = match.items.filter((i) => i.id !== item.id);
            return { ...match, items: filtered, count: filtered.length };
          })
        );
      }
    } catch (error) {
      console.error("Failed to exclude item:", error);
    } finally {
      setExcludingItems((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }, []);

  const runRule = useCallback(async (ruleSetId: string, fullReEval = false) => {
    setRunningRules((prev) => new Set(prev).add(ruleSetId));
    try {
      const response = await fetch("/api/lifecycle/rules/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleSetId, fullReEval }),
      });
      const data = await response.json();
      if (data.ruleMatches) {
        setRuleMatches((prev) => {
          const updated = data.ruleMatches as RuleSetMatch[];
          const updatedMap = new Map(updated.map((m) => [m.ruleSet.id, m]));
          return prev.map((m) => {
            if (m.ruleSet.id === ruleSetId) {
              return updatedMap.get(ruleSetId) ?? { ...m, items: [], count: 0 };
            }
            return m;
          });
        });
      }
    } catch (error) {
      console.error("Failed to run rule:", error);
    } finally {
      setRunningRules((prev) => {
        const next = new Set(prev);
        next.delete(ruleSetId);
        return next;
      });
    }
  }, []);

  const reEvalAllRules = useCallback(async () => {
    setReEvalRunning(true);
    try {
      const response = await fetch("/api/lifecycle/rules/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullReEval: true }),
      });
      const data = await response.json();
      if (data.ruleMatches) {
        const updated = data.ruleMatches as RuleSetMatch[];
        const updatedMap = new Map(updated.map((m) => [m.ruleSet.id, m]));
        setRuleMatches((prev) =>
          prev.map((m) => updatedMap.get(m.ruleSet.id) ?? { ...m, items: [], count: 0 })
        );
      }
    } catch (error) {
      console.error("Failed to re-evaluate all rules:", error);
    } finally {
      setReEvalRunning(false);
    }
  }, []);

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

  const formatActionType = (type: string | null) => {
    if (!type) return "None";
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
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex md:h-full">
      <div className="flex-1 min-w-0 md:overflow-y-auto">
        <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Rule Matches</h1>
          <p className="text-muted-foreground mt-1">Media items that match your lifecycle rules, grouped by rule set.</p>
        </div>
        <div className="flex items-center gap-3">
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
                <Button variant="outline" size="sm">
                  <Columns3 className="mr-1.5 h-3.5 w-3.5" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
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
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={reEvalAllRules}
                  disabled={reEvalRunning || loading}
                >
                  {reEvalRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  {reEvalRunning ? "Re-evaluating..." : "Re-evaluate All"}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Clear all existing matches and re-evaluate from scratch. Items that no longer match will be removed.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <TabNav tabs={MEDIA_TYPE_TABS} activeTab={mediaTypeTab} onTabChange={setMediaTypeTab} className="mb-6" />

      {filteredRuleMatches.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No enabled rule sets found. Create and enable a rule set to start matching media.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {filteredRuleMatches.map((match) => {
          const isExpanded = expandedRules.has(match.ruleSet.id);

          return (
            <Card key={match.ruleSet.id}>
              <CardHeader
                className="cursor-pointer"
                onClick={() => toggleExpand(match.ruleSet.id)}
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
                        {match.ruleSet.name}
                      </CardTitle>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline">
                          {match.ruleSet.type === "MOVIE" ? "Movie" : match.ruleSet.type === "MUSIC" ? "Music" : "Series"}
                        </Badge>
                        <Badge variant="secondary">
                          {match.count} match{match.count !== 1 && "es"}
                        </Badge>
                        {match.ruleSet.actionEnabled && (
                          <span className="text-xs text-muted-foreground">
                            Action: {formatActionType(match.ruleSet.actionType)}
                          </span>
                        )}
                        {(match.ruleSet.addArrTags?.length > 0 || match.ruleSet.removeArrTags?.length > 0) && (
                          <div className="flex flex-wrap gap-1">
                            {match.ruleSet.addArrTags?.map((tag) => (
                              <Badge
                                key={`add-${tag}`}
                                className="text-[10px] bg-green-500/20 text-green-400 border-green-500/30"
                              >
                                +{tag}
                              </Badge>
                            ))}
                            {match.ruleSet.removeArrTags?.map((tag) => (
                              <Badge
                                key={`rm-${tag}`}
                                className="text-[10px] bg-red-500/20 text-red-400 border-red-500/30"
                              >
                                -{tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {match.ruleSet.collectionEnabled && match.ruleSet.collectionName && (
                          <span className="text-xs text-blue-400">
                            Collection: {match.ruleSet.collectionName}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div
                    className="flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => runRule(match.ruleSet.id, true)}
                            disabled={runningRules.has(match.ruleSet.id) || reEvalRunning}
                          >
                            {runningRules.has(match.ruleSet.id) ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            {runningRules.has(match.ruleSet.id) ? "Re-evaluating..." : "Re-evaluate"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          Clear matches and re-evaluate from scratch. Items that no longer match will be removed.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              </CardHeader>

              {isExpanded && match.items.length > 0 && (
                <CardContent>
                  <MatchItemsView
                    viewMode={viewMode}
                    items={match.items}
                    ruleSet={match.ruleSet}
                    onItemClick={(item) => {
                      setSelectedItem(item);
                      setSelectedItemType(match.ruleSet.type as "MOVIE" | "SERIES" | "MUSIC");
                    }}
                    onExclude={excludeItem}
                    excludingItems={excludingItems}
                    exceptedItemIds={exceptedItemIds}
                    getSolidStyle={getSolidStyle}
                    show={show}
                    columnVisibility={columnVisibility}
                  />
                </CardContent>
              )}

              {isExpanded && match.items.length === 0 && (
                <CardContent>
                  <p className="text-center text-muted-foreground py-4">
                    No matches yet. Click &quot;Re-evaluate&quot; to search.
                  </p>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>

        </div>
      </div>


      {selectedItem && (
        <MediaDetailSidePanel
          item={selectedItem}
          mediaType={selectedItemType}
          onClose={() => setSelectedItem(null)}
          width={panelWidth}
          resizeHandleProps={resizeHandleProps}
          matchedCriteria={selectedItem.matchedCriteria}
          allActualValues={selectedItem.actualValues}
        />
      )}
    </div>
  );
}
