"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getServerTypeLabel } from "@/lib/server-styles";
import { ServerTypeChip } from "@/components/server-type-chip";
import { ColorChip } from "@/components/color-chip";
import { findScrollContainer } from "@/lib/scroll-utils";
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
import { IntegrationUnreachableBanner } from "@/components/integration-unreachable-banner";
import { useIntegrationsHealth, deriveIntegrationsStatus, arrTypeForMediaType } from "@/hooks/use-integrations-health";
import { hasArrRules, hasSeerrRules } from "@/lib/conditions";
import { MediaTable } from "@/components/media-table";
import { MediaDetailSidePanel, type MatchedCriterion } from "@/components/media-detail-side-panel";
import { usePanelResize } from "@/hooks/use-panel-resize";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import type { MediaItemWithRelations } from "@/lib/types";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import { AlertTriangle, Calendar, Check, ChevronsUpDown, ClipboardPaste, Clock, Copy, ExternalLink, Eye, FileText, FlaskConical, HardDrive, LayoutGrid, Loader2, Save, Search, ShieldOff, SlidersHorizontal, TableProperties, Trash2, Upload, X } from "lucide-react";
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
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { useCardSize, estimateContentWidth } from "@/hooks/use-card-size";
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
import { QueryProgress, useStreamProgress } from "@/components/query-progress";
import { consumeProgressStream } from "@/lib/progress/client";

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
  targetQualityProfileId: number | null;
  addImportExclusion: boolean;
  searchAfterAction: boolean;
  addArrTags: string;
  removeArrTags: string;
  collectionEnabled: boolean;
  selectedCollectionId: string;
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

interface CollectionDefinition {
  id: string;
  name: string;
  sortName: string | null;
  homeScreen: boolean;
  recommended: boolean;
  sort: string;
  _count?: { ruleSets: number };
}

interface SavedRuleSet {
  id: string;
  name: string;
  type: string;
  rules: LifecycleRule[] | LifecycleRuleGroup[];
  enabled: boolean;
  seriesScope?: boolean;
  actionEnabled: boolean;
  actionType: string | null;
  actionDelayDays: number;
  arrInstanceId: string | null;
  targetQualityProfileId?: number | null;
  addImportExclusion: boolean;
  searchAfterAction?: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  collectionId: string | null;
  collection?: CollectionDefinition | null;
  discordNotifyOnAction: boolean;
  discordNotifyOnMatch?: boolean;
  stickyMatches?: boolean;
  serverIds: string[];
  createdAt: string;
}

// Sentinel for the "Create new collection…" dropdown option.
const NEW_COLLECTION = "__new__";

function isDestructiveAction(actionType: string): boolean {
  return actionType.includes("DELETE");
}

function isQualityProfileChangeAction(actionType: string): boolean {
  return actionType.startsWith("CHANGE_QUALITY_PROFILE_");
}

