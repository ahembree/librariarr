"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RuleBuilder, ruleBuilderConfig, countAllRules, validateAllRules } from "@/components/rule-builder";
import { BuilderWithPseudocode } from "@/components/builder/builder-with-pseudocode";
import { MediaTable } from "@/components/media-table";
import { MediaDetailSidePanel, type MatchedCriterion } from "@/components/media-detail-side-panel";
import { usePanelResize } from "@/hooks/use-panel-resize";
import type { Rule, RuleGroup } from "@/lib/rules/types";
import type { MediaItemWithRelations } from "@/lib/types";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
import { Loader2, Save, Eye, Trash2, FileText, Upload, ClipboardPaste, Copy, Check, ChevronsUpDown, X, FlaskConical, Search, LayoutGrid, TableProperties, ShieldOff, Calendar, Clock, HardDrive } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Badge } from "@/components/ui/badge";
import { PseudocodePanel } from "@/components/builder/pseudocode-panel";
import { MediaCard } from "@/components/media-card";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { useChipColors } from "@/components/chip-color-provider";
import type { ChipColorCategory } from "@/lib/theme/chip-colors";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { formatFileSize, formatDuration } from "@/lib/format";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, generateId } from "@/lib/utils";

interface PreviewItem extends MediaItemWithRelations {
  matchedCriteria?: MatchedCriterion[];
  actualValues?: Record<string, string>;
}

interface DiffItem {
  id: string;
  title: string;
  parentTitle: string | null;
}

interface DiffData {
  added: DiffItem[];
  removed: DiffItem[];
  retained: DiffItem[];
  counts: { added: number; removed: number; retained: number };
}

interface RuleSetSnapshot {
  name: string;
  groups: string;
  enabled: boolean;
  seriesScope: boolean;
  actionEnabled: boolean;
  actionType: string;
  actionDelayDays: number;
  arrInstanceId: string;
  addImportExclusion: boolean;
  searchAfterDelete: boolean;
  addArrTags: string;
  removeArrTags: string;
  collectionEnabled: boolean;
  collectionName: string;
  collectionSortName: string;
  collectionHomeScreen: boolean;
  collectionRecommended: boolean;
  collectionSort: string;
  discordNotifyOnAction: boolean;
  discordNotifyOnMatch: boolean;
  stickyMatches: boolean;
  serverIds: string;
}

interface SavedRuleSet {
  id: string;
  name: string;
  type: string;
  rules: Rule[] | RuleGroup[];
  enabled: boolean;
  seriesScope?: boolean;
  actionEnabled: boolean;
  actionType: string | null;
  actionDelayDays: number;
  arrInstanceId: string | null;
  addImportExclusion: boolean;
  searchAfterDelete?: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  collectionEnabled: boolean;
  collectionName: string | null;
  collectionSortName: string | null;
  collectionHomeScreen: boolean;
  collectionRecommended: boolean;
  collectionSort: string;
  discordNotifyOnAction: boolean;
  discordNotifyOnMatch?: boolean;
  stickyMatches?: boolean;
  serverIds: string[];
  createdAt: string;
}

function legacyToGroups(rules: Rule[] | RuleGroup[]): RuleGroup[] {
  if (rules.length === 0) return [];
  if ("rules" in rules[0]) {
    return (rules as RuleGroup[]).map((g) => ({
      ...g,
      groups: g.groups ?? [],
    }));
  }
  const flat = rules as Rule[];
  const groups: RuleGroup[] = [
    { id: generateId(), condition: "AND", rules: [], groups: [] },
  ];
  for (let i = 0; i < flat.length; i++) {
    groups[groups.length - 1].rules.push(flat[i]);
    if (i < flat.length - 1 && flat[i].condition === "AND") {
      groups.push({ id: generateId(), condition: "AND", rules: [], groups: [] });
    }
  }
  return groups;
}

function countRules(rules: Rule[] | RuleGroup[]): number {
  if (rules.length === 0) return 0;
  if ("rules" in rules[0]) {
    return countAllRules(rules as RuleGroup[]);
  }
  return rules.length;
}

interface ArrInstance {
  id: string;
  name: string;
  url: string;
}

interface RuleSetExport {
  version: 1;
  type: string;
  name: string;
  rules: RuleGroup[];
  seriesScope?: boolean;
  enabled: boolean;
  actionEnabled: boolean;
  actionType: string | null;
  actionDelayDays: number;
  addImportExclusion: boolean;
  searchAfterDelete?: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  collectionEnabled: boolean;
  collectionName: string | null;
  collectionSortName: string | null;
  collectionHomeScreen: boolean;
  collectionRecommended: boolean;
  collectionSort?: string;
  discordNotifyOnAction?: boolean;
  discordNotifyOnMatch?: boolean;
  stickyMatches?: boolean;
  serverIds?: string[];
}

interface MediaServer {
  id: string;
  name: string;
}

interface ScopeConfig {
  id: string;
  label: string;
  enabledDescription: string;
  disabledDescription: string;
  ruleSetEnabledLabel: string;
  ruleSetDisabledLabel: string;
}

interface ActionTypeOption {
  value: string;
  label: string;
}

export interface LifecycleRulePageProps {
  mediaType: "MOVIE" | "SERIES" | "MUSIC";
  pageTitle: string;
  ruleDescription: string;
  arrServiceName: string;
  arrApiPath: string;
  defaultActionType: string;
  actionTypes: ActionTypeOption[];
  importErrorMessage: string;
  scopeConfig?: ScopeConfig;
  /** When true, skips outer padding and page title (used when embedded in the unified rules page) */
  embedded?: boolean;
}