function legacyToGroups(rules: LifecycleRule[] | LifecycleRuleGroup[]): LifecycleRuleGroup[] {
  if (rules.length === 0) return [];
  if ("rules" in rules[0]) {
    return (rules as LifecycleRuleGroup[]).map((g) => ({
      ...g,
      groups: g.groups ?? [],
    }));
  }
  const flat = rules as LifecycleRule[];
  const groups: LifecycleRuleGroup[] = [
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

function countRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): number {
  if (rules.length === 0) return 0;
  if ("rules" in rules[0]) {
    return countAllRules(rules as LifecycleRuleGroup[]);
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
  rules: LifecycleRuleGroup[];
  seriesScope?: boolean;
  enabled: boolean;
  actionEnabled: boolean;
  actionType: string | null;
  actionDelayDays: number;
  addImportExclusion: boolean;
  searchAfterAction?: boolean;
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
  type: string;
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
const CARD_QUALITY_BAR_HEIGHT = 12;
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
    const containerWidth = container?.offsetWidth || estimateContentWidth(window.innerWidth);
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
              ref={virtualizer.measureElement}
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
                        isDiffActive && diffStatus === "removed" && "ring-1 ring-amber/70 opacity-60",
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
                        hoverContent={
                          <MediaHoverPopover
                            imageAspect={aspectRatio}
                            data={{
                              title: item.parentTitle ? `${item.parentTitle} — ${item.title}` : item.title,
                              year: item.year,
                              summary: item.summary,
                              contentRating: item.contentRating,
                              rating: item.rating,
                              audienceRating: item.audienceRating,
                              ratingImage: item.ratingImage,
                              audienceRatingImage: item.audienceRatingImage,
                              duration: item.duration,
                              resolution: item.resolution,
                              dynamicRange: item.dynamicRange,
                              audioProfile: item.audioProfile,
                              fileSize: item.fileSize,
                              genres: item.genres,
                              studio: item.studio,
                              playCount: item.playCount,
                              lastPlayedAt: item.lastPlayedAt,
                              addedAt: item.addedAt,
                              servers: item.servers,
                            }}
                          />
                        }
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

/** Tinted chip for rule-set capability flags in the saved list. */
function FeatureChip({
  tone,
  children,
}: {
  tone: "green" | "amber" | "sky" | "purple" | "cyan" | "muted";
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    green: "border-green/30 bg-green-dim text-green",
    amber: "border-amber/30 bg-amber-dim text-amber",
    sky: "border-sky/30 bg-sky-dim text-sky",
    purple: "border-purple-400/30 bg-purple-400/15 text-purple-400",
    cyan: "border-cyan-400/30 bg-cyan-400/15 text-cyan-400",
    muted: "border-border bg-muted/40 text-muted-foreground",
  };
  return (
    <ColorChip className={`text-[10px] font-medium ${tones[tone]}`}>{children}</ColorChip>
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
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [name, setName] = useState("");
  // Only flag a missing name after the user has interacted with the field
  const [nameTouched, setNameTouched] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [exportJson, setExportJson] = useState("");
  const [copied, setCopied] = useState(false);
  const [groups, setGroups] = useState<LifecycleRuleGroup[]>([]);
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  const selectedItem = useMemo(
    () => (selectedItemId ? preview.find((p) => p.id === selectedItemId) ?? null : null),
    [preview, selectedItemId],
  );
  const [savedRuleSets, setSavedRuleSets] = useState<SavedRuleSet[]>([]);
  const [activeRuleSetId, setActiveRuleSetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const { state: previewProgress, handleUpdate: onPreviewProgress, reset: resetPreviewProgress } = useStreamProgress();
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
    const scroller = findScrollContainer();
    const scrollTop = scroller?.scrollTop ?? 0;
    setPreviewViewMode(mode);
    localStorage.setItem("lifecycle-preview-view-mode", mode);
    requestAnimationFrame(() => {
      scroller?.scrollTo({ top: scrollTop, behavior: "instant" });
    });
  }, []);
  const { size: cardSize, setSize: setCardSize } = useCardSize();
  const { show: showCardField, showServers, setVisible: setCardFieldVisible, prefs: cardPrefs } = useCardDisplay(
    mediaType === "MUSIC" ? "MUSIC" : mediaType === "SERIES" ? "SERIES" : "MOVIE",
  );
  const { getHex } = useChipColors();

  // Exception tracking for preview indicator
  const [exceptedItemIds, setExceptedItemIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/lifecycle/exceptions");
        if (!response.ok || cancelled) return;
        const data = await response.json();
        if (cancelled) return;
        setExceptedItemIds(new Set((data.exceptions || []).map((e: { mediaItem: { id: string } }) => e.mediaItem.id)));
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, []);
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
  const [targetQualityProfileId, setTargetQualityProfileId] = useState<number | null>(null);
  const [arrQualityProfiles, setArrQualityProfiles] = useState<Array<{ id: number; name: string }>>([]);
  // Tracks the lifecycle of the per-instance metadata fetch so the dropdown
  // can distinguish "loading" from "fetch failed" from "instance has no
  // profiles" — and so Save can be blocked until we actually know whether
  // the saved targetQualityProfileId is valid on this instance.
  const [arrProfilesStatus, setArrProfilesStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [addImportExclusion, setAddImportExclusion] = useState(false);
  const [searchAfterAction, setSearchAfterAction] = useState(false);
  const [addArrTags, setAddArrTags] = useState<string[]>([]);
  const [removeArrTags, setRemoveArrTags] = useState<string[]>([]);
  const [manageTagsEnabled, setManageTagsEnabled] = useState(false);
  const [tagMode, setTagMode] = useState<"add" | "remove">("add");
  const [arrInstances, setArrInstances] = useState<ArrInstance[]>([]);
  const [seerrConnected, setSeerrConnected] = useState(false);

  const { health: integrationsHealth } = useIntegrationsHealth();
  const relevantArrTypes = useMemo(
    () => [arrTypeForMediaType(mediaType)] as const,
    [mediaType],
  );
  // Only the rule set's selected Arr instance matters for reachability.
  // If none is selected, pass an empty array so the banner stays silent
  // (nothing to be unreachable about until the user picks an instance).
  const arrInstanceIds = useMemo<readonly string[]>(
    () => (arrInstanceId ? [arrInstanceId] : []),
    [arrInstanceId],
  );
  const integrationsStatus = useMemo(
    () => deriveIntegrationsStatus(integrationsHealth, {
      relevantArrTypes,
      arrInstanceIds,
    }),
    [integrationsHealth, relevantArrTypes, arrInstanceIds],
  );
  const ruleUsesArr = useMemo(() => hasArrRules(groups), [groups]);
  const ruleUsesSeerr = useMemo(() => hasSeerrRules(groups), [groups]);

  // Recycle bin safety check
  const [recycleBinStatus, setRecycleBinStatus] = useState<{
    enabled: boolean | null;
    arrUrl: string | null;
  } | null>(null);
  const recycleBinAcknowledgedRef = useRef<Set<string>>(new Set());
  const [showRecycleBinModal, setShowRecycleBinModal] = useState(false);
  const [recycleBinAcknowledged, setRecycleBinAcknowledged] = useState(false);
  const pendingSaveOptionsRef = useRef<{ clearMatches?: boolean; runDetection?: boolean; processActions?: boolean } | undefined>(undefined);
  // Increments on every loadRuleSet / newRuleSet call. Async paths inside loadRuleSet
  // capture the token at start and bail if the active rule set has changed since.
  const loadTokenRef = useRef(0);
  // Same pattern for preview — rapid Preview clicks would otherwise let an earlier
  // response overwrite the result of a later one.
  const previewTokenRef = useRef(0);

  // Collection config — a reusable collection definition is selected from a
  // dropdown (or created inline). The settings fields below edit the SHARED
  // collection, so saving them applies to every rule synced to that collection.
  const [collections, setCollections] = useState<CollectionDefinition[]>([]);
  const [collectionEnabled, setCollectionEnabled] = useState(false);
  // "" = none picked yet, NEW_COLLECTION = creating, otherwise an existing id.
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [collectionName, setCollectionName] = useState("");
  const [collectionSortName, setCollectionSortName] = useState("");
  const [collectionHomeScreen, setCollectionHomeScreen] = useState(false);
  const [collectionRecommended, setCollectionRecommended] = useState(false);
  const [collectionSort, setCollectionSort] = useState("ALPHABETICAL");
  const [showDeleteCollectionDialog, setShowDeleteCollectionDialog] = useState(false);
  const [deletingCollection, setDeletingCollection] = useState(false);
  const isExistingCollectionSelected =
    !!selectedCollectionId && selectedCollectionId !== NEW_COLLECTION;

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
  const searchParams = useSearchParams();
  const ruleSetIdFromUrl = searchParams.get("ruleSet");
  const hydratedFromUrlRef = useRef(false);

  // Dirty tracking — snapshot of last-saved/loaded state
  const [snapshot, setSnapshot] = useState<RuleSetSnapshot | null>(null);

  const isDirty = useMemo(() => {
    if (!snapshot) return true; // New rule set — always allow saving
    return (
      snapshot.name !== name ||
      snapshot.groups !== JSON.stringify(groups) ||
      snapshot.enabled !== enabled ||
      snapshot.seriesScope !== seriesScope ||
      snapshot.actionEnabled !== actionEnabled ||
      snapshot.actionType !== actionType ||
      snapshot.actionDelayDays !== actionDelayDays ||
      snapshot.arrInstanceId !== arrInstanceId ||
      // Compare the EFFECTIVE persisted profile (null for non-quality actions,
      // matching what the save body writes) so a leftover targetQualityProfileId
      // from a since-changed action type doesn't spuriously mark the form dirty
      // after a reload reads null from the DB.
      (isQualityProfileChangeAction(snapshot.actionType) ? snapshot.targetQualityProfileId : null) !==
        (isQualityProfileChangeAction(actionType) ? targetQualityProfileId : null) ||
      snapshot.addImportExclusion !== addImportExclusion ||
      snapshot.searchAfterAction !== searchAfterAction ||
      snapshot.addArrTags !== JSON.stringify([...addArrTags].sort()) ||
      snapshot.removeArrTags !== JSON.stringify([...removeArrTags].sort()) ||
      snapshot.collectionEnabled !== collectionEnabled ||
      snapshot.selectedCollectionId !== selectedCollectionId ||
      snapshot.collectionName !== collectionName ||
      snapshot.collectionSortName !== collectionSortName ||
      snapshot.collectionHomeScreen !== collectionHomeScreen ||
      snapshot.collectionRecommended !== collectionRecommended ||
      snapshot.collectionSort !== collectionSort ||
      snapshot.discordNotifyOnAction !== discordNotifyOnAction ||
      snapshot.discordNotifyOnMatch !== discordNotifyOnMatch ||
      snapshot.stickyMatches !== stickyMatches ||
      snapshot.serverIds !== JSON.stringify([...serverIds].sort())
    );
  }, [
    snapshot,
    name, groups, enabled, seriesScope, actionEnabled, actionType, actionDelayDays,
    arrInstanceId, targetQualityProfileId, addImportExclusion, searchAfterAction, addArrTags, removeArrTags,
    collectionEnabled, selectedCollectionId, collectionName, collectionSortName, collectionHomeScreen,
    collectionRecommended, collectionSort, discordNotifyOnAction, discordNotifyOnMatch, stickyMatches, serverIds,
  ]);

  // Whether rule logic (rules/scope/servers) changed vs only config fields
  const rulesChanged = useMemo(() => {
    if (!snapshot) return true;
    return (
      snapshot.groups !== JSON.stringify(groups) ||
      snapshot.seriesScope !== seriesScope ||
      snapshot.serverIds !== JSON.stringify([...serverIds].sort())
    );
  }, [snapshot, groups, seriesScope, serverIds]);

  // The saved targetQualityProfileId no longer exists on the selected Arr
  // instance (e.g. the user deleted the profile from Sonarr/Radarr/Lidarr,
  // or this rule was imported from a different instance). Block save until
  // a valid profile is re-picked so we don't persist a broken id. Only
  // evaluate after the metadata fetch has resolved — while loading or after
  // a fetch error we have no authoritative list to compare against.
  const targetProfileMissing = useMemo(() => {
    if (!isQualityProfileChangeAction(actionType)) return false;
    if (!arrInstanceId) return false;
    if (arrProfilesStatus !== "ready") return false;
    if (targetQualityProfileId === null) return false;
    return !arrQualityProfiles.some((p) => p.id === targetQualityProfileId);
  }, [actionType, arrInstanceId, arrProfilesStatus, arrQualityProfiles, targetQualityProfileId]);

  // Post-save match search prompt
  const [showSaveOptions, setShowSaveOptions] = useState(false);
  const [showNewSaveOptions, setShowNewSaveOptions] = useState(false);
  const [savingWithOption, setSavingWithOption] = useState(false);

  // Reschedule pending actions prompt (when actionDelayDays changes)
  const [showRescheduleDialog, setShowRescheduleDialog] = useState(false);
  const [rescheduleOldDelay, setRescheduleOldDelay] = useState(0);
  const [rescheduleNewDelay, setRescheduleNewDelay] = useState(0);
  const [rescheduling, setRescheduling] = useState(false);

  // Diff preview before re-detect
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [showDiffDialog, setShowDiffDialog] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState<Record<string, boolean>>({});

  // Preview diff highlighting
  const [previewDiffMap, setPreviewDiffMap] = useState<Map<string, "added" | "removed" | "retained">>(new Map());
  const [previewDiffCounts, setPreviewDiffCounts] = useState<{ added: number; removed: number; retained: number } | null>(null);

  // Ref to the scroll container to preserve scroll position across re-renders

  // Which collection this rule fed before the current edit — so a save that
  // reassigns the rule to a different collection re-syncs the old one too
  // (dropping this rule's items from it).
  const [prevCollectionId, setPrevCollectionId] = useState<string | null>(null);

  // How many rule sets reference the selected collection (from the fetched
  // list), and how many of those are OTHER rules (excluding the one being
  // edited). A collection can be deleted when no OTHER rule uses it — deleting
  // from the last rule detaches that rule via the FK.
  const selectedCollectionUsage = isExistingCollectionSelected
    ? (collections.find((c) => c.id === selectedCollectionId)?._count?.ruleSets ?? 0)
    : 0;
  const currentRuleUsesSelected =
    isExistingCollectionSelected && prevCollectionId === selectedCollectionId;
  const otherCollectionUsage = selectedCollectionUsage - (currentRuleUsesSelected ? 1 : 0);

  // Test Media
  const [showTestMediaDialog, setShowTestMediaDialog] = useState(false);
  const [testMediaSearch, setTestMediaSearch] = useState("");
  const [testMediaResults, setTestMediaResults] = useState<Array<{ id: string; title: string; parentTitle?: string | null; year?: number | null; thumbUrl?: string | null; type: string }>>([]);
  const [testMediaSearching, setTestMediaSearching] = useState(false);
  const [testMediaSelected, setTestMediaSelected] = useState<{ id: string; title: string; parentTitle?: string | null; year?: number | null } | null>(null);
  const [testMediaEvaluating, setTestMediaEvaluating] = useState(false);
  const [testMediaResult, setTestMediaResult] = useState<{ matches: boolean; matchedCriteria: MatchedCriterion[]; actualValues: Record<string, string> } | null>(null);
  const testMediaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchDistinctValues = async () => {
    try {
      const response = await fetch("/api/media/distinct-values");
      const data = await response.json();
      // Merge rather than replace: Seerr requester names (seerrRequestedBy) and
      // Arr metadata (arrTag, arrQualityProfile) are fetched separately and
      // merged into distinctValues. A bare setDistinctValues(data) would clobber
      // them when this fetch resolves after those, dropping the enumerated
      // "Requested By" dropdown back to a raw text input.
      setDistinctValues((prev) => ({ ...prev, ...data }));
    } catch (error) {
      console.error("Failed to fetch distinct values:", error);
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
      setServers((data.servers || []).map((s: { id: string; name: string; type: string }) => ({ id: s.id, name: s.name, type: s.type })));
    } catch (error) {
      console.error("Failed to fetch servers:", error);
    }
  };

  // The user's reusable collections for this library type — populates the
  // collection dropdown. Returns the list so callers can use it before the
  // async state update commits.
  const fetchCollections = async (): Promise<CollectionDefinition[]> => {
    try {
      const response = await fetch(`/api/lifecycle/collections?type=${mediaType}`);
      const data = await response.json();
      const list: CollectionDefinition[] = data.collections || [];
      setCollections(list);
      return list;
    } catch (error) {
      console.error("Failed to fetch collections:", error);
      return [];
    }
  };

  useEffect(() => {
    void (async () => {
      await Promise.all([
        fetchRuleSets(),
        fetchArrInstances(),
        fetchSeerrInstances(),
        fetchDistinctValues(),
        fetchServers(),
        fetchCollections(),
      ]);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch arr-specific metadata (tags, quality profiles, languages) when an instance is selected.
  // The "reset when arrInstanceId is cleared" half of this lives in handleArrInstanceChange below
  // — keeping it in the change handler avoids the set-state-in-effect anti-pattern.
  useEffect(() => {
    // Idle reset is handled by the imperative setters (handleArrInstanceChange,
    // load/import/new flows) — the effect only runs when we have an instance
    // to fetch from.
    if (!arrInstanceId) return;
    let cancelled = false;
    void (async () => {
      // "loading" is set inside the async block (after commit) rather than
      // in the effect body so we don't synchronously cascade renders.
      setArrProfilesStatus("loading");
      try {
        const res = await fetch(`/api/integrations/${arrApiPath}/${arrInstanceId}/metadata`);
        if (cancelled) return;
        if (!res.ok) {
          setArrProfilesStatus("error");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        const profiles: Array<{ id: number; name: string }> = data.qualityProfiles ?? [];
        setArrQualityProfiles(profiles);
        setDistinctValues((prev) => ({
          ...prev,
          arrTag: data.tags?.map((t: { label: string }) => t.label) ?? [],
          arrQualityProfile: profiles.map((p) => p.name),
          arrOriginalLanguage: data.languages ?? [],
          // Enumerable arr fields sourced per-type by the metadata route:
          // Sonarr supplies statuses/seriesTypes, Radarr supplies qualityNames.
          // Absent keys fall back to [] so the builder hides the dropdown only
          // when there's genuinely nothing to enumerate.
          arrStatus: data.statuses ?? [],
          arrSeriesType: data.seriesTypes ?? [],
          arrQualityName: data.qualityNames ?? [],
        }));
        setArrProfilesStatus("ready");
      } catch {
        if (!cancelled) setArrProfilesStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [arrInstanceId, arrApiPath]);

  const handleArrInstanceChange = (newId: string) => {
    setArrInstanceId(newId);
    setTargetQualityProfileId(null);
    // Clear stale profiles immediately so the dropdown can't briefly show
    // IDs from the previous Arr instance while the new fetch is in flight.
    setArrQualityProfiles([]);
    setArrProfilesStatus(newId ? "loading" : "idle");
    if (!newId) {
      setDistinctValues((prev) => ({
        ...prev,
        arrTag: [],
        arrQualityProfile: [],
        arrOriginalLanguage: [],
        arrStatus: [],
        arrSeriesType: [],
        arrQualityName: [],
      }));
      setManageTagsEnabled(false);
      setAddArrTags([]);
      setRemoveArrTags([]);
      if (actionType !== "DO_NOTHING") {
        setActionType("DO_NOTHING");
      }
    }
  };

  // Fetch Arr recycle bin status when destructive action + Arr instance are selected.
  // The early-return path used to call setRecycleBinStatus(null); removed because consumers
  // (recycle-bin banner at the bottom of the destructive-action card and the save-time modal)
  // are already gated by isDestructiveAction(actionType) / modal-open state, so stale data
  // can never render when conditions are off.
  useEffect(() => {
    if (!arrInstanceId || !actionEnabled || !isDestructiveAction(actionType)) return;
    let cancelled = false;
    fetch(`/api/integrations/${arrApiPath}/${arrInstanceId}/recycle-bin`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setRecycleBinStatus({
          enabled: data.enabled ?? null,
          arrUrl: data.arrUrl ?? null,
        });
      })
      .catch(() => {
        // Leave previous status untouched on transient errors.
      });
    return () => {
      cancelled = true;
    };
  }, [arrInstanceId, actionType, actionEnabled, arrApiPath]);

  const handleSave = async (options?: { clearMatches?: boolean; runDetection?: boolean; processActions?: boolean }) => {
    const needsCheck =
      actionEnabled &&
      isDestructiveAction(actionType) &&
      !!arrInstanceId &&
      !recycleBinAcknowledgedRef.current.has(arrInstanceId);

    if (needsCheck) {
      try {
        const r = await fetch(`/api/integrations/${arrApiPath}/${arrInstanceId}/recycle-bin`);
        const data = await r.json();
        if (data.enabled === false) {
          setRecycleBinStatus({ enabled: false, arrUrl: data.arrUrl ?? null });
          pendingSaveOptionsRef.current = options;
          setRecycleBinAcknowledged(false);
          setShowRecycleBinModal(true);
          return;
        }
      } catch {
        // If the check fails, proceed — don't block save on transient errors
      }
    }
    return executeSave(options);
  };

  const handleDeleteCollection = async () => {
    if (!isExistingCollectionSelected) return;
    const id = selectedCollectionId;
    // If the rule being edited is (the last) one using it, name it so the server
    // excludes it from the in-use check; the FK SetNull then detaches it.
    const detachedFromCurrent = prevCollectionId === id;
    setDeletingCollection(true);
    try {
      const qs = activeRuleSetId ? `?ruleSetId=${activeRuleSetId}` : "";
      const res = await fetch(`/api/lifecycle/collections/${id}${qs}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        toast.error("Couldn't delete collection", { description: d?.error || "Unknown error" });
        return;
      }
      toast.success("Collection deleted");
      // Clear the collection portion of the editor.
      setSelectedCollectionId("");
      setCollectionName("");
      setCollectionSortName("");
      setCollectionHomeScreen(false);
      setCollectionRecommended(false);
      setCollectionSort("ALPHABETICAL");
      setPrevCollectionId(null);
      if (detachedFromCurrent) {
        // The current (saved) rule was detached server-side. Turn the toggle off
        // and fold the cleared collection state into the baseline so it doesn't
        // read as an unsaved change.
        setCollectionEnabled(false);
        setSnapshot((s) =>
          s
            ? {
                ...s,
                collectionEnabled: false,
                selectedCollectionId: "",
                collectionName: "",
                collectionSortName: "",
                collectionHomeScreen: false,
                collectionRecommended: false,
                collectionSort: "ALPHABETICAL",
              }
            : s,
        );
      }
      await fetchRuleSets();
      await fetchCollections();
    } catch (error) {
      toast.error("Couldn't delete collection", { description: String(error) });
    } finally {
      setDeletingCollection(false);
      setShowDeleteCollectionDialog(false);
    }
  };

  const executeSave = async (options?: { clearMatches?: boolean; runDetection?: boolean; processActions?: boolean }) => {
    if (!name || countAllRules(groups) === 0) return;
    const clearMatches = options?.clearMatches ?? true;
    const runDetection = options?.runDetection ?? false;
    const processActions = options?.processActions ?? false;
    setLoading(true);
    setSaveError(null);
    try {
      // Resolve which collection this rule feeds. Settings live on the shared
      // collection definition, so create it (new) or update it (existing) before
      // saving the rule set. Saving the settings here applies to every rule
      // synced to that collection.
      let targetCollectionId: string | null = null;
      if (collectionEnabled) {
        if (!collectionName.trim()) {
          setSaveError("Collection name is required");
          return;
        }
        const settings = {
          sortName: collectionSortName || null,
          homeScreen: collectionHomeScreen,
          recommended: collectionRecommended,
          sort: collectionSort,
        };
        if (selectedCollectionId && selectedCollectionId !== NEW_COLLECTION) {
          const res = await fetch(`/api/lifecycle/collections/${selectedCollectionId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: collectionName.trim(), ...settings }),
          });
          if (!res.ok) {
            const d = await res.json().catch(() => null);
            setSaveError(d?.error || "Failed to update collection");
            return;
          }
          targetCollectionId = selectedCollectionId;
        } else {
          const res = await fetch("/api/lifecycle/collections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: collectionName.trim(), type: mediaType, ...settings }),
          });
          const d = await res.json().catch(() => null);
          if (!res.ok) {
            setSaveError(d?.error || "Failed to create collection");
            return;
          }
          targetCollectionId = d.collection.id as string;
          // Adopt the created collection immediately so a retry after a later
          // failure (e.g. duplicate rule-set name) updates it instead of trying
          // to re-create — which would 409 on the now-existing name.
          setSelectedCollectionId(d.collection.id as string);
        }
      }

      const body: Record<string, unknown> = {
        name,
        rules: groups,
        enabled,
        actionEnabled,
        actionType: actionType || null,
        actionDelayDays,
        arrInstanceId: arrInstanceId || null,
        targetQualityProfileId: isQualityProfileChangeAction(actionType) ? targetQualityProfileId : null,
        addImportExclusion,
        searchAfterAction,
        addArrTags,
        removeArrTags,
        collectionId: targetCollectionId,
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
      await fetchCollections();

      // Reconcile Plex collections from current matches. If the rule moved off a
      // previous collection, re-sync that one so it drops this rule's items. The
      // target collection is synced now only when detection isn't going to run
      // (the post-detection sync handles it otherwise).
      const toSync = new Set<string>();
      if (prevCollectionId && prevCollectionId !== targetCollectionId) toSync.add(prevCollectionId);
      if (targetCollectionId && !(runDetection && savedRuleSetId)) toSync.add(targetCollectionId);
      for (const cid of toSync) {
        try {
          await fetch("/api/lifecycle/collections/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ collectionId: cid }),
          });
        } catch {
          // Best-effort Plex reconciliation
        }
      }

      setPrevCollectionId(targetCollectionId);
      setSelectedCollectionId(targetCollectionId ?? "");

      toast.success("Rule set saved");

      // Check if actionDelayDays changed — prompt to reschedule pending actions
      const prevDelay = snapshot?.actionDelayDays;
      const delayChanged = prevDelay !== undefined && prevDelay !== actionDelayDays && savedRuleSetId;

      setSnapshot(takeSnapshot());
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);

      // Run detection if requested
      if (runDetection && savedRuleSetId) {
        try {
          const detectResponse = await fetch("/api/lifecycle/rules/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ruleSetId: savedRuleSetId, fullReEval: clearMatches, processActions }),
          });
          if (detectResponse.ok) {
            router.push("/lifecycle/matches");
          } else {
            const detectData = await detectResponse.json().catch(() => null);
            toast.error(detectData?.error ?? "Failed to detect matches");
          }
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
      toast.error("Failed to save rule set");
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    if (countAllRules(groups) === 0) return;
    const token = ++previewTokenRef.current;
    setPreviewing(true);
    resetPreviewProgress();
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

      // Consume the preview stream live so its progress events drive the bar.
      // The preview fetch resolves on headers (the route returns its ReadableStream
      // immediately), so reading it now streams progress right away while the diff
      // request runs in parallel. Joining both with Promise.all first would block
      // stream consumption behind the (equally heavy, non-streaming) diff, so the
      // buffered progress events arrive in one burst and the bar never paints.
      const previewResponse = await previewPromise;
      const previewData = await consumeProgressStream<{ items: PreviewItem[] }>(
        previewResponse,
        onPreviewProgress,
      );
      let mergedItems = previewData.items as PreviewItem[];

      // diffPromise (if any) has been running in parallel since above.
      const diffResponse = diffPromise ? await diffPromise : null;

      // Process diff data if available
      let nextDiffMap: Map<string, "added" | "removed" | "retained"> | null = null;
      let nextDiffCounts: DiffData["counts"] | null = null;
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

        nextDiffMap = statusMap;
        nextDiffCounts = diff.counts;
      }

      // Bail if a newer Preview was kicked off (or we navigated away) while we awaited.
      if (previewTokenRef.current !== token) return;

      if (nextDiffMap) {
        setPreviewDiffMap(nextDiffMap);
        setPreviewDiffCounts(nextDiffCounts);
      } else {
        setPreviewDiffMap(new Map());
        setPreviewDiffCounts(null);
      }

      // Preserve scroll position when preview results cause layout change
      const scroller = findScrollContainer();
      const scrollTop = scroller?.scrollTop ?? 0;
      setPreview(mergedItems);
      requestAnimationFrame(() => {
        scroller?.scrollTo({ top: scrollTop, behavior: "instant" });
      });
    } catch (error) {
      console.error("Failed to preview:", error);
    } finally {
      // Only clear the previewing flag if this is still the latest call;
      // otherwise the newer call owns the spinner.
      if (previewTokenRef.current === token) {
        setPreviewing(false);
        resetPreviewProgress();
      }
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

  // Fields stored as numeric values but serialized as strings (e.g. BigInt fileSize)
  // must be compared numerically — a lexicographic compare ranks "9000" above "10000".
  const NUMERIC_PREVIEW_FIELDS = new Set(["fileSize"]);

  const sortedPreview = [...preview].sort((a, b) => {
    if (!previewSortBy) return 0;
    const aVal = a[previewSortBy as keyof PreviewItem];
    const bVal = b[previewSortBy as keyof PreviewItem];
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    let cmp: number;
    if (NUMERIC_PREVIEW_FIELDS.has(previewSortBy)) {
      const aNum = Number(aVal);
      const bNum = Number(bVal);
      cmp = aNum < bNum ? -1 : aNum > bNum ? 1 : 0;
    } else {
      cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    }
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
    targetQualityProfileId,
    addImportExclusion,
    searchAfterAction,
    addArrTags: JSON.stringify([...addArrTags].sort()),
    removeArrTags: JSON.stringify([...removeArrTags].sort()),
    collectionEnabled,
    selectedCollectionId,
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
    const token = ++loadTokenRef.current;
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
    // Clear any profile list left over from a previously loaded rule set —
    // the effect below will repopulate from the new instance's metadata.
    setArrQualityProfiles([]);
    setArrProfilesStatus(ruleSet.arrInstanceId ? "loading" : "idle");
    setArrInstanceId(ruleSet.arrInstanceId ?? "");
    setTargetQualityProfileId(ruleSet.targetQualityProfileId ?? null);
    setAddImportExclusion(ruleSet.addImportExclusion ?? false);
    setSearchAfterAction(ruleSet.searchAfterAction ?? false);
    setAddArrTags(ruleSet.addArrTags ?? []);
    setRemoveArrTags(ruleSet.removeArrTags ?? []);
    setManageTagsEnabled((ruleSet.addArrTags ?? []).length > 0 || (ruleSet.removeArrTags ?? []).length > 0);
    setTagMode((ruleSet.addArrTags ?? []).length > 0 ? "add" : (ruleSet.removeArrTags ?? []).length > 0 ? "remove" : "add");
    setPreview([]);

    // Collection: settings come from the linked collection definition (the
    // shared source of truth), not from the rule set itself.
    const col = ruleSet.collection ?? null;
    const collectionEnabledVal = !!ruleSet.collectionId;
    const selectedIdVal = ruleSet.collectionId ?? "";
    const nameVal = col?.name ?? "";
    const sortNameVal = col?.sortName ?? "";
    const homeScreen = col?.homeScreen ?? false;
    const recommended = col?.recommended ?? false;
    const sortVal = col?.sort ?? "ALPHABETICAL";

    setCollectionEnabled(collectionEnabledVal);
    setSelectedCollectionId(selectedIdVal);
    setCollectionName(nameVal);
    setCollectionSortName(sortNameVal);
    setCollectionHomeScreen(homeScreen);
    setCollectionRecommended(recommended);
    setCollectionSort(sortVal);
    setPrevCollectionId(ruleSet.collectionId ?? null);

    setDiscordNotifyOnAction(ruleSet.discordNotifyOnAction ?? false);
    setDiscordNotifyOnMatch(ruleSet.discordNotifyOnMatch ?? false);
    setStickyMatches(ruleSet.stickyMatches ?? false);
    setServerIds(ruleSet.serverIds ?? []);

    // Bail if the user navigated away while loading.
    if (loadTokenRef.current !== token) return;

    // Capture snapshot from rule set data (state not yet updated)
    setSnapshot({
      name: ruleSet.name,
      groups: JSON.stringify(legacyToGroups(ruleSet.rules)),
      enabled: ruleSet.enabled ?? true,
      seriesScope: ruleSet.seriesScope ?? true,
      actionEnabled: ruleSet.actionEnabled,
      actionType: ruleSet.actionType ?? defaultActionType,
      actionDelayDays: ruleSet.actionDelayDays,
      arrInstanceId: ruleSet.arrInstanceId ?? "",
      targetQualityProfileId: ruleSet.targetQualityProfileId ?? null,
      addImportExclusion: ruleSet.addImportExclusion ?? false,
      searchAfterAction: ruleSet.searchAfterAction ?? false,
      addArrTags: JSON.stringify([...(ruleSet.addArrTags ?? [])].sort()),
      removeArrTags: JSON.stringify([...(ruleSet.removeArrTags ?? [])].sort()),
      collectionEnabled: collectionEnabledVal,
      selectedCollectionId: selectedIdVal,
      collectionName: nameVal,
      collectionSortName: sortNameVal,
      collectionHomeScreen: homeScreen,
      collectionRecommended: recommended,
      collectionSort: sortVal,
      discordNotifyOnAction: ruleSet.discordNotifyOnAction ?? false,
      discordNotifyOnMatch: ruleSet.discordNotifyOnMatch ?? false,
      stickyMatches: ruleSet.stickyMatches ?? false,
      serverIds: JSON.stringify([...(ruleSet.serverIds ?? [])].sort()),
    });
  };

  // Hydrate active rule set from `?ruleSet=<id>` once rule sets load.
  // Used by the "Convert query to lifecycle rule" flow to land the user on
  // the freshly created rule set. Strips the search param after hydrating
  // so refresh / back navigation doesn't re-trigger the load.
  //
  // Calling loadRuleSet (which cascades setState) from an effect is the
  // legitimate URL→state bridge case the lint rule's escape hatch is for —
  // there is no user interaction to hang off of, and the ref guard makes
  // this a true one-shot.
  useEffect(() => {
    if (hydratedFromUrlRef.current || !ruleSetIdFromUrl) return;
    if (savedRuleSets.length === 0) return;
    const match = savedRuleSets.find((rs) => rs.id === ruleSetIdFromUrl);
    if (match) {
      hydratedFromUrlRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadRuleSet(match);
      if (typeof window !== "undefined") {
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.hash,
        );
      }
      return;
    }
    // No match in this tab. The rule set might belong to a different library
    // type — re-fetch unfiltered and either redirect to the right tab or
    // surface a not-found message.
    hydratedFromUrlRef.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/lifecycle/rules");
        if (!res.ok) throw new Error("fetch failed");
        const data = (await res.json()) as { ruleSets: SavedRuleSet[] };
        const found = data.ruleSets.find((rs) => rs.id === ruleSetIdFromUrl);
        if (!found) {
          toast.error("Rule set not found", {
            description: "It may have been deleted.",
          });
          if (typeof window !== "undefined") {
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.hash,
            );
          }
          return;
        }
        const targetHash =
          found.type === "MOVIE" ? "movies" : found.type === "SERIES" ? "series" : "music";
        toast.info("Switching to the rule set's tab", {
          description: `This rule set is in the ${targetHash} tab.`,
        });
        if (typeof window !== "undefined") {
          window.location.replace(
            `${window.location.pathname}?ruleSet=${encodeURIComponent(found.id)}#${targetHash}`,
          );
        }
      } catch {
        // Network failure — surface it so the user isn't stranded on the
        // wrong tab with no explanation. Clear the param so refresh doesn't
        // loop on the same failure.
        toast.error("Couldn't locate the rule set", {
          description: "Check your network and refresh.",
        });
        if (typeof window !== "undefined") {
          window.history.replaceState(
            null,
            "",
            window.location.pathname + window.location.hash,
          );
        }
      }
    })();
  }, [ruleSetIdFromUrl, savedRuleSets]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Bump token to invalidate any in-flight loadRuleSet visibility fetches.
    loadTokenRef.current++;
    setName("");
    setNameTouched(false);
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
    setTargetQualityProfileId(null);
    setArrQualityProfiles([]);
    setArrProfilesStatus("idle");
    setAddImportExclusion(false);
    setSearchAfterAction(false);
    setStickyMatches(false);
    setAddArrTags([]);
    setRemoveArrTags([]);
    setManageTagsEnabled(false);
    setTagMode("add");
    setCollectionEnabled(false);
    setSelectedCollectionId("");
    setCollectionName("");
    setCollectionSortName("");
    setCollectionHomeScreen(false);
    setCollectionRecommended(false);
    setCollectionSort("ALPHABETICAL");
    setDiscordNotifyOnAction(false);
    setDiscordNotifyOnMatch(false);
    setServerIds([]);
    setPreview([]);
    setPrevCollectionId(null);
    setSnapshot(null);
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
      // Quality-profile ids are Arr-instance-specific and not portable across
      // installs, so we deliberately omit targetQualityProfileId from exports.
      // Imports require the user to pick a profile after selecting an instance.
      addImportExclusion,
      searchAfterAction,
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
      setArrProfilesStatus("idle");
      // Quality-profile ids are instance-specific — force the user to pick
      // a profile fresh after selecting an Arr instance.
      setTargetQualityProfileId(null);
      setArrQualityProfiles([]);
      setAddImportExclusion(data.addImportExclusion ?? false);
      setSearchAfterAction(data.searchAfterAction ?? false);
      setAddArrTags(data.addArrTags ?? []);
      setRemoveArrTags(data.removeArrTags ?? []);
      setManageTagsEnabled((data.addArrTags ?? []).length > 0 || (data.removeArrTags ?? []).length > 0);
      setTagMode((data.addArrTags ?? []).length > 0 ? "add" : (data.removeArrTags ?? []).length > 0 ? "remove" : "add");
      // Imported collection settings populate a fresh collection definition;
      // saving matches it to an existing collection by name or creates one.
      setCollectionEnabled(data.collectionEnabled ?? false);
      setSelectedCollectionId(data.collectionEnabled ? NEW_COLLECTION : "");
      setCollectionName(data.collectionName ?? "");
      setCollectionSortName(data.collectionSortName ?? "");
      setCollectionHomeScreen(data.collectionHomeScreen ?? false);
      setCollectionRecommended(data.collectionRecommended ?? false);
      setCollectionSort(data.collectionSort ?? "ALPHABETICAL");
      setPrevCollectionId(null);
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
    <>
    <div className={embedded ? undefined : "h-full overflow-y-auto"}>
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

      {/* Saved LifecycleRule Sets */}
      {savedRuleSets.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" />
              Saved Rule Sets
            </CardTitle>
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
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <span className="mr-1 font-mono text-[10.5px] text-faint">
                          {countRules(ruleSet.rules)} rule{countRules(ruleSet.rules) !== 1 && "s"}
                        </span>
                        {ruleSet.enabled ? (
                          <FeatureChip tone="green">Enabled</FeatureChip>
                        ) : (
                          <FeatureChip tone="muted">Disabled</FeatureChip>
                        )}
                        {ruleSet.enabled && ruleSet.actionEnabled && (
                          <FeatureChip tone="amber">Action</FeatureChip>
                        )}
                        {ruleSet.enabled && !!ruleSet.collectionId && (
                          <FeatureChip tone="sky">Collection</FeatureChip>
                        )}
                        {ruleSet.enabled && (ruleSet.addArrTags?.length > 0 || ruleSet.removeArrTags?.length > 0) && (
                          <FeatureChip tone="purple">Tags</FeatureChip>
                        )}
                        {scopeConfig && (
                          <FeatureChip tone="muted">
                            {ruleSet.seriesScope !== false ? scopeConfig.ruleSetEnabledLabel : scopeConfig.ruleSetDisabledLabel}
                          </FeatureChip>
                        )}
                        {ruleSet.serverIds?.length > 0 && (
                          <FeatureChip tone="cyan">
                            {ruleSet.serverIds.length} server{ruleSet.serverIds.length !== 1 ? "s" : ""}
                          </FeatureChip>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete rule set ${ruleSet.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConfirmId(ruleSet.id);
                      setDeleteConfirmName(ruleSet.name);
                      setDeleteConfirmHasCollection(!!ruleSet.collectionId);
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
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-4 w-4" />
            {activeRuleSetId ? "Edit Rule Set" : "Create Rule Set"}
          </CardTitle>
          <CardDescription>
            Define criteria to find {ruleDescription} matching specific conditions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <Input
              placeholder="Rule set name (e.g., 'Old unwatched 720p movies')"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setNameTouched(true)}
              className={`flex-1 min-w-0${!name && nameTouched ? " border-destructive" : ""}`}
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
                      {servers.map((server) => {
                        const displayName = `${server.name} (${getServerTypeLabel(server.type)})`;
                        return (
                          <CommandItem
                            key={server.id}
                            value={displayName}
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
                            <ServerTypeChip type={server.type} className="ml-1.5" />
                          </CommandItem>
                        );
                      })}
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
                      {server && <ServerTypeChip type={server.type} />}
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
              <div className="flex items-center gap-1">
                <Select
                  value={arrInstanceId}
                  onValueChange={handleArrInstanceChange}
                >
                  <SelectTrigger className={`w-64${!arrInstanceId && ((actionEnabled && (actionType !== "DO_NOTHING" || addArrTags.length > 0 || removeArrTags.length > 0)) || ruleUsesArr) ? " border-destructive" : ""}`}>
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
                {arrInstanceId && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => handleArrInstanceChange("")}
                          aria-label={`Clear ${arrServiceName} instance`}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Clear {arrServiceName} instance</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
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

          <IntegrationUnreachableBanner
            health={integrationsHealth}
            hasArrRules={ruleUsesArr}
            hasSeerrRules={ruleUsesSeerr}
            relevantArrTypes={relevantArrTypes}
            arrInstanceIds={arrInstanceIds}
            subjectLabel="This rule set"
          />

          <BuilderWithPseudocode groups={groups} config={ruleBuilderConfig}>
            <RuleBuilder
              groups={groups}
              onChange={setGroups}
              distinctValues={distinctValues}
              arrConnected={!!arrInstanceId}
              arrUnreachable={integrationsStatus.arrUnreachable}
              arrAvailableForLibrary={arrInstances.length > 0}
              seerrConnected={mediaType === "MUSIC" ? undefined : seerrConnected}
              seerrUnreachable={integrationsStatus.seerrUnreachable}
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
                    {recycleBinStatus?.enabled === false && isDestructiveAction(actionType) && (
                      <p className="mt-2 text-xs text-amber flex items-center gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Recycle bin is disabled on this {arrServiceName} instance. Deletes will be permanent.
                      </p>
                    )}
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

                {isQualityProfileChangeAction(actionType) && (
                  <div>
                    <Label>Target quality profile</Label>
                    <Select
                      value={
                        targetQualityProfileId !== null && !targetProfileMissing
                          ? String(targetQualityProfileId)
                          : ""
                      }
                      onValueChange={(v) => setTargetQualityProfileId(v ? parseInt(v, 10) : null)}
                      disabled={
                        !arrInstanceId ||
                        arrProfilesStatus === "loading" ||
                        arrProfilesStatus === "error" ||
                        arrQualityProfiles.length === 0
                      }
                    >
                      <SelectTrigger
                        className={`mt-1.5 sm:w-72${arrInstanceId && arrProfilesStatus === "ready" && (targetQualityProfileId === null || targetProfileMissing) ? " border-destructive" : ""}`}
                      >
                        <SelectValue
                          placeholder={
                            !arrInstanceId
                              ? `Select a ${arrServiceName} server above`
                              : arrProfilesStatus === "loading"
                                ? `Loading profiles from ${arrServiceName}…`
                                : arrProfilesStatus === "error"
                                  ? `Failed to load profiles from ${arrServiceName}`
                                  : arrQualityProfiles.length === 0
                                    ? "No profiles available"
                                    : targetProfileMissing
                                      ? `Saved profile (id ${targetQualityProfileId}) no longer exists`
                                      : "Select a quality profile"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {arrQualityProfiles.map((profile) => (
                          <SelectItem key={profile.id} value={String(profile.id)}>
                            {profile.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {arrInstanceId && arrProfilesStatus === "error" ? (
                      <p className="mt-1.5 text-xs text-destructive flex items-center gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Could not reach {arrServiceName} to load quality profiles. Check the server is online and try again.
                      </p>
                    ) : targetProfileMissing ? (
                      <p className="mt-1.5 text-xs text-destructive flex items-center gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        The previously selected profile (id {targetQualityProfileId}) is no longer on this {arrServiceName} instance. Pick a new one to continue.
                      </p>
                    ) : (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Items already on this profile will be skipped.
                      </p>
                    )}
                  </div>
                )}

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
                      id="search-after-file-delete"
                      checked={searchAfterAction}
                      onCheckedChange={setSearchAfterAction}
                    />
                    <Label htmlFor="search-after-file-delete">
                      Search for new copy after file deletion
                    </Label>
                  </div>
                )}

                {isQualityProfileChangeAction(actionType) && (
                  <div className="flex items-center gap-3">
                    <Switch
                      id="search-after-profile-change"
                      checked={searchAfterAction}
                      onCheckedChange={setSearchAfterAction}
                    />
                    <Label htmlFor="search-after-profile-change">
                      Search for upgrade after profile change
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

                <Separator />

                {/* Manage Tags */}
                <div className="space-y-3">
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
                                  ? "bg-green/15 text-green"
                                  : "bg-red/15 text-red"
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
                  // Default to "create new" when there's nothing to pick from.
                  if (checked && !selectedCollectionId && collections.length === 0) {
                    setSelectedCollectionId(NEW_COLLECTION);
                  }
                }}
              />
              <Label htmlFor="collection-enabled" className="font-medium">
                Sync matches to a Plex collection
              </Label>
            </div>

            {collectionEnabled && (
              <>
                <div>
                  <Label>Collection</Label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Select
                      value={selectedCollectionId}
                      onValueChange={(val) => {
                        setSelectedCollectionId(val);
                        if (val === NEW_COLLECTION) {
                          setCollectionName("");
                          setCollectionSortName("");
                          setCollectionHomeScreen(false);
                          setCollectionRecommended(false);
                          setCollectionSort("ALPHABETICAL");
                        } else {
                          const c = collections.find((x) => x.id === val);
                          if (c) {
                            setCollectionName(c.name);
                            setCollectionSortName(c.sortName ?? "");
                            setCollectionHomeScreen(c.homeScreen);
                            setCollectionRecommended(c.recommended);
                            setCollectionSort(c.sort);
                          }
                        }
                      }}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select or create a collection…" />
                      </SelectTrigger>
                      <SelectContent>
                        {collections.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                            {c._count && c._count.ruleSets > 0
                              ? ` (${c._count.ruleSets} rule${c._count.ruleSets === 1 ? "" : "s"})`
                              : ""}
                          </SelectItem>
                        ))}
                        <SelectItem value={NEW_COLLECTION}>+ Create new collection…</SelectItem>
                      </SelectContent>
                    </Select>
                    {isExistingCollectionSelected && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="shrink-0 text-destructive hover:text-destructive"
                        disabled={deletingCollection || otherCollectionUsage > 0}
                        title={
                          otherCollectionUsage > 0
                            ? `In use by ${otherCollectionUsage} other rule${otherCollectionUsage === 1 ? "" : "s"} — remove it from ${otherCollectionUsage === 1 ? "that rule" : "them"} before deleting`
                            : "Delete this collection"
                        }
                        onClick={() => setShowDeleteCollectionDialog(true)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Multiple rules can sync to the same collection — their matches are
                    merged. These settings apply to every rule synced to it.
                  </p>
                  {otherCollectionUsage > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Also used by {otherCollectionUsage} other rule{otherCollectionUsage === 1 ? "" : "s"}. To delete it, remove it from {otherCollectionUsage === 1 ? "that rule" : "those rules"} first.
                    </p>
                  )}
                </div>

                {selectedCollectionId && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <Label htmlFor="collection-name">Collection name</Label>
                        <Input
                          id="collection-name"
                          placeholder="e.g., Leaving Soon"
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
                            <SelectItem value="ACTION_DATE">Action date</SelectItem>
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

          {ruleUsesArr && !arrInstanceId && (
            <div className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-amber shrink-0" />
              <div className="space-y-1">
                <p className="font-medium text-amber">
                  {arrServiceName} instance required
                </p>
                <p className="text-muted-foreground">
                  This rule set uses {arrServiceName} criteria but no instance is selected.
                  Pick one above so Preview, Test Media, and Save can evaluate those criteria.
                </p>
              </div>
            </div>
          )}

          {ruleUsesSeerr && !seerrConnected && (
            <div className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-amber shrink-0" />
              <div className="space-y-1">
                <p className="font-medium text-amber">
                  Seerr instance required
                </p>
                <p className="text-muted-foreground">
                  This rule set uses Seerr criteria but no Seerr instance is connected.
                  Connect Overseerr or Jellyseerr in Settings &rarr; Integrations so Preview,
                  Test Media, and Save can evaluate those criteria.
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              onClick={handlePreview}
              disabled={groups.length === 0 || !validateAllRules(groups) || previewing || serverIds.length === 0 || (ruleUsesArr && !arrInstanceId) || (ruleUsesSeerr && !seerrConnected)}
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
              disabled={groups.length === 0 || !validateAllRules(groups) || serverIds.length === 0 || (ruleUsesArr && !arrInstanceId) || (ruleUsesSeerr && !seerrConnected)}
              variant="secondary"
            >
              <FlaskConical className="mr-2 h-4 w-4" />
              Test Media
            </Button>
            <Button
              onClick={() => {
                if (activeRuleSetId && !rulesChanged) {
                  // Config-only change — skip detection, just save
                  handleSave({ clearMatches: false, runDetection: false });
                } else if (activeRuleSetId) {
                  setShowSaveOptions(true);
                } else {
                  setShowNewSaveOptions(true);
                }
              }}
              disabled={!isDirty || justSaved || !name || groups.length === 0 || !validateAllRules(groups) || loading || serverIds.length === 0 || (actionEnabled && (actionType !== "DO_NOTHING" || addArrTags.length > 0 || removeArrTags.length > 0) && !arrInstanceId) || (actionEnabled && isQualityProfileChangeAction(actionType) && targetQualityProfileId === null) || (actionEnabled && targetProfileMissing) || (actionEnabled && isQualityProfileChangeAction(actionType) && !!arrInstanceId && arrProfilesStatus !== "ready") || (collectionEnabled && !collectionName?.trim()) || (ruleUsesArr && !arrInstanceId) || (ruleUsesSeerr && !seerrConnected)}
              className={justSaved ? "bg-green hover:bg-green text-white" : ""}
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

          {previewing && previewProgress.phases.length > 0 && (
            <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-3">
              <QueryProgress state={previewProgress} />
            </div>
          )}

          {saveError && (
            <p className="text-sm text-destructive">{saveError}</p>
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
                  <Badge variant="outline" className="border-amber/50 text-amber">
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
              onItemClick={(item) => setSelectedItemId(item.id)}
              sortBy={previewSortBy}
              sortOrder={previewSortOrder}
              onSort={handlePreviewSort}
              mediaType={mediaType}
              exceptedItemIds={exceptedItemIds}
              renderHoverContent={(item) => (
                <MediaHoverPopover
                  imageUrl={`/api/media/${item.id}/image${mediaType !== "MOVIE" ? "?type=parent" : ""}`}
                  imageAspect={mediaType === "MUSIC" ? "square" : "poster"}
                  data={{
                    title: item.parentTitle ? `${item.parentTitle} — ${item.title}` : item.title,
                    year: item.year,
                    summary: item.summary,
                    contentRating: item.contentRating,
                    rating: item.rating,
                    audienceRating: item.audienceRating,
                    ratingImage: item.ratingImage,
                    audienceRatingImage: item.audienceRatingImage,
                    duration: item.duration,
                    resolution: item.resolution,
                    dynamicRange: item.dynamicRange,
                    audioProfile: item.audioProfile,
                    fileSize: item.fileSize,
                    genres: item.genres,
                    studio: item.studio,
                    playCount: item.playCount,
                    lastPlayedAt: item.lastPlayedAt,
                    addedAt: item.addedAt,
                    servers: item.servers,
                  }}
                />
              )}
              rowClassName={previewDiffMap.size > 0 ? (item) => {
                const status = previewDiffMap.get(item.id);
                if (status === "added") return "border-l-2 border-l-emerald-500/70 bg-emerald-500/5";
                if (status === "removed") return "border-l-2 border-l-amber/70 bg-amber/5 opacity-60";
                return undefined;
              } : undefined}
            />
          ) : (
            <PreviewCardGrid
              items={sortedPreview}
              mediaType={mediaType}
              onItemClick={(item) => setSelectedItemId(item.id)}
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
                        ? "bg-green hover:bg-green text-white"
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
                              className={`text-xs ${criterion.negate ? "border-red/30 text-red" : ""}`}
                            >
                              {criterion.groupName && (
                                <span className="text-sky mr-1">[{criterion.groupName}]</span>
                              )}
                              {criterion.negate && <span className="text-red mr-1">NOT</span>}
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
                    <> Its items will be removed from the linked Plex collection (the
                    collection itself is kept for any other rules using it).</>
                  )}
                </p>
                {deleteConfirmAddTags.length > 0 && (
                  <div className="rounded-md border border-amber/30 bg-amber/10 p-3 text-sm">
                    <p className="mb-2 text-amber">
                      This rule set adds tags [{deleteConfirmAddTags.join(", ")}] to items.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={deleteConfirmCleanupTags}
                        onCheckedChange={(v) => setDeleteConfirmCleanupTags(v === true)}
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

      {/* Delete collection confirmation */}
      <AlertDialog open={showDeleteCollectionDialog} onOpenChange={(open) => { if (!deletingCollection) setShowDeleteCollectionDialog(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Collection?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the collection definition &ldquo;{collectionName}&rdquo; and removes it from Plex.
              {currentRuleUsesSelected && <> It will also be removed from this rule.</>} This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingCollection}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleDeleteCollection(); }}
              disabled={deletingCollection}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingCollection ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Delete Collection
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
                color="text-amber"
                bgColor="bg-amber/10"
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
              disabled={rescheduling}
              onClick={async (e) => {
                // Keep the dialog open while the POST is in flight so the guard stays visible.
                e.preventDefault();
                if (!activeRuleSetId || rescheduling) return;
                setRescheduling(true);
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
                } finally {
                  setRescheduling(false);
                  setShowRescheduleDialog(false);
                }
              }}
            >
              {rescheduling ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Yes, reschedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showRecycleBinModal} onOpenChange={setShowRecycleBinModal}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber" />
              Recycle Bin Disabled
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  The selected {arrServiceName} instance has no recycle bin configured.
                  Files removed by this lifecycle rule will be permanently deleted with no
                  way to recover them.
                </p>
                {recycleBinStatus?.arrUrl && (
                  <p>
                    You can configure a recycle bin path in{" "}
                    <a
                      href={`${recycleBinStatus.arrUrl.replace(/\/+$/, "")}/settings/mediamanagement`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline inline-flex items-center gap-1"
                    >
                      {arrServiceName} settings <ExternalLink className="h-3 w-3" />
                    </a>
                    .
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 cursor-pointer py-2">
            <Checkbox
              checked={recycleBinAcknowledged}
              onCheckedChange={(c) => setRecycleBinAcknowledged(c === true)}
            />
            <span className="text-sm">
              I understand that deletes will be permanent and unrecoverable.
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                pendingSaveOptionsRef.current = undefined;
                setRecycleBinAcknowledged(false);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!recycleBinAcknowledged}
              onClick={() => {
                if (arrInstanceId) recycleBinAcknowledgedRef.current.add(arrInstanceId);
                const opts = pendingSaveOptionsRef.current;
                pendingSaveOptionsRef.current = undefined;
                setRecycleBinAcknowledged(false);
                setShowRecycleBinModal(false);
                executeSave(opts);
              }}
            >
              Save anyway
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
          onClose={() => setSelectedItemId(null)}
          width={panelWidth}
          resizeHandleProps={resizeHandleProps}
          matchedCriteria={selectedItem.matchedCriteria}
          ruleGroups={groups}
          builderConfig={ruleBuilderConfig}
          allActualValues={selectedItem.actualValues}
        />
      )}
    </>
  );
}