function formatResolution(resolution: string | null): string {
  if (!resolution) return "";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

const CARD_GAP = 16;
const CARD_CONTENT_HEIGHT = 138;
const CARD_QUALITY_BAR_HEIGHT = 4;
const CARD_BORDER = 2;

function DiffSection({
  label,
  count,
  items,
  color,
  bgColor,
  note,
  expanded,
  onToggle,
}: {
  label: string;
  count: number;
  items: DiffItem[];
  color: string;
  bgColor: string;
  note?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className={`rounded-md border p-3 ${bgColor}`}>
      <button
        type="button"
        className="flex items-center justify-between w-full text-left"
        onClick={onToggle}
      >
        <span className={`text-sm font-medium ${color}`}>
          {label} ({count})
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {items.map((item) => (
            <p key={item.id} className="text-sm text-muted-foreground truncate">
              {item.parentTitle ?? item.title}
            </p>
          ))}
          {note && (
            <p className="text-xs text-muted-foreground/70 italic mt-2">{note}</p>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewCardGrid({
  items,
  mediaType,
  onItemClick,
  diffMap,
  exceptedItemIds,
  show,
  getHex,
  showServers,
}: {
  items: PreviewItem[];
  mediaType: "MOVIE" | "SERIES" | "MUSIC";
  onItemClick: (item: PreviewItem) => void;
  diffMap: Map<string, "added" | "removed" | "retained">;
  exceptedItemIds: Set<string>;
  show: (section: "badges" | "metadata", key: string) => boolean;
  getHex: (category: ChipColorCategory, value: string) => string;
  showServers: boolean;
}) {
  const cardContainerRef = useRef<HTMLDivElement>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const { columns: actualColumns } = useCardSize();
  const [scrollMargin, setScrollMargin] = useState(0);

  const rowCount = useMemo(
    () => (items.length > 0 ? Math.ceil(items.length / actualColumns) : 0),
    [items.length, actualColumns],
  );

  // Find scrollable ancestor on mount
  useLayoutEffect(() => {
    let el = cardContainerRef.current?.parentElement ?? null;
    while (el) {
      const style = getComputedStyle(el);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        scrollElementRef.current = el;
        break;
      }
      el = el.parentElement;
    }
    if (!scrollElementRef.current) {
      scrollElementRef.current = document.querySelector<HTMLElement>("main");
    }
  }, []);

  useLayoutEffect(() => {
    if (cardContainerRef.current) {
      const scrollEl = scrollElementRef.current;
      const containerEl = cardContainerRef.current;
      if (scrollEl && containerEl) {
        setScrollMargin(Math.round(
          containerEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop,
        ));
      }
    }
  }, [items.length]);

  const estimateSize = useCallback(() => {
    const container = cardContainerRef.current;
    if (!container) return 350;
    const containerWidth = container.offsetWidth;
    const columnWidth = (containerWidth - CARD_GAP * (actualColumns - 1)) / actualColumns;
    const posterHeight = columnWidth * (mediaType === "MUSIC" ? 1 : 1.5);
    return Math.round(posterHeight + CARD_QUALITY_BAR_HEIGHT + CARD_CONTENT_HEIGHT + CARD_BORDER + CARD_GAP);
  }, [actualColumns, mediaType]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize,
    overscan: 5,
    scrollMargin,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [actualColumns, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  const fallbackIcon = mediaType === "MOVIE" ? "movie" as const
    : mediaType === "MUSIC" ? "music" as const
    : "series" as const;
  const aspectRatio = mediaType === "MUSIC" ? "square" as const : "poster" as const;

  return (
    <div ref={cardContainerRef}>
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
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                paddingBottom: CARD_GAP,
                transform: `translateY(${virtualRow.start - (virtualizer.options.scrollMargin ?? 0)}px)`,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gap: `${CARD_GAP}px`,
                  gridTemplateColumns: `repeat(${actualColumns}, minmax(0, 1fr))`,
                }}
              >
                {rowItems.map((item) => {
                  const diffStatus = diffMap.get(item.id);
                  const isDiffActive = diffMap.size > 0;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "relative rounded-lg",
                        isDiffActive && diffStatus === "added" && "ring-1 ring-emerald-500/70",
                        isDiffActive && diffStatus === "removed" && "ring-1 ring-amber-500/70 opacity-60",
                      )}
                    >
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
                        imageUrl={`/api/media/${item.id}/image${mediaType !== "MOVIE" ? "?type=parent" : ""}`}
                        title={item.parentTitle
                          ? `${item.parentTitle} - ${item.title}`
                          : item.title}
                        fallbackIcon={fallbackIcon}
                        aspectRatio={aspectRatio}
                        onClick={() => onItemClick(item)}
                        metadata={
                          <MetadataLine stacked>
                            {show("metadata", "year") && item.year && <MetadataItem icon={<Calendar />}>{item.year}</MetadataItem>}
                            {show("metadata", "duration") && formatDuration(item.duration) && <MetadataItem icon={<Clock />}>{formatDuration(item.duration)}</MetadataItem>}
                            {show("metadata", "fileSize") && formatFileSize(item.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(item.fileSize)}</MetadataItem>}
                          </MetadataLine>
                        }
                        qualityBar={
                          show("badges", "resolution") || show("badges", "dynamicRange") || show("badges", "audioProfile")
                            ? [
                                ...(show("badges", "resolution") && item.resolution
                                  ? [{ color: getHex("resolution", formatResolution(item.resolution)), weight: 1, label: formatResolution(item.resolution) }]
                                  : []),
                                ...(show("badges", "dynamicRange") && item.dynamicRange && item.dynamicRange !== "SDR"
                                  ? [{ color: getHex("dynamicRange", item.dynamicRange), weight: 1, label: item.dynamicRange }]
                                  : []),
                                ...(show("badges", "audioProfile") && item.audioProfile
                                  ? [{ color: getHex("audioProfile", item.audioProfile), weight: 1, label: item.audioProfile }]
                                  : []),
                              ]
                            : undefined
                        }
                        servers={showServers ? item.servers : undefined}
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

export function LifecycleRulePage({
  mediaType,
  pageTitle,
  ruleDescription,
  arrServiceName,
  arrApiPath,
  defaultActionType,
  actionTypes,
  importErrorMessage,
  scopeConfig,
  embedded,
}: LifecycleRulePageProps) {
  const { width: panelWidth, resizeHandleProps } = usePanelResize({
    storageKey: "lifecycle-rule-panel-width",
    defaultWidth: 480,
    minWidth: 360,
    maxWidth: 800,
  });
  const [selectedItem, setSelectedItem] = useState<PreviewItem | null>(null);
  const [name, setName] = useState("");
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [exportJson, setExportJson] = useState("");
  const [copied, setCopied] = useState(false);
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  const [savedRuleSets, setSavedRuleSets] = useState<SavedRuleSet[]>([]);
  const [activeRuleSetId, setActiveRuleSetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [previewSortBy, setPreviewSortBy] = useState<string | undefined>("title");
  const [previewSortOrder, setPreviewSortOrder] = useState<"asc" | "desc">("asc");

  // Preview view mode (cards/table)
  const [previewViewMode, setPreviewViewMode] = useState<"cards" | "table">(() => {
    if (typeof window === "undefined") return "table";
    return (localStorage.getItem("lifecycle-preview-view-mode") as "cards" | "table") ?? "table";
  });
  const handlePreviewViewModeChange = useCallback((mode: "cards" | "table") => {
    const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
    setPreviewViewMode(mode);
    localStorage.setItem("lifecycle-preview-view-mode", mode);
    requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: scrollTop, behavior: "instant" });
    });
  }, []);
  const { size: cardSize, setSize: setCardSize } = useCardSize();
  const { show: showCardField, showServers, setVisible: setCardFieldVisible, prefs: cardPrefs } = useCardDisplay(
    mediaType === "MUSIC" ? "MUSIC" : mediaType === "SERIES" ? "SERIES" : "MOVIE",
  );
  const { getHex } = useChipColors();

  // Exception tracking for preview indicator
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
  useEffect(() => { fetchExceptions(); }, [fetchExceptions]);
  const [distinctValues, setDistinctValues] = useState<
    Record<string, string[]>
  >({});

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleteConfirmHasCollection, setDeleteConfirmHasCollection] = useState(false);
  const [deleteConfirmAddTags, setDeleteConfirmAddTags] = useState<string[]>([]);
  const [deleteConfirmCleanupTags, setDeleteConfirmCleanupTags] = useState(false);

  // Rule set enabled
  const [enabled, setEnabled] = useState(true);

  // Scope (series/music only)
  const [seriesScope, setSeriesScope] = useState(true);

  // Action config
  const [actionEnabled, setActionEnabled] = useState(false);
  const [actionType, setActionType] = useState<string>(defaultActionType);
  const [actionDelayDays, setActionDelayDays] = useState(7);
  const [arrInstanceId, setArrInstanceId] = useState<string>("");
  const [addImportExclusion, setAddImportExclusion] = useState(false);
  const [searchAfterDelete, setSearchAfterDelete] = useState(false);
  const [addArrTags, setAddArrTags] = useState<string[]>([]);
  const [removeArrTags, setRemoveArrTags] = useState<string[]>([]);
  const [manageTagsEnabled, setManageTagsEnabled] = useState(false);
  const [tagMode, setTagMode] = useState<"add" | "remove">("add");
  const [arrInstances, setArrInstances] = useState<ArrInstance[]>([]);
  const [seerrConnected, setSeerrConnected] = useState(false);

  // Collection config
  const [collectionEnabled, setCollectionEnabled] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [collectionSortName, setCollectionSortName] = useState("");
  const [collectionHomeScreen, setCollectionHomeScreen] = useState(false);
  const [collectionRecommended, setCollectionRecommended] = useState(false);
  const [collectionSort, setCollectionSort] = useState("ALPHABETICAL");

  // Discord notification
  const [discordNotifyOnAction, setDiscordNotifyOnAction] = useState(false);
  const [discordNotifyOnMatch, setDiscordNotifyOnMatch] = useState(false);

  // Match behavior
  const [stickyMatches, setStickyMatches] = useState(false);

  // Server selection
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [servers, setServers] = useState<MediaServer[]>([]);
  const [serverPopoverOpen, setServerPopoverOpen] = useState(false);

  // Router for navigation
  const router = useRouter();

  // Dirty tracking — snapshot of last-saved/loaded state
  const snapshotRef = useRef<RuleSetSnapshot | null>(null);
  const [snapshotVersion, setSnapshotVersion] = useState(0);

  const updateSnapshot = useCallback((snap: RuleSetSnapshot | null) => {
    snapshotRef.current = snap;
    setSnapshotVersion((v) => v + 1);
  }, []);

  const isDirty = useMemo(() => {
    void snapshotVersion; // dependency to recompute when snapshot changes
    const snap = snapshotRef.current;
    if (!snap) return true; // New rule set — always allow saving
    return (
      snap.name !== name ||
      snap.groups !== JSON.stringify(groups) ||
      snap.enabled !== enabled ||
      snap.seriesScope !== seriesScope ||
      snap.actionEnabled !== actionEnabled ||
      snap.actionType !== actionType ||
      snap.actionDelayDays !== actionDelayDays ||
      snap.arrInstanceId !== arrInstanceId ||
      snap.addImportExclusion !== addImportExclusion ||
      snap.searchAfterDelete !== searchAfterDelete ||
      snap.addArrTags !== JSON.stringify([...addArrTags].sort()) ||
      snap.removeArrTags !== JSON.stringify([...removeArrTags].sort()) ||
      snap.collectionEnabled !== collectionEnabled ||
      snap.collectionName !== collectionName ||
      snap.collectionSortName !== collectionSortName ||
      snap.collectionHomeScreen !== collectionHomeScreen ||
      snap.collectionRecommended !== collectionRecommended ||
      snap.collectionSort !== collectionSort ||
      snap.discordNotifyOnAction !== discordNotifyOnAction ||
      snap.discordNotifyOnMatch !== discordNotifyOnMatch ||
      snap.stickyMatches !== stickyMatches ||
      snap.serverIds !== JSON.stringify([...serverIds].sort())
    );
  }, [
    snapshotVersion,
    name, groups, enabled, seriesScope, actionEnabled, actionType, actionDelayDays,
    arrInstanceId, addImportExclusion, searchAfterDelete, addArrTags, removeArrTags,
    collectionEnabled, collectionName, collectionSortName, collectionHomeScreen,
    collectionRecommended, collectionSort, discordNotifyOnAction, discordNotifyOnMatch, stickyMatches, serverIds,
  ]);

  // Whether rule logic (rules/scope/servers) changed vs only config fields
  const rulesChanged = useMemo(() => {
    void snapshotVersion;
    const snap = snapshotRef.current;
    if (!snap) return true;
    return (
      snap.groups !== JSON.stringify(groups) ||
      snap.seriesScope !== seriesScope ||
      snap.serverIds !== JSON.stringify([...serverIds].sort())
    );
  }, [snapshotVersion, groups, seriesScope, serverIds]);

  // Post-save match search prompt
  const [showSaveOptions, setShowSaveOptions] = useState(false);
  const [showNewSaveOptions, setShowNewSaveOptions] = useState(false);
  const [savingWithOption, setSavingWithOption] = useState(false);

  // Reschedule pending actions prompt (when actionDelayDays changes)
  const [showRescheduleDialog, setShowRescheduleDialog] = useState(false);
  const [rescheduleOldDelay, setRescheduleOldDelay] = useState(0);
  const [rescheduleNewDelay, setRescheduleNewDelay] = useState(0);

  // Diff preview before re-detect
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [showDiffDialog, setShowDiffDialog] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState<Record<string, boolean>>({});

  // Preview diff highlighting
  const [previewDiffMap, setPreviewDiffMap] = useState<Map<string, "added" | "removed" | "retained">>(new Map());
  const [previewDiffCounts, setPreviewDiffCounts] = useState<{ added: number; removed: number; retained: number } | null>(null);

  // Ref to the scroll container to preserve scroll position across re-renders
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Track previous collection state for Plex diff on save
  const prevCollectionRef = useRef<{
    enabled: boolean;
    name: string | null;
  }>({ enabled: false, name: null });
  const [skipCollectionRemoval, setSkipCollectionRemoval] = useState(false);
  const [showCollectionDisableDialog, setShowCollectionDisableDialog] = useState(false);

  // Test Media
  const [showTestMediaDialog, setShowTestMediaDialog] = useState(false);
  const [testMediaSearch, setTestMediaSearch] = useState("");
  const [testMediaResults, setTestMediaResults] = useState<Array<{ id: string; title: string; parentTitle?: string | null; year?: number | null; thumbUrl?: string | null; type: string }>>([]);
  const [testMediaSearching, setTestMediaSearching] = useState(false);
  const [testMediaSelected, setTestMediaSelected] = useState<{ id: string; title: string; parentTitle?: string | null; year?: number | null } | null>(null);
  const [testMediaEvaluating, setTestMediaEvaluating] = useState(false);
  const [testMediaResult, setTestMediaResult] = useState<{ matches: boolean; matchedCriteria: MatchedCriterion[]; actualValues: Record<string, string> } | null>(null);
  const testMediaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchRuleSets();
    fetchArrInstances();
    fetchSeerrInstances();
    fetchDistinctValues();
    fetchServers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear selected item when preview results change
  useEffect(() => {
    setSelectedItem(null);
  }, [preview]);

  useEffect(() => {
    if (arrInstanceId) {
      fetchArrMetadata(arrInstanceId);
    } else {
      setDistinctValues((prev) => ({ ...prev, arrTag: [], arrQualityProfile: [] }));
      setManageTagsEnabled(false);
      setAddArrTags([]);
      setRemoveArrTags([]);
      // Reset action type to DO_NOTHING since other actions require an Arr server
      if (actionType !== "DO_NOTHING") {
        setActionType("DO_NOTHING");
      }
    }
  }, [arrInstanceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchDistinctValues = async () => {
    try {
      const response = await fetch("/api/media/distinct-values");
      const data = await response.json();
      setDistinctValues(data);
    } catch (error) {
      console.error("Failed to fetch distinct values:", error);
    }
  };

  const fetchArrMetadata = async (instanceId: string) => {
    if (!instanceId) return;
    try {
      const res = await fetch(`/api/integrations/${arrApiPath}/${instanceId}/metadata`);
      const data = await res.json();
      setDistinctValues((prev) => ({
        ...prev,
        arrTag: data.tags?.map((t: { label: string }) => t.label) ?? [],
        arrQualityProfile: data.qualityProfiles?.map((p: { name: string }) => p.name) ?? [],
        arrOriginalLanguage: data.languages ?? [],
      }));
    } catch {
      // Silent failure
    }
  };

  const fetchRuleSets = async () => {
    try {
      const response = await fetch("/api/lifecycle/rules");
      const data = await response.json();
      setSavedRuleSets(
        data.ruleSets.filter((r: SavedRuleSet) => r.type === mediaType)
      );
    } catch (error) {
      console.error("Failed to fetch rule sets:", error);
    }
  };

  const fetchArrInstances = async () => {
    try {
      const response = await fetch(`/api/integrations/${arrApiPath}`);
      const data = await response.json();
      setArrInstances(data.instances || []);
    } catch (error) {
      console.error(`Failed to fetch ${arrServiceName} instances:`, error);
    }
  };

  const fetchSeerrInstances = async () => {
    if (mediaType === "MUSIC") return;
    try {
      const response = await fetch("/api/integrations/seerr");
      const data = await response.json();
      const instances = data.instances || [];
      setSeerrConnected(instances.length > 0);
      if (instances.length > 0) {
        try {
          const metaRes = await fetch(`/api/integrations/seerr/${instances[0].id}/metadata`);
          const metaData = await metaRes.json();
          setDistinctValues((prev) => ({
            ...prev,
            seerrRequestedBy: metaData.users ?? [],
          }));
        } catch {
          // Silent failure
        }
      }
    } catch {
      // Seerr not configured — leave as false
    }
  };

  const fetchServers = async () => {
    try {
      const response = await fetch("/api/servers");
      const data = await response.json();
      setServers((data.servers || []).map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })));
    } catch (error) {
      console.error("Failed to fetch servers:", error);
    }
  };

  const handleSave = async (options?: { clearMatches?: boolean; runDetection?: boolean; processActions?: boolean }) => {
    if (!name || countAllRules(groups) === 0) return;
    const clearMatches = options?.clearMatches ?? true;
    const runDetection = options?.runDetection ?? false;
    const processActions = options?.processActions ?? false;
    setLoading(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {
        name,
        rules: groups,
        enabled,
        actionEnabled,
        actionType: actionType || null,
        actionDelayDays,
        arrInstanceId: arrInstanceId || null,
        addImportExclusion,
        searchAfterDelete,
        addArrTags,
        removeArrTags,
        collectionEnabled,
        collectionName: collectionName || null,
        collectionSortName: collectionSortName || null,
        collectionHomeScreen,
        collectionRecommended,
        collectionSort,
        discordNotifyOnAction,
        discordNotifyOnMatch,
        stickyMatches,
        serverIds,
      };
      if (scopeConfig) {
        body.seriesScope = seriesScope;
      }

      let response: Response;
      let savedRuleSetId = activeRuleSetId;
      if (activeRuleSetId) {
        const clearParam = clearMatches ? "" : "?clearMatches=false";
        response = await fetch(`/api/lifecycle/rules/${activeRuleSetId}${clearParam}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        response = await fetch("/api/lifecycle/rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, type: mediaType }),
        });
      }

      if (!response.ok) {
        const data = await response.json();
        setSaveError(data.error || "Failed to save rule set");
        return;
      }
      const data = await response.json();
      if (!savedRuleSetId && data.ruleSet?.id) {
        savedRuleSetId = data.ruleSet.id;
        setActiveRuleSetId(savedRuleSetId);
      }
      await fetchRuleSets();

      // Apply Plex collection changes only for disable or rename (not item sync)
      const prev = prevCollectionRef.current;
      const collectionDisabled = prev.enabled && !collectionEnabled;
      const collectionRenamed =
        prev.enabled && collectionEnabled &&
        prev.name !== null && prev.name !== (collectionName || null);
      const collectionChanged = collectionDisabled || collectionRenamed;

      if (collectionChanged && savedRuleSetId) {
        try {
          const applyRes = await fetch("/api/lifecycle/collections/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ruleSetId: savedRuleSetId,
              previousCollectionEnabled: prev.enabled,
              previousCollectionName: prev.name,
              skipCollectionRemoval,
            }),
          });
          const applyData = await applyRes.json();
          if (applyRes.ok) {
            toast.success("Plex Updated", {
              description: applyData.changes?.join(", ") || "Collection synced",
            });
          } else {
            toast.error("Plex Sync Failed", {
              description: applyData.error || "Unknown error",
            });
          }
        } catch (error) {
          toast.error("Plex Sync Failed", {
            description: String(error),
          });
        }
      }

      prevCollectionRef.current = {
        enabled: collectionEnabled,
        name: collectionName || null,
      };
      setSkipCollectionRemoval(false);

      toast.success("Rule set saved");

      // Check if actionDelayDays changed — prompt to reschedule pending actions
      const prevDelay = snapshotRef.current?.actionDelayDays;
      const delayChanged = prevDelay !== undefined && prevDelay !== actionDelayDays && savedRuleSetId;

      updateSnapshot(takeSnapshot());
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);

      // Run detection if requested
      if (runDetection && savedRuleSetId) {
        try {
          await fetch("/api/lifecycle/rules/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ruleSetId: savedRuleSetId, fullReEval: clearMatches, processActions }),
          });
          router.push("/lifecycle/matches");
        } catch (error) {
          console.error("Failed to detect matches:", error);
          toast.error("Failed to detect matches");
        }
      }

      // Prompt to reschedule pending actions if delay changed
      if (delayChanged) {
        setRescheduleOldDelay(prevDelay);
        setRescheduleNewDelay(actionDelayDays);
        setShowRescheduleDialog(true);
      }
    } catch (error) {
      console.error("Failed to save rule set:", error);
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    if (countAllRules(groups) === 0) return;
    setPreviewing(true);
    try {
      const previewBody: Record<string, unknown> = { rules: groups, type: mediaType, serverIds };
      if (scopeConfig) {
        previewBody.seriesScope = seriesScope;
      }

      // Fetch preview and diff in parallel for existing rule sets
      const previewPromise = fetch("/api/lifecycle/rules/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(previewBody),
      });
      const diffPromise = activeRuleSetId
        ? fetch(`/api/lifecycle/rules/${activeRuleSetId}/diff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(previewBody),
          })
        : null;

      const [previewResponse, diffResponse] = await Promise.all([
        previewPromise,
        diffPromise,
      ]);

      const previewData = await previewResponse.json();
      let mergedItems = previewData.items as PreviewItem[];

      // Process diff data if available
      if (diffResponse?.ok) {
        const diff = await diffResponse.json() as DiffData & { removedItems?: PreviewItem[] };
        const statusMap = new Map<string, "added" | "removed" | "retained">();
        for (const item of diff.added) statusMap.set(item.id, "added");
        for (const item of diff.retained) statusMap.set(item.id, "retained");
        for (const item of diff.removed) statusMap.set(item.id, "removed");

        // Append removed items (full MediaItem data from diff endpoint) to the preview list
        if (diff.removedItems && diff.removedItems.length > 0) {
          mergedItems = [...mergedItems, ...diff.removedItems];
        }

        setPreviewDiffMap(statusMap);
        setPreviewDiffCounts(diff.counts);
      } else {
        setPreviewDiffMap(new Map());
        setPreviewDiffCounts(null);
      }

      // Preserve scroll position when preview results cause layout change
      const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
      setPreview(mergedItems);
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({ top: scrollTop, behavior: "instant" });
        }
      });
    } catch (error) {
      console.error("Failed to preview:", error);
    } finally {
      setPreviewing(false);
    }
  };

  const handlePreviewSort = (field: string) => {
    if (previewSortBy === field) {
      setPreviewSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setPreviewSortBy(field);
      setPreviewSortOrder("asc");
    }
  };

  const sortedPreview = [...preview].sort((a, b) => {
    if (!previewSortBy) return 0;
    const aVal = a[previewSortBy as keyof PreviewItem];
    const bVal = b[previewSortBy as keyof PreviewItem];
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return previewSortOrder === "asc" ? cmp : -cmp;
  });

  // Test Media handlers
  const handleTestMediaSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setTestMediaResults([]);
        return;
      }
      setTestMediaSearching(true);
      try {
        const params = new URLSearchParams({ q: query, type: mediaType });
        if (scopeConfig && seriesScope) params.set("seriesScope", "true");
        const response = await fetch(`/api/media/search?${params}`);
        if (response.ok) {
          const data = await response.json();
          setTestMediaResults(data.items ?? []);
        }
      } catch {
        // ignore
      } finally {
        setTestMediaSearching(false);
      }
    },
    [mediaType, scopeConfig, seriesScope],
  );

  const handleTestMediaSearchInput = useCallback(
    (value: string) => {
      setTestMediaSearch(value);
      setTestMediaSelected(null);
      setTestMediaResult(null);
      if (testMediaTimerRef.current) clearTimeout(testMediaTimerRef.current);
      testMediaTimerRef.current = setTimeout(() => handleTestMediaSearch(value), 300);
    },
    [handleTestMediaSearch],
  );

  const handleTestMediaEvaluate = useCallback(
    async (itemId: string) => {
      setTestMediaEvaluating(true);
      setTestMediaResult(null);
      try {
        const response = await fetch("/api/lifecycle/rules/test-item", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rules: groups,
            type: mediaType,
            seriesScope: scopeConfig ? seriesScope : undefined,
            mediaItemId: itemId,
            serverIds,
          }),
        });
        if (response.ok) {
          const data = await response.json();
          setTestMediaResult({
            matches: data.matches,
            matchedCriteria: data.matchedCriteria ?? [],
            actualValues: data.actualValues ?? {},
          });
        } else {
          const data = await response.json().catch(() => null);
          toast.error(data?.error ?? "Failed to evaluate item");
        }
      } catch {
        toast.error("Failed to evaluate item");
      } finally {
        setTestMediaEvaluating(false);
      }
    },
    [groups, mediaType, scopeConfig, seriesScope, serverIds],
  );

  const takeSnapshot = (): RuleSetSnapshot => ({
    name,
    groups: JSON.stringify(groups),
    enabled,
    seriesScope,
    actionEnabled,
    actionType,
    actionDelayDays,
    arrInstanceId,
    addImportExclusion,
    searchAfterDelete,
    addArrTags: JSON.stringify([...addArrTags].sort()),
    removeArrTags: JSON.stringify([...removeArrTags].sort()),
    collectionEnabled,
    collectionName,
    collectionSortName,
    collectionHomeScreen,
    collectionRecommended,
    collectionSort,
    discordNotifyOnAction,
    discordNotifyOnMatch,
    stickyMatches,
    serverIds: JSON.stringify([...serverIds].sort()),
  });

  const loadRuleSet = async (ruleSet: SavedRuleSet) => {
    setName(ruleSet.name);
    setGroups(legacyToGroups(ruleSet.rules));
    setActiveRuleSetId(ruleSet.id);
    setEnabled(ruleSet.enabled ?? true);
    if (scopeConfig) {
      setSeriesScope(ruleSet.seriesScope ?? true);
    }
    setActionEnabled(ruleSet.actionEnabled);
    setActionType(ruleSet.actionType ?? defaultActionType);
    setActionDelayDays(ruleSet.actionDelayDays);
    setArrInstanceId(ruleSet.arrInstanceId ?? "");
    setAddImportExclusion(ruleSet.addImportExclusion ?? false);
    setSearchAfterDelete(ruleSet.searchAfterDelete ?? false);
    setAddArrTags(ruleSet.addArrTags ?? []);
    setRemoveArrTags(ruleSet.removeArrTags ?? []);
    setManageTagsEnabled((ruleSet.addArrTags ?? []).length > 0 || (ruleSet.removeArrTags ?? []).length > 0);
    setTagMode((ruleSet.addArrTags ?? []).length > 0 ? "add" : (ruleSet.removeArrTags ?? []).length > 0 ? "remove" : "add");
    setCollectionEnabled(ruleSet.collectionEnabled ?? false);
    setCollectionName(ruleSet.collectionName ?? "");
    setCollectionSortName(ruleSet.collectionSortName ?? "");
    setPreview([]);

    prevCollectionRef.current = {
      enabled: ruleSet.collectionEnabled ?? false,
      name: ruleSet.collectionName ?? null,
    };

    setDiscordNotifyOnAction(ruleSet.discordNotifyOnAction ?? false);
    setDiscordNotifyOnMatch(ruleSet.discordNotifyOnMatch ?? false);
    setStickyMatches(ruleSet.stickyMatches ?? false);
    setServerIds(ruleSet.serverIds ?? []);

    let homeScreen = ruleSet.collectionHomeScreen ?? false;
    let recommended = ruleSet.collectionRecommended ?? false;
    if (ruleSet.collectionEnabled && ruleSet.collectionName) {
      try {
        const res = await fetch(
          `/api/lifecycle/collections/visibility?ruleSetId=${ruleSet.id}`
        );
        if (res.ok) {
          const data = await res.json();
          homeScreen = data.home;
          recommended = data.recommended;
        }
      } catch {
        // Fall back to DB values
      }
    }
    setCollectionHomeScreen(homeScreen);
    setCollectionRecommended(recommended);
    setCollectionSort(ruleSet.collectionSort ?? "ALPHABETICAL");

    // Capture snapshot from rule set data (state not yet updated)
    updateSnapshot({
      name: ruleSet.name,
      groups: JSON.stringify(legacyToGroups(ruleSet.rules)),
      enabled: ruleSet.enabled ?? true,
      seriesScope: ruleSet.seriesScope ?? true,
      actionEnabled: ruleSet.actionEnabled,
      actionType: ruleSet.actionType ?? defaultActionType,
      actionDelayDays: ruleSet.actionDelayDays,
      arrInstanceId: ruleSet.arrInstanceId ?? "",
      addImportExclusion: ruleSet.addImportExclusion ?? false,
      searchAfterDelete: ruleSet.searchAfterDelete ?? false,
      addArrTags: JSON.stringify([...(ruleSet.addArrTags ?? [])].sort()),
      removeArrTags: JSON.stringify([...(ruleSet.removeArrTags ?? [])].sort()),
      collectionEnabled: ruleSet.collectionEnabled ?? false,
      collectionName: ruleSet.collectionName ?? "",
      collectionSortName: ruleSet.collectionSortName ?? "",
      collectionHomeScreen: homeScreen,
      collectionRecommended: recommended,
      collectionSort: ruleSet.collectionSort ?? "ALPHABETICAL",
      discordNotifyOnAction: ruleSet.discordNotifyOnAction ?? false,
      discordNotifyOnMatch: ruleSet.discordNotifyOnMatch ?? false,
      stickyMatches: ruleSet.stickyMatches ?? false,
      serverIds: JSON.stringify([...(ruleSet.serverIds ?? [])].sort()),
    });
  };

  const toggleRuleSetEnabled = async (id: string, currentEnabled: boolean) => {
    try {
      await fetch(`/api/lifecycle/rules/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      if (activeRuleSetId === id) {
        setEnabled(!currentEnabled);
      }
      await fetchRuleSets();
    } catch (error) {
      console.error("Failed to toggle rule set:", error);
    }
  };

  const deleteRuleSet = async (id: string, cleanupTags: boolean = false) => {
    try {
      const url = cleanupTags
        ? `/api/lifecycle/rules/${id}?cleanupTags=true`
        : `/api/lifecycle/rules/${id}`;
      await fetch(url, { method: "DELETE" });
      if (activeRuleSetId === id) {
        newRuleSet();
      }
      await fetchRuleSets();
    } catch (error) {
      console.error("Failed to delete rule set:", error);
    }
  };

  const newRuleSet = () => {
    setName("");
    setGroups([]);
    setActiveRuleSetId(null);
    setEnabled(true);
    if (scopeConfig) {
      setSeriesScope(true);
    }
    setActionEnabled(false);
    setActionType(defaultActionType);
    setActionDelayDays(7);
    setArrInstanceId("");
    setAddImportExclusion(false);
    setAddArrTags([]);
    setRemoveArrTags([]);
    setManageTagsEnabled(false);
    setTagMode("add");
    setCollectionEnabled(false);
    setCollectionName("");
    setCollectionSortName("");
    setCollectionHomeScreen(false);
    setCollectionRecommended(false);
    setCollectionSort("ALPHABETICAL");
    setDiscordNotifyOnAction(false);
    setDiscordNotifyOnMatch(false);
    setServerIds([]);
    setPreview([]);
    prevCollectionRef.current = { enabled: false, name: null };
    updateSnapshot(null);
  };

  const exportRuleSet = () => {
    if (groups.length === 0) return;
    const data: RuleSetExport = {
      version: 1,
      type: mediaType,
      name,
      rules: groups,
      enabled,
      actionEnabled,
      actionType: actionType || null,
      actionDelayDays,
      addImportExclusion,
      searchAfterDelete,
      addArrTags,
      removeArrTags,
      collectionEnabled,
      collectionName: collectionName || null,
      collectionSortName: collectionSortName || null,
      collectionHomeScreen,
      collectionRecommended,
      collectionSort,
      discordNotifyOnAction,
      discordNotifyOnMatch,
      stickyMatches,
    };
    if (scopeConfig) {
      data.seriesScope = seriesScope;
    }
    setExportJson(JSON.stringify(data, null, 2));
    setCopied(false);
    setShowExportDialog(true);
  };

  const handleCopyExport = async () => {
    await navigator.clipboard.writeText(exportJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleImportJson = () => {
    try {
      const data = JSON.parse(importJson) as RuleSetExport;
      if (!data.rules || !Array.isArray(data.rules)) {
        setSaveError("Invalid rule set JSON: missing rules");
        setShowImportDialog(false);
        return;
      }
      if (data.type && data.type !== mediaType) {
        setSaveError(importErrorMessage);
        setShowImportDialog(false);
        return;
      }
      setActiveRuleSetId(null);
      setName(data.name || "");
      setGroups(legacyToGroups(data.rules));
      if (scopeConfig) {
        setSeriesScope(data.seriesScope ?? true);
      }
      setEnabled(data.enabled ?? true);
      setActionEnabled(data.actionEnabled ?? false);
      setActionType(data.actionType ?? defaultActionType);
      setActionDelayDays(data.actionDelayDays ?? 7);
      setArrInstanceId("");
      setAddImportExclusion(data.addImportExclusion ?? false);
      setSearchAfterDelete(data.searchAfterDelete ?? false);
      setAddArrTags(data.addArrTags ?? []);
      setRemoveArrTags(data.removeArrTags ?? []);
      setManageTagsEnabled((data.addArrTags ?? []).length > 0 || (data.removeArrTags ?? []).length > 0);
      setTagMode((data.addArrTags ?? []).length > 0 ? "add" : (data.removeArrTags ?? []).length > 0 ? "remove" : "add");
      setCollectionEnabled(data.collectionEnabled ?? false);
      setCollectionName(data.collectionName ?? "");
      setCollectionSortName(data.collectionSortName ?? "");
      setCollectionHomeScreen(data.collectionHomeScreen ?? false);
      setCollectionRecommended(data.collectionRecommended ?? false);
      setCollectionSort(data.collectionSort ?? "ALPHABETICAL");
      setDiscordNotifyOnAction(data.discordNotifyOnAction ?? false);
      setDiscordNotifyOnMatch(data.discordNotifyOnMatch ?? false);
      setStickyMatches(data.stickyMatches ?? false);
      setServerIds(data.serverIds ?? []);
      setPreview([]);
      setSaveError(null);
      setShowImportDialog(false);
      setImportJson("");
    } catch {
      setSaveError("Failed to parse rule set JSON");
      setShowImportDialog(false);
    }
  };

  return (
    <div className={`flex ${embedded ? "flex-1 min-h-0" : "h-full"}`}>
      <div ref={scrollContainerRef} className="flex-1 min-w-0 overflow-y-auto">
        <div className={embedded ? "px-4 sm:px-6 lg:px-8 pb-4 sm:pb-6 lg:pb-8" : "p-4 sm:p-6 lg:p-8"}>
      {!embedded && (
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">{pageTitle}</h1>
          <Button variant="outline" onClick={newRuleSet}>
            <FileText className="mr-2 h-4 w-4" />
            New Rule Set
          </Button>
        </div>
      )}
      {embedded && (
        <div className="mb-6 flex justify-end">
          <Button variant="outline" onClick={newRuleSet}>
            <FileText className="mr-2 h-4 w-4" />
            New Rule Set
          </Button>
        </div>
      )}

      {/* Saved Rule Sets */}
      {savedRuleSets.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Saved Rule Sets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {savedRuleSets.map((ruleSet) => (
                <div
                  key={ruleSet.id}
                  className={`flex items-center justify-between rounded-lg border p-3 transition-colors ${
                    activeRuleSetId === ruleSet.id
                      ? "border-primary bg-primary/5"
                      : "cursor-pointer hover:bg-muted/50"
                  } ${!ruleSet.enabled ? "opacity-50" : ""}`}
                  onClick={() => loadRuleSet(ruleSet)}
                >
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={ruleSet.enabled}
                      onCheckedChange={() => toggleRuleSetEnabled(ruleSet.id, ruleSet.enabled)}
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0"
                    />
                    <div>
                      <p className="font-medium truncate">{ruleSet.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {countRules(ruleSet.rules)} rule
                        {countRules(ruleSet.rules) !== 1 && "s"}
                        {ruleSet.enabled ? (
                          <span className="ml-2 text-green-400">Enabled</span>
                        ) : (
                          <span className="ml-2 text-muted-foreground">Disabled</span>
                        )}
                        {ruleSet.enabled && ruleSet.actionEnabled && (
                          <span className="ml-2 text-orange-400">
                            Action enabled
                          </span>
                        )}
                        {ruleSet.enabled && ruleSet.collectionEnabled && (
                          <span className="ml-2 text-blue-400">
                            Collection
                          </span>
                        )}
                        {ruleSet.enabled && (ruleSet.addArrTags?.length > 0 || ruleSet.removeArrTags?.length > 0) && (
                          <span className="ml-2 text-purple-400">
                            Tags
                          </span>
                        )}
                        {scopeConfig && (
                          <span className="ml-2">
                            {ruleSet.seriesScope !== false ? scopeConfig.ruleSetEnabledLabel : scopeConfig.ruleSetDisabledLabel}
                          </span>
                        )}
                        {ruleSet.serverIds?.length > 0 && (
                          <span className="ml-2 text-cyan-400">
                            {ruleSet.serverIds.length} server{ruleSet.serverIds.length !== 1 ? "s" : ""}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConfirmId(ruleSet.id);
                      setDeleteConfirmName(ruleSet.name);
                      setDeleteConfirmHasCollection(ruleSet.collectionEnabled && !!ruleSet.collectionName);
                      setDeleteConfirmAddTags(ruleSet.addArrTags ?? []);
                      setDeleteConfirmCleanupTags(false);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Rule Builder */}
      <Card>
        <CardHeader>
          <CardTitle>
            {activeRuleSetId ? "Edit Rule Set" : "Create Rule Set"}
          </CardTitle>
          <CardDescription>
            Define criteria to find {ruleDescription} matching specific conditions
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <Input
              placeholder="Rule set name (e.g., 'Old unwatched 720p movies')"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`flex-1 min-w-0${!name ? " border-destructive" : ""}`}
            />
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                id="rule-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              <Label htmlFor="rule-enabled" className="text-sm whitespace-nowrap">
                Enabled
              </Label>
            </div>
          </div>

          {/* Media Server Selection */}
          <div className="flex items-center gap-4 flex-wrap">
            <Label className="text-sm whitespace-nowrap">Media Servers</Label>
            <Popover open={serverPopoverOpen} onOpenChange={setServerPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={serverPopoverOpen}
                  className={`w-64 justify-between${serverIds.length === 0 ? " border-destructive" : ""}`}
                >
                  {serverIds.length === 0
                    ? "Select servers..."
                    : `${serverIds.length} server${serverIds.length !== 1 ? "s" : ""} selected`}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 max-w-[calc(100vw-2rem)] p-0">
                <Command>
                  <CommandInput placeholder="Search servers..." />
                  <CommandList>
                    <CommandEmpty>No servers found.</CommandEmpty>
                    <CommandGroup>
                      {servers.map((server) => (
                        <CommandItem
                          key={server.id}
                          value={server.name}
                          onSelect={() => {
                            setServerIds((prev) =>
                              prev.includes(server.id)
                                ? prev.filter((id) => id !== server.id)
                                : [...prev, server.id]
                            );
                          }}
                        >
                          <Check
                            className={`mr-2 h-4 w-4 ${
                              serverIds.includes(server.id) ? "opacity-100" : "opacity-0"
                            }`}
                          />
                          {server.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {serverIds.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {serverIds.map((id) => {
                  const server = servers.find((s) => s.id === id);
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                    >
                      {server?.name ?? id}
                      <button
                        type="button"
                        onClick={() => setServerIds((prev) => prev.filter((sid) => sid !== id))}
                        className="hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Arr Server Selection */}
          <div className="flex flex-wrap items-center gap-4">
            <Label className="text-sm whitespace-nowrap">{arrServiceName} Server</Label>
            {arrInstances.length > 0 ? (
              <Select
                value={arrInstanceId}
                onValueChange={setArrInstanceId}
              >
                <SelectTrigger className={`w-64${!arrInstanceId && (actionType !== "DO_NOTHING" || addArrTags.length > 0 || removeArrTags.length > 0) ? " border-destructive" : ""}`}>
                  <SelectValue placeholder="Select instance" />
                </SelectTrigger>
                <SelectContent>
                  {arrInstances.map((inst) => (
                    <SelectItem key={inst.id} value={inst.id}>
                      {inst.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Select disabled>
                        <SelectTrigger className="w-full sm:w-64">
                          <SelectValue placeholder="No instances available" />
                        </SelectTrigger>
                      </Select>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Add a {arrServiceName} instance in Settings &rarr; Integrations
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {/* Evaluation Scope (series/music only) */}
          {scopeConfig && (
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-3">
                <Switch
                  id={scopeConfig.id}
                  checked={seriesScope}
                  onCheckedChange={setSeriesScope}
                />
                <div>
                  <Label htmlFor={scopeConfig.id} className="font-medium">
                    {scopeConfig.label}
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {seriesScope
                      ? scopeConfig.enabledDescription
                      : scopeConfig.disabledDescription}
                  </p>
                </div>
              </div>
            </div>
          )}

          <BuilderWithPseudocode groups={groups} config={ruleBuilderConfig}>
            <RuleBuilder
              groups={groups}
              onChange={setGroups}
              distinctValues={distinctValues}
              arrConnected={!!arrInstanceId}
              seerrConnected={mediaType === "MUSIC" ? undefined : seerrConnected}
              libraryType={mediaType}
            />
          </BuilderWithPseudocode>

          {/* Action Configuration */}
          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-center gap-3">
              <Switch
                id="action-enabled"
                checked={actionEnabled}
                onCheckedChange={setActionEnabled}
              />
              <Label htmlFor="action-enabled" className="font-medium">
                Enable lifecycle action
              </Label>
            </div>

            {actionEnabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label>Action type</Label>
                    <Select
                      value={actionType}
                      onValueChange={setActionType}
                    >
                      <SelectTrigger className="mt-1.5">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {actionTypes.map((opt) => {
                          const needsArr = opt.value !== "DO_NOTHING";
                          const disabled = needsArr && !arrInstanceId;
                          if (disabled) {
                            return (
                              <TooltipProvider key={opt.value}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div>
                                      <SelectItem value={opt.value} disabled>
                                        {opt.label}
                                      </SelectItem>
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent side="left">
                                    Select an Arr server above to enable this action
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            );
                          }
                          return (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label htmlFor="delay-days">Delay (days)</Label>
                    <Input
                      id="delay-days"
                      type="number"
                      min={0}
                      value={actionDelayDays}
                      onChange={(e) =>
                        setActionDelayDays(parseInt(e.target.value) || 0)
                      }
                      className="mt-1.5"
                    />
                  </div>
                </div>

                {actionType.startsWith("DELETE_") && !actionType.includes("DELETE_FILES") && (
                  <div className="flex items-center gap-3">
                    <Switch
                      id="import-exclusion"
                      checked={addImportExclusion}
                      onCheckedChange={setAddImportExclusion}
                    />
                    <Label htmlFor="import-exclusion">
                      Add import list exclusion (prevents re-adding by
                      lists)
                    </Label>
                  </div>
                )}

                {actionType.includes("DELETE_FILES") && (
                  <div className="flex items-center gap-3">
                    <Switch
                      id="search-after-delete"
                      checked={searchAfterDelete}
                      onCheckedChange={setSearchAfterDelete}
                    />
                    <Label htmlFor="search-after-delete">
                      Search for new copy after file deletion
                    </Label>
                  </div>
                )}

                {/* Discord Notification */}
                <div className="flex items-center gap-3">
                  <Switch
                    id="discord-notify"
                    checked={discordNotifyOnAction}
                    onCheckedChange={setDiscordNotifyOnAction}
                  />
                  <div>
                    <Label htmlFor="discord-notify" className="font-medium">
                      Send Discord notification on action execution
                    </Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Requires a Discord webhook configured in Settings &gt; Notifications
                    </p>
                  </div>
                </div>

                {/* Manage Tags */}
                <div className="space-y-3 border-t pt-3">
                  <div className="flex items-center gap-3">
                    <Switch
                      id="manage-tags"
                      checked={manageTagsEnabled}
                      onCheckedChange={(checked) => {
                        setManageTagsEnabled(checked);
                        if (!checked) {
                          setAddArrTags([]);
                          setRemoveArrTags([]);
                        }
                      }}
                      disabled={actionType.startsWith("DELETE_") || !arrInstanceId}
                    />
                    <Label htmlFor="manage-tags" className={(actionType.startsWith("DELETE_") || !arrInstanceId) ? "text-muted-foreground" : ""}>
                      Manage Tags
                    </Label>
                    {actionType.startsWith("DELETE_") && (
                      <span className="text-xs text-muted-foreground">(disabled when deleting from Arr)</span>
                    )}
                    {!actionType.startsWith("DELETE_") && !arrInstanceId && (
                      <span className="text-xs text-muted-foreground">(select a {arrServiceName} server above)</span>
                    )}
                  </div>

                  {manageTagsEnabled && !actionType.startsWith("DELETE_") && arrInstanceId && (
                    <div className="ml-7 space-y-3">
                      <Select value={tagMode} onValueChange={(v) => setTagMode(v as "add" | "remove")}>
                        <SelectTrigger className="w-full sm:w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="add">Add Arr Tag(s)</SelectItem>
                          <SelectItem value="remove">Remove Arr Tag(s)</SelectItem>
                        </SelectContent>
                      </Select>

                      {/* Tag multi-select dropdown */}
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                            <span className="truncate text-muted-foreground">
                              {(tagMode === "add" ? addArrTags : removeArrTags).length === 0
                                ? "Select tags..."
                                : `${(tagMode === "add" ? addArrTags : removeArrTags).length} tag${(tagMode === "add" ? addArrTags : removeArrTags).length === 1 ? "" : "s"} selected`}
                            </span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search or type new tag..." />
                            <CommandList>
                              <CommandEmpty>
                                <button
                                  className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent rounded-sm"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    const input = (e.currentTarget.closest("[cmdk-root]")?.querySelector("[cmdk-input]") as HTMLInputElement)?.value?.trim();
                                    if (!input) return;
                                    if (tagMode === "add") {
                                      if (!addArrTags.includes(input)) setAddArrTags([...addArrTags, input]);
                                    } else {
                                      if (!removeArrTags.includes(input)) setRemoveArrTags([...removeArrTags, input]);
                                    }
                                  }}
                                >
                                  Add new tag
                                </button>
                              </CommandEmpty>
                              <CommandGroup>
                                {(distinctValues.arrTag ?? []).map((tag) => {
                                  const selected = (tagMode === "add" ? addArrTags : removeArrTags).includes(tag);
                                  return (
                                    <CommandItem
                                      key={tag}
                                      value={tag}
                                      onSelect={() => {
                                        if (tagMode === "add") {
                                          setAddArrTags(selected ? addArrTags.filter((t) => t !== tag) : [...addArrTags, tag]);
                                        } else {
                                          setRemoveArrTags(selected ? removeArrTags.filter((t) => t !== tag) : [...removeArrTags, tag]);
                                        }
                                      }}
                                    >
                                      <Check className={`mr-2 h-4 w-4 ${selected ? "opacity-100" : "opacity-0"}`} />
                                      {tag}
                                    </CommandItem>
                                  );
                                })}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>

                      {/* Selected tag badges */}
                      {(tagMode === "add" ? addArrTags : removeArrTags).length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {(tagMode === "add" ? addArrTags : removeArrTags).map((tag) => (
                            <span
                              key={tag}
                              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ${
                                tagMode === "add"
                                  ? "bg-green-500/15 text-green-400"
                                  : "bg-red-500/15 text-red-400"
                              }`}
                            >
                              {tagMode === "add" ? "+" : "-"}{tag}
                              <button
                                onClick={() => {
                                  if (tagMode === "add") {
                                    setAddArrTags(addArrTags.filter((t) => t !== tag));
                                  } else {
                                    setRemoveArrTags(removeArrTags.filter((t) => t !== tag));
                                  }
                                }}
                                className={tagMode === "add" ? "hover:text-green-200" : "hover:text-red-200"}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Plex Collection Configuration */}
          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-center gap-3">
              <Switch
                id="collection-enabled"
                checked={collectionEnabled}
                onCheckedChange={(checked) => {
                  setCollectionEnabled(checked);
                  if (checked) setSkipCollectionRemoval(false);
                }}
              />
              <Label htmlFor="collection-enabled" className="font-medium">
                Sync matches to Plex collection
              </Label>
              {!collectionEnabled && prevCollectionRef.current.enabled && prevCollectionRef.current.name && (
                <span className="text-xs text-amber-500">Pending disable on save</span>
              )}
            </div>

            {collectionEnabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="collection-name">Collection name</Label>
                    <Input
                      id="collection-name"
                      placeholder="e.g., Unwatched Old Movies"
                      value={collectionName}
                      onChange={(e) => setCollectionName(e.target.value)}
                      className={`mt-1.5${!collectionName?.trim() ? " border-destructive" : ""}`}
                    />
                  </div>
                  <div>
                    <Label htmlFor="collection-sort-name">Sort name (optional)</Label>
                    <Input
                      id="collection-sort-name"
                      placeholder="e.g., !001 for top sorting"
                      value={collectionSortName}
                      onChange={(e) => setCollectionSortName(e.target.value)}
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label>Sort order</Label>
                    <Select value={collectionSort} onValueChange={setCollectionSort}>
                      <SelectTrigger className="mt-1.5">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALPHABETICAL">Alphabetical</SelectItem>
                        <SelectItem value="RELEASE_DATE">Release date</SelectItem>
                        <SelectItem value="DELETION_DATE">Deletion date</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-6 gap-y-3">
                  <div className="flex items-center gap-3">
                    <Switch
                      id="collection-home"
                      checked={collectionHomeScreen}
                      onCheckedChange={setCollectionHomeScreen}
                    />
                    <Label htmlFor="collection-home">
                      Display on home screens
                    </Label>
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch
                      id="collection-recommended"
                      checked={collectionRecommended}
                      onCheckedChange={setCollectionRecommended}
                    />
                    <Label htmlFor="collection-recommended">
                      Display in library recommended
                    </Label>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Discord Match Notification */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <Switch
                id="discord-notify-match"
                checked={discordNotifyOnMatch}
                onCheckedChange={setDiscordNotifyOnMatch}
              />
              <Label htmlFor="discord-notify-match" className="font-medium">
                Send Discord notification on match changes
              </Label>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 ml-11">
              Notify when items are added to or removed from rule matches. Requires a Discord webhook configured in Settings &gt; Notifications
            </p>
          </div>

          {/* Sticky Matches */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <Switch
                id="sticky-matches"
                checked={stickyMatches}
                onCheckedChange={setStickyMatches}
              />
              <Label htmlFor="sticky-matches" className="font-medium">
                Sticky matches
              </Label>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 ml-11">
              Keep items matched even if they no longer meet the rule criteria. Matched items will only be removed by a manual re-evaluation.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              onClick={handlePreview}
              disabled={groups.length === 0 || !validateAllRules(groups) || previewing || serverIds.length === 0}
              variant="secondary"
            >
              {previewing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-2 h-4 w-4" />
              )}
              Preview
            </Button>
            <Button
              onClick={() => {
                setTestMediaSearch("");
                setTestMediaResults([]);
                setTestMediaSelected(null);
                setTestMediaResult(null);
                setShowTestMediaDialog(true);
              }}
              disabled={groups.length === 0 || !validateAllRules(groups) || serverIds.length === 0}
              variant="secondary"
            >
              <FlaskConical className="mr-2 h-4 w-4" />
              Test Media
            </Button>
            <Button
              onClick={() => {
                const collectionPendingDisable = prevCollectionRef.current.enabled && !collectionEnabled && !!prevCollectionRef.current.name;
                if (collectionPendingDisable) {
                  setShowCollectionDisableDialog(true);
                } else if (activeRuleSetId && !rulesChanged) {
                  // Config-only change — skip detection, just save
                  handleSave({ clearMatches: false, runDetection: false });
                } else if (activeRuleSetId) {
                  setShowSaveOptions(true);
                } else {
                  setShowNewSaveOptions(true);
                }
              }}
              disabled={!isDirty || justSaved || !name || groups.length === 0 || !validateAllRules(groups) || loading || serverIds.length === 0 || (actionEnabled && (actionType !== "DO_NOTHING" || addArrTags.length > 0 || removeArrTags.length > 0) && !arrInstanceId) || (collectionEnabled && !collectionName?.trim())}
              className={justSaved ? "bg-green-600 hover:bg-green-600 text-white" : ""}
            >
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : justSaved ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {justSaved ? "Saved" : "Save"}
            </Button>
            <div className="ml-auto flex gap-2">
              <Button
                onClick={() => { setImportJson(""); setSaveError(null); setShowImportDialog(true); }}
                variant="outline"
                size="sm"
              >
                <ClipboardPaste className="mr-2 h-4 w-4" />
                Import
              </Button>
              <Button
                onClick={exportRuleSet}
                disabled={groups.length === 0}
                variant="outline"
                size="sm"
              >
                <Upload className="mr-2 h-4 w-4" />
                Export
              </Button>
            </div>
          </div>

          {saveError && (
            <p className="text-sm text-red-500">{saveError}</p>
          )}
        </CardContent>
      </Card>

      {/* Preview Results */}
      {preview.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <h2 className="text-xl font-bold font-display">
              Preview Results ({previewDiffCounts ? preview.length - (previewDiffCounts.removed) : preview.length} matches)
            </h2>
            {previewDiffCounts && (previewDiffCounts.added > 0 || previewDiffCounts.removed > 0) && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">—</span>
                {previewDiffCounts.added > 0 && (
                  <Badge variant="outline" className="border-emerald-500/50 text-emerald-400">
                    +{previewDiffCounts.added} new
                  </Badge>
                )}
                {previewDiffCounts.retained > 0 && (
                  <Badge variant="outline" className="text-muted-foreground">
                    {previewDiffCounts.retained} retained
                  </Badge>
                )}
                {previewDiffCounts.removed > 0 && (
                  <Badge variant="outline" className="border-amber-500/50 text-amber-400">
                    -{previewDiffCounts.removed} removed
                  </Badge>
                )}
              </div>
            )}
            <div className="ml-auto flex items-center gap-3">
              <div className="flex items-center gap-1 rounded-lg border p-1 h-9">
                <button
                  onClick={() => handlePreviewViewModeChange("cards")}
                  className={cn(
                    "rounded-md p-1.5 transition-colors",
                    previewViewMode === "cards"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                  title="Card view"
                  aria-label="Card view"
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handlePreviewViewModeChange("table")}
                  className={cn(
                    "rounded-md p-1.5 transition-colors",
                    previewViewMode === "table"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                  title="Table view"
                  aria-label="Table view"
                >
                  <TableProperties className="h-4 w-4" />
                </button>
              </div>
              {previewViewMode === "cards" && (
                <>
                  <CardSizeControl size={cardSize} onChange={setCardSize} />
                  <CardDisplayControl
                    prefs={cardPrefs}
                    config={TOGGLE_CONFIGS.MOVIE}
                    onToggle={(section, key, visible) => setCardFieldVisible(section, key, visible)}
                  />
                </>
              )}
            </div>
          </div>
          {previewViewMode === "table" ? (
            <MediaTable
              items={sortedPreview}
              onItemClick={(item) => setSelectedItem(item)}
              sortBy={previewSortBy}
              sortOrder={previewSortOrder}
              onSort={handlePreviewSort}
              mediaType={mediaType}
              exceptedItemIds={exceptedItemIds}
              rowClassName={previewDiffMap.size > 0 ? (item) => {
                const status = previewDiffMap.get(item.id);
                if (status === "added") return "border-l-2 border-l-emerald-500/70 bg-emerald-500/5";
                if (status === "removed") return "border-l-2 border-l-amber-500/70 bg-amber-500/5 opacity-60";
                return undefined;
              } : undefined}
            />
          ) : (
            <PreviewCardGrid
              items={sortedPreview}
              mediaType={mediaType}
              onItemClick={(item) => setSelectedItem(item)}
              diffMap={previewDiffMap}
              exceptedItemIds={exceptedItemIds}
              show={showCardField}
              getHex={getHex}
              showServers={showServers}
            />
          )}
        </div>
      )}

      {/* Export Dialog */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Export Rule Set</DialogTitle>
            <DialogDescription>
              Copy the JSON below to share or back up this rule set.
            </DialogDescription>
          </DialogHeader>
          <textarea
            readOnly
            value={exportJson}
            className="h-64 w-full rounded-md border bg-muted p-3 font-mono text-xs focus:outline-none"
            onFocus={(e) => e.target.select()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExportDialog(false)}>
              Close
            </Button>
            <Button onClick={handleCopyExport}>
              {copied ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              {copied ? "Copied" : "Copy to Clipboard"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import Rule Set</DialogTitle>
            <DialogDescription>
              Paste a previously exported rule set JSON below.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder="Paste rule set JSON here..."
            className="h-64 w-full rounded-md border bg-muted p-3 font-mono text-xs focus:outline-none placeholder:text-muted-foreground"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowImportDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleImportJson} disabled={!importJson.trim()}>
              <ClipboardPaste className="mr-2 h-4 w-4" />
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test Media Dialog */}
      <Dialog open={showTestMediaDialog} onOpenChange={setShowTestMediaDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Test Media</DialogTitle>
            <DialogDescription>
              Search for a media item and evaluate it against the current rules.
            </DialogDescription>
          </DialogHeader>

          {/* Search input */}
          {!testMediaSelected && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by title..."
                value={testMediaSearch}
                onChange={(e) => handleTestMediaSearchInput(e.target.value)}
                className="pl-9"
                autoFocus
              />
            </div>
          )}

          {/* Search results */}
          {!testMediaSelected && testMediaResults.length > 0 && (
            <div className="max-h-60 overflow-y-auto rounded-md border">
              {testMediaResults.map((item) => {
                const displayTitle = scopeConfig && seriesScope
                  ? (item.parentTitle ?? item.title)
                  : item.title;
                return (
                  <button
                    key={item.id}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors border-b last:border-b-0"
                    onClick={() => {
                      setTestMediaSelected(item);
                      setTestMediaResults([]);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{displayTitle}</p>
                      {item.year && (
                        <p className="text-xs text-muted-foreground">{item.year}</p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* No results */}
          {!testMediaSelected && testMediaSearch.trim() && !testMediaSearching && testMediaResults.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No items found</p>
          )}

          {/* Searching indicator */}
          {testMediaSearching && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-sm text-muted-foreground">Searching...</span>
            </div>
          )}

          {/* Selected item */}
          {testMediaSelected && (
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">
                    {scopeConfig && seriesScope
                      ? (testMediaSelected.parentTitle ?? testMediaSelected.title)
                      : testMediaSelected.title}
                  </p>
                  {testMediaSelected.year && (
                    <p className="text-xs text-muted-foreground">{testMediaSelected.year}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleTestMediaEvaluate(testMediaSelected.id)}
                    disabled={testMediaEvaluating}
                  >
                    {testMediaEvaluating ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <FlaskConical className="mr-2 h-4 w-4" />
                    )}
                    Evaluate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setTestMediaSelected(null);
                      setTestMediaResult(null);
                      setTestMediaSearch("");
                    }}
                  >
                    Change
                  </Button>
                </div>
              </div>

              {/* Evaluation results */}
              {testMediaResult && (
                <div className="space-y-4">
                  {/* Match indicator */}
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={testMediaResult.matches ? "default" : "secondary"}
                      className={testMediaResult.matches
                        ? "bg-green-600 hover:bg-green-600 text-white"
                        : "text-muted-foreground"}
                    >
                      {testMediaResult.matches ? "Matches Rules" : "Does Not Match"}
                    </Badge>
                  </div>

                  {/* Matched criteria badges */}
                  {testMediaResult.matchedCriteria.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Matched Criteria</h4>
                      <div className="flex flex-wrap gap-1.5">
                        {testMediaResult.matchedCriteria.map((criterion, i) => {
                          const badge = (
                            <Badge
                              key={i}
                              variant="outline"
                              className={`text-xs ${criterion.negate ? "border-red-500/30 text-red-400" : ""}`}
                            >
                              {criterion.groupName && (
                                <span className="text-blue-400 mr-1">[{criterion.groupName}]</span>
                              )}
                              {criterion.negate && <span className="text-red-400 mr-1">NOT</span>}
                              {criterion.field} {criterion.operator} {criterion.value}
                            </Badge>
                          );
                          if (criterion.actualValue) {
                            return (
                              <TooltipProvider key={i}>
                                <Tooltip>
                                  <TooltipTrigger asChild>{badge}</TooltipTrigger>
                                  <TooltipContent>Actual: {criterion.actualValue}</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            );
                          }
                          return badge;
                        })}
                      </div>
                    </div>
                  )}

                  {/* Logic preview */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Logic Preview</h4>
                    <PseudocodePanel
                      groups={groups}
                      config={ruleBuilderConfig}
                      highlightedRuleIds={new Set(testMediaResult.matchedCriteria.map((c) => c.ruleId))}
                      actualValues={new Map(Object.entries(testMediaResult.actualValues))}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTestMediaDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rule Set?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will permanently delete the rule set &ldquo;{deleteConfirmName}&rdquo;.
                  {deleteConfirmHasCollection && (
                    <> The associated Plex collection will also be removed.</>
                  )}
                </p>
                {deleteConfirmAddTags.length > 0 && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                    <p className="mb-2 text-amber-400">
                      This rule set adds tags [{deleteConfirmAddTags.join(", ")}] to items.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={deleteConfirmCleanupTags}
                        onChange={(e) => setDeleteConfirmCleanupTags(e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <span>Remove these tags from all items and delete the tag definitions</span>
                    </label>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteConfirmId) deleteRuleSet(deleteConfirmId, deleteConfirmCleanupTags);
                setDeleteConfirmId(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Collection Disable Dialog — shown during save flow when collection is being disabled */}
      <AlertDialog open={showCollectionDisableDialog} onOpenChange={setShowCollectionDisableDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable Collection Sync?</AlertDialogTitle>
            <AlertDialogDescription>
              The collection &ldquo;{prevCollectionRef.current.name}&rdquo; currently exists on Plex.
              Would you like to also delete it from Plex, or keep it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel onClick={() => setShowCollectionDisableDialog(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setSkipCollectionRemoval(true);
                setShowCollectionDisableDialog(false);
                if (activeRuleSetId && !rulesChanged) {
                  handleSave({ clearMatches: false, runDetection: false });
                } else if (activeRuleSetId) {
                  setShowSaveOptions(true);
                } else {
                  setShowNewSaveOptions(true);
                }
              }}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
            >
              Keep on Plex
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                setSkipCollectionRemoval(false);
                setShowCollectionDisableDialog(false);
                if (activeRuleSetId && !rulesChanged) {
                  handleSave({ clearMatches: false, runDetection: false });
                } else if (activeRuleSetId) {
                  setShowSaveOptions(true);
                } else {
                  setShowNewSaveOptions(true);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete from Plex
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Pre-save: prompt for save behavior */}
      <AlertDialog open={showSaveOptions} onOpenChange={(open) => { if (!savingWithOption && !loadingDiff) setShowSaveOptions(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save Rule Set</AlertDialogTitle>
            <AlertDialogDescription>
              How should existing matches be handled?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <Button
              variant="default"
              disabled={savingWithOption || loadingDiff}
              onClick={async () => {
                if (!activeRuleSetId) return;
                setLoadingDiff(true);
                try {
                  const diffBody: Record<string, unknown> = { rules: groups, type: mediaType, serverIds };
                  if (scopeConfig) diffBody.seriesScope = seriesScope;
                  const res = await fetch(`/api/lifecycle/rules/${activeRuleSetId}/diff`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(diffBody),
                  });
                  if (!res.ok) {
                    toast.error("Failed to compute match diff");
                    return;
                  }
                  const data = await res.json();
                  setDiffData(data);
                  setDiffExpanded({});
                  setShowSaveOptions(false);
                  setShowDiffDialog(true);
                } catch {
                  toast.error("Failed to compute match diff");
                } finally {
                  setLoadingDiff(false);
                }
              }}
            >
              {loadingDiff ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save and re-detect
            </Button>
            <Button
              variant="outline"
              disabled={savingWithOption || loadingDiff}
              onClick={async () => {
                setSavingWithOption(true);
                await handleSave({ clearMatches: false, runDetection: false });
                setSavingWithOption(false);
                setShowSaveOptions(false);
              }}
            >
              Save only
            </Button>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingWithOption || loadingDiff}>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Diff preview dialog */}
      <Dialog open={showDiffDialog} onOpenChange={(open) => { if (!savingWithOption) setShowDiffDialog(open); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Match Changes Preview</DialogTitle>
            <DialogDescription>
              Review how matches will change with the updated rules.
            </DialogDescription>
          </DialogHeader>
          {diffData && (
            <div className="flex flex-col gap-3 py-2">
              {/* Retained */}
              <DiffSection
                label="Retained"
                count={diffData.counts.retained}
                items={diffData.retained}
                color="text-muted-foreground"
                bgColor="bg-muted/50"
                note="Scheduled actions will be preserved"
                expanded={diffExpanded.retained ?? false}
                onToggle={() => setDiffExpanded((prev) => ({ ...prev, retained: !prev.retained }))}
              />

              {/* Added */}
              <DiffSection
                label="New matches"
                count={diffData.counts.added}
                items={diffData.added}
                color="text-emerald-400"
                bgColor="bg-emerald-500/10"
                note={actionEnabled && actionDelayDays > 0 ? `Actions will be scheduled with ${actionDelayDays}-day delay` : undefined}
                expanded={diffExpanded.added ?? false}
                onToggle={() => setDiffExpanded((prev) => ({ ...prev, added: !prev.added }))}
              />

              {/* Removed */}
              <DiffSection
                label="Removed"
                count={diffData.counts.removed}
                items={diffData.removed}
                color="text-amber-400"
                bgColor="bg-amber-500/10"
                note={stickyMatches ? "Sticky matches enabled — items will be kept" : "Pending actions will be cancelled"}
                expanded={diffExpanded.removed ?? false}
                onToggle={() => setDiffExpanded((prev) => ({ ...prev, removed: !prev.removed }))}
              />

              {diffData.counts.added === 0 && diffData.counts.removed === 0 && (
                <p className="text-sm text-muted-foreground text-center py-2">
                  No changes to matches. All {diffData.counts.retained} items still match.
                </p>
              )}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              disabled={savingWithOption}
              onClick={() => setShowDiffDialog(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={savingWithOption}
              onClick={async () => {
                setSavingWithOption(true);
                await handleSave({ clearMatches: false, runDetection: true, processActions: true });
                setSavingWithOption(false);
                setShowDiffDialog(false);
              }}
            >
              {savingWithOption ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Confirm and Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New rule set: prompt to detect after saving */}
      <AlertDialog open={showNewSaveOptions} onOpenChange={(open) => { if (!savingWithOption) setShowNewSaveOptions(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save Rule Set</AlertDialogTitle>
            <AlertDialogDescription>
              Would you like to detect matches after saving?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <Button
              variant="default"
              disabled={savingWithOption}
              onClick={async () => {
                setSavingWithOption(true);
                await handleSave({ clearMatches: false, runDetection: true });
                setSavingWithOption(false);
                setShowNewSaveOptions(false);
              }}
            >
              {savingWithOption ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save and detect matches
            </Button>
            <Button
              variant="outline"
              disabled={savingWithOption}
              onClick={async () => {
                setSavingWithOption(true);
                await handleSave({ clearMatches: false, runDetection: false });
                setSavingWithOption(false);
                setShowNewSaveOptions(false);
              }}
            >
              Save only
            </Button>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingWithOption}>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reschedule pending actions prompt */}
      <AlertDialog open={showRescheduleDialog} onOpenChange={setShowRescheduleDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update Pending Actions</AlertDialogTitle>
            <AlertDialogDescription>
              Action delay changed from {rescheduleOldDelay} to {rescheduleNewDelay} day{rescheduleNewDelay !== 1 ? "s" : ""}.
              Would you like to reschedule existing pending actions to {rescheduleNewDelay} day{rescheduleNewDelay !== 1 ? "s" : ""} from today?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No, keep current schedule</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!activeRuleSetId) return;
                try {
                  const res = await fetch(`/api/lifecycle/rules/${activeRuleSetId}/reschedule-actions`, {
                    method: "POST",
                  });
                  if (res.ok) {
                    const data = await res.json();
                    if (data.updated > 0) {
                      toast.success(`Rescheduled ${data.updated} pending action${data.updated !== 1 ? "s" : ""}`);
                    } else {
                      toast.success("No pending actions to reschedule");
                    }
                  } else {
                    toast.error("Failed to reschedule actions");
                  }
                } catch {
                  toast.error("Failed to reschedule actions");
                }
              }}
            >
              Yes, reschedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
        </div>
      </div>

      {selectedItem && (
        <MediaDetailSidePanel
          item={selectedItem}
          mediaType={mediaType}
          onClose={() => setSelectedItem(null)}
          width={panelWidth}
          resizeHandleProps={resizeHandleProps}
          matchedCriteria={selectedItem.matchedCriteria}
          ruleGroups={groups}
          builderConfig={ruleBuilderConfig}
          allActualValues={selectedItem.actualValues}
        />
      )}
    </div>
  );
}
