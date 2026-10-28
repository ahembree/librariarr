"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getServerTypeLabel } from "@/lib/server-styles";
import { ServerTypeChip } from "@/components/server-type-chip";
import { ColorChip } from "@/components/color-chip";
import { RuleSetRail, RuleSetSwitcherBar, type RuleSetNavigatorProps } from "@/components/rule-set-navigator";
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
import { deriveIntegrationsStatus, arrTypeForMediaType } from "@/hooks/use-integrations-health";
import { hasArrRules, hasSeerrRules, hasPlayActivityRules } from "@/lib/conditions";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { useMediaDetailPanel } from "@/hooks/use-media-detail-panel";
import { groupOfRow } from "@/lib/media/detail-panel-item";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { legacyRulesToEditorGroups } from "@/lib/rules/legacy";
import { deletesArrRecord } from "@/lib/lifecycle/action-types";
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
import { AlertTriangle, Check, ChevronsUpDown, ClipboardPaste, ExternalLink, Eye, FileText, FlaskConical, Loader2, Save, SlidersHorizontal, Trash2, Upload, X } from "lucide-react";
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
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LoadingButton } from "@/components/loading-button";
import { generateId } from "@/lib/utils";
import { QueryProgress, useStreamProgress } from "@/components/query-progress";
import { consumeProgressStream } from "@/lib/progress/client";
import type { PreviewDiffCounts, PreviewDiffStatus, PreviewItem } from "@/components/rule-preview-section";
import { lazyComponent } from "@/components/lazy-component";
import { Skeleton } from "@/components/ui/skeleton";

// Loaded on demand: the results table and card grid (MediaTable, the card and
// hover components) render only once a preview has answered.
const RulePreviewSection = lazyComponent(
  () => import("@/components/rule-preview-section").then((m) => m.RulePreviewSection),
  RulePreviewSkeleton,
);

function RulePreviewSkeleton() {
  return <Skeleton className="mt-8 h-64 w-full rounded-lg" />;
}
import { ExportRuleSetDialog, ImportRuleSetDialog, TestMediaDialog } from "@/components/lifecycle-rule-dialogs";
import { stripTrailingSlashes } from "@/lib/url-normalize";
import type {
  CollectionDefinition,
  RuleEditorData,
  RuleEditorServer,
  SavedRuleSet,
} from "@/hooks/use-rule-editor-data";

interface DiffItem {
  id: string;
  title: string;
  parentTitle: string | null;
  /** Other preview rows (another server's copy) folded into this match. */
  copyIds?: string[];
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

// Sentinel for the "Create new collection…" dropdown option.
const NEW_COLLECTION = "__new__";

function isDestructiveAction(actionType: string): boolean {
  return actionType.includes("DELETE");
}

function isQualityProfileChangeAction(actionType: string): boolean {
  return actionType.startsWith("CHANGE_QUALITY_PROFILE_");
}

// The engine's legacy conversion, keeping disabled rules (`legacy.ts`): the
// editor shows a legacy rule set as it is evaluated, and saving it neither
// loses a disabled rule nor changes what matches.
function legacyToGroups(rules: LifecycleRule[] | LifecycleRuleGroup[]): LifecycleRuleGroup[] {
  return legacyRulesToEditorGroups(rules, generateId);
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

interface LifecycleRulePageProps {
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
  /** What every tab reads, loaded once by the rules page (`useRuleEditorData`). */
  data: RuleEditorData;
}

/** The Arr metadata keys an instance's metadata fills, all empty. */
const NO_ARR_VALUES: Record<string, string[]> = {
  arrTag: [],
  arrQualityProfile: [],
  arrOriginalLanguage: [],
  arrStatus: [],
  arrSeriesType: [],
  arrQualityName: [],
};

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
  data: editorData,
}: LifecycleRulePageProps) {
  const detailPanel = useMediaDetailPanel();
  const [name, setName] = useState("");
  // Only flag a missing name after the user has interacted with the field
  const [nameTouched, setNameTouched] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportJson, setExportJson] = useState("");
  const [groups, setGroups] = useState<LifecycleRuleGroup[]>([]);
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  // The open row as the latest preview has it: a re-run refreshes its matched
  // criteria and values, and the panel hides while the row is gone.
  const selectedPreview = useMemo(
    () => (detailPanel.selectedId ? preview.find((p) => p.id === detailPanel.selectedId) ?? null : null),
    [preview, detailPanel.selectedId],
  );
  const { open: openPanel } = detailPanel;
  const openDetailPanel = useCallback((item: PreviewItem) => {
    void openPanel({
      id: item.id,
      mediaType,
      seed: item,
      group: groupOfRow(item),
    });
  }, [openPanel, mediaType]);
  const { refreshRuleSets, integrationsHealth, exceptedItemIds, servers } = editorData;
  // The rules page holds every type's rule sets; this tab lists its own.
  const savedRuleSets = useMemo(
    () => (editorData.ruleSets ?? []).filter((r) => r.type === mediaType),
    [editorData.ruleSets, mediaType],
  );
  const [activeRuleSetId, setActiveRuleSetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const { state: previewProgress, handleUpdate: onPreviewProgress, reset: resetPreviewProgress } = useStreamProgress();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // The selected instance's tags, profiles and other enumerable Arr values.
  const [arrDistinctValues, setArrDistinctValues] = useState<Record<string, string[]>>(NO_ARR_VALUES);

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
  const arrType = arrTypeForMediaType(mediaType);
  const arrInstances = editorData.integrations?.[arrType] ?? [];
  // Seerr data is never read for music (its fields are invalid there).
  const seerrConnected = mediaType !== "MUSIC" && (editorData.integrations?.seerrConnected ?? false);
  const seerrUsers = mediaType === "MUSIC" ? null : (editorData.integrations?.seerrUsers ?? null);
  const distinctValues = useMemo<Record<string, string[]>>(
    () => ({
      ...editorData.distinctValues,
      ...(seerrUsers ? { seerrRequestedBy: seerrUsers } : {}),
      ...arrDistinctValues,
    }),
    [editorData.distinctValues, seerrUsers, arrDistinctValues],
  );

  const relevantArrTypes = useMemo(() => [arrType] as const, [arrType]);
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
  // The third external dependency the evaluability guard checks, and the only
  // one with no UI of its own until now: play activity. `hasPlayActivityRules`
  // is the SAME shared predicate the server-side guard triggers on, so the
  // banner can't come to a different conclusion about which rules count.
  const ruleUsesPlayActivity = useMemo(() => hasPlayActivityRules(groups), [groups]);

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
  const [serverPopoverOpen, setServerPopoverOpen] = useState(false);

  // Scoped to the rule set's own targets, exactly as the guard scopes its count
  // — an unrelated server mid-import must not warn on a rule set that never
  // reads it. Disabled servers are outside the guard's scope entirely.
  const serversAwaitingPlayHistory = useMemo(
    () =>
      serverIds
        .map((id) => servers.find((s) => s.id === id))
        .filter((s): s is RuleEditorServer => !!s && s.enabled && s.playHistoryFault !== null),
    [serverIds, servers],
  );

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

  // Whether rule logic (rules/scope/servers) changed vs only config fields.
  // With Arr criteria the Arr instance is rule logic too: the criteria are read
  // from it, so the matches judged on the old one must not be kept (the PUT
  // clears them in that case whatever this sends).
  const rulesChanged = useMemo(() => {
    if (!snapshot) return true;
    return (
      snapshot.groups !== JSON.stringify(groups) ||
      snapshot.seriesScope !== seriesScope ||
      snapshot.serverIds !== JSON.stringify([...serverIds].sort()) ||
      (ruleUsesArr && snapshot.arrInstanceId !== arrInstanceId)
    );
  }, [snapshot, groups, seriesScope, serverIds, ruleUsesArr, arrInstanceId]);

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
  const [previewDiffMap, setPreviewDiffMap] = useState<Map<string, PreviewDiffStatus>>(() => new Map());
  const [previewDiffCounts, setPreviewDiffCounts] = useState<PreviewDiffCounts | null>(null);

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

  const [showTestMediaDialog, setShowTestMediaDialog] = useState(false);

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

  // The only list this tab reads for itself; the rest come with `data`.
  useEffect(() => {
    void (async () => { await fetchCollections(); })();
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
        setArrDistinctValues({
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
        });
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
      setArrDistinctValues(NO_ARR_VALUES);
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
      await refreshRuleSets();
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
        addImportExclusion: deletesArrRecord(actionType) && addImportExclusion,
        searchAfterAction,
        // Deleting the whole Arr record deletes its tags with it.
        addArrTags: deletesArrRecord(actionType) ? [] : addArrTags,
        removeArrTags: deletesArrRecord(actionType) ? [] : removeArrTags,
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
      await refreshRuleSets();
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
          const detectData = await detectResponse.json().catch(() => null);
          if (!detectResponse.ok) {
            toast.error(detectData?.error ?? "Failed to detect matches");
          } else if (Array.isArray(detectData?.skipped) && detectData.skipped.length > 0) {
            // The run succeeded as a request but detection refused this rule
            // set and preserved its previous matches. Navigating to Matches
            // here would present those as the result of the run that just
            // "finished", so stay put and say why nothing was evaluated.
            toast.warning("Detection skipped this rule set", {
              description: (detectData.skipped[0] as { reason: string }).reason,
            });
          } else {
            router.push("/lifecycle/matches");
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
      // arrInstanceId: Arr criteria are read from the rule set's own instance.
      const previewBody: Record<string, unknown> = {
        rules: groups,
        type: mediaType,
        serverIds,
        arrInstanceId: arrInstanceId || null,
        ...(activeRuleSetId ? { ruleSetId: activeRuleSetId } : {}),
      };
      if (scopeConfig) {
        previewBody.seriesScope = seriesScope;
      }

      // Fetch preview and diff in parallel for existing rule sets
      const previewPromise = fetch("/api/lifecycle/rules/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(previewBody),
      });
      // `.catch` here, not at the await below: when the preview fails we return
      // early without ever awaiting this one, and a bare rejected fetch promise
      // then surfaces as an unhandled rejection.
      const diffPromise = activeRuleSetId
        ? fetch(`/api/lifecycle/rules/${activeRuleSetId}/diff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...previewBody, actionEnabled, actionType }),
          }).catch(() => null)
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
      let nextDiffMap: Map<string, PreviewDiffStatus> | null = null;
      let nextDiffCounts: PreviewDiffCounts | null = null;
      if (diffResponse?.ok) {
        const diff = await diffResponse.json() as DiffData & { removedItems?: PreviewItem[] };
        const statusMap = new Map<string, PreviewDiffStatus>();
        // Another server's copy folded into a match shares its status — the
        // preview lists every copy as a row, detection stores the title once.
        for (const item of diff.added) {
          statusMap.set(item.id, "added");
          for (const c of item.copyIds ?? []) statusMap.set(c, "added");
        }
        for (const item of diff.retained) {
          statusMap.set(item.id, "retained");
          for (const c of item.copyIds ?? []) statusMap.set(c, "retained");
        }
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
      // Only the latest Preview owns the UI — a superseded call reporting its
      // failure would talk over the run the user is actually watching.
      if (previewTokenRef.current !== token) return;
      // The route refuses a preview it cannot answer faithfully: no active
      // rules, or the evaluability guard (Arr/Seerr instance missing, or a
      // server whose play history isn't established yet — e.g. a Tracearr
      // backfill still importing). Those reasons are the whole point of the
      // refusal, so show them instead of leaving the button to spin back to
      // idle with an unchanged, stale result table on screen.
      toast.error("Couldn't preview matches", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      // Only clear the previewing flag if this is still the latest call;
      // otherwise the newer call owns the spinner.
      if (previewTokenRef.current === token) {
        setPreviewing(false);
        resetPreviewProgress();
      }
    }
  };

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
    // Converted once: a legacy rule set's buckets get fresh ids on every
    // conversion, so a second one for the snapshot read as an unsaved edit.
    const loadedGroups = legacyToGroups(ruleSet.rules);
    setGroups(loadedGroups);
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
      groups: JSON.stringify(loadedGroups),
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
    // Every type's rule sets, as the rules page read them.
    const allRuleSets = editorData.ruleSets;
    if (!allRuleSets) return;
    hydratedFromUrlRef.current = true;
    const clearParam = () => {
      if (typeof window !== "undefined") {
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.hash,
        );
      }
    };
    const found = allRuleSets.find((rs) => rs.id === ruleSetIdFromUrl);
    if (!found) {
      toast.error("Rule set not found", {
        description: "It may have been deleted.",
      });
      clearParam();
      return;
    }
    if (found.type === mediaType) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadRuleSet(found);
      clearParam();
      return;
    }
    // The rule set belongs to another library type: move to its tab, which
    // loads it from the same param.
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
  }, [ruleSetIdFromUrl, editorData.ruleSets]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleRuleSetEnabled = async (id: string, currentEnabled: boolean) => {
    try {
      const res = await fetch(`/api/lifecycle/rules/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      if (!res.ok) {
        toast.error(`Failed to ${currentEnabled ? "disable" : "enable"} rule set`);
        return;
      }
      if (activeRuleSetId === id) {
        setEnabled(!currentEnabled);
        // The toggle saved this value, so it is not an unsaved edit: moving
        // only the form left the rule set reading as dirty, and switching
        // away asked to discard changes that did not exist.
        setSnapshot((s) => (s ? { ...s, enabled: !currentEnabled } : s));
      }
      await refreshRuleSets();
    } catch (error) {
      console.error("Failed to toggle rule set:", error);
      toast.error(`Failed to ${currentEnabled ? "disable" : "enable"} rule set`);
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
      await refreshRuleSets();
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
    setShowExportDialog(true);
  };

  const handleImportJson = (importJson: string) => {
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
      // saving creates a collection of that name, and the create route
      // answers 409 when one exists (the user then picks it in the dropdown).
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
    } catch {
      setSaveError("Failed to parse rule set JSON");
      setShowImportDialog(false);
    }
  };

  // Switching rule sets replaces the editor's contents, and the switcher is
  // one tap away while scrolled anywhere in the editor, so unsaved edits are
  // confirmed before they are thrown away.
  const hasUnsavedEdits = snapshot ? isDirty : name.trim() !== "" || groups.length > 0;
  const [pendingSwitch, setPendingSwitch] = useState<(() => void) | null>(null);
  const editorTopRef = useRef<HTMLDivElement>(null);
  const runSwitch = (action: () => void) => {
    action();
    // A switch made from the pinned bar or rail lands at the top of the
    // editor, where the new rule set's name and servers are.
    // Measured against the box that scrolls the page, not the window: the
    // shell's header sits above it, so an editor top hidden under the header
    // is still below the window's top.
    const el = editorTopRef.current;
    const scrollerTop = findScrollContainer()?.getBoundingClientRect().top ?? 0;
    if (el && el.getBoundingClientRect().top < scrollerTop) {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    }
  };
  const requestSwitch = (action: () => void) => {
    if (hasUnsavedEdits) {
      setPendingSwitch(() => action);
      return;
    }
    runSwitch(action);
  };
  const navigatorProps: RuleSetNavigatorProps = {
    ruleSets: savedRuleSets,
    activeId: activeRuleSetId,
    scopeLabels: scopeConfig
      ? { enabled: scopeConfig.ruleSetEnabledLabel, disabled: scopeConfig.ruleSetDisabledLabel }
      : undefined,
    onSelect: (ruleSet) => {
      if (ruleSet.id === activeRuleSetId) return;
      requestSwitch(() => void loadRuleSet(ruleSet));
    },
    onToggleEnabled: (id, currentEnabled) => void toggleRuleSetEnabled(id, currentEnabled),
    onDelete: (ruleSet) => {
      setDeleteConfirmId(ruleSet.id);
      setDeleteConfirmName(ruleSet.name);
      setDeleteConfirmHasCollection(!!ruleSet.collectionId);
      setDeleteConfirmAddTags(ruleSet.addArrTags ?? []);
      setDeleteConfirmCleanupTags(false);
    },
  };

  // The builder and its logic preview, as one element kept while what they
  // read is unchanged: React skips re-rendering an element it has already
  // rendered, so typing a name, a collection or a delay no longer re-renders
  // every rule row and the pseudocode.
  const arrUnreachable = integrationsStatus.arrUnreachable;
  const seerrUnreachable = integrationsStatus.seerrUnreachable;
  const arrAvailableForLibrary = arrInstances.length > 0;
  const ruleBuilder = useMemo(
    () => (
      <BuilderWithPseudocode groups={groups} config={ruleBuilderConfig}>
        <RuleBuilder
          groups={groups}
          onChange={setGroups}
          distinctValues={distinctValues}
          arrConnected={!!arrInstanceId}
          arrUnreachable={arrUnreachable}
          arrAvailableForLibrary={arrAvailableForLibrary}
          seerrConnected={mediaType === "MUSIC" ? undefined : seerrConnected}
          seerrUnreachable={seerrUnreachable}
          libraryType={mediaType}
        />
      </BuilderWithPseudocode>
    ),
    [groups, distinctValues, arrInstanceId, arrUnreachable, arrAvailableForLibrary, mediaType, seerrConnected, seerrUnreachable],
  );

  return (
    <>
    <div className={embedded ? undefined : "h-full overflow-y-auto"}>
        <div className={embedded ? "px-4 sm:px-6 lg:px-8 pb-4 sm:pb-6 lg:pb-8" : "p-4 sm:p-6 lg:p-8"}>
      {!embedded && (
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">{pageTitle}</h1>
          <Button variant="outline" onClick={() => requestSwitch(newRuleSet)}>
            <FileText className="mr-2 h-4 w-4" />
            New Rule Set
          </Button>
        </div>
      )}
      {embedded && (
        <div className="mb-6 flex justify-end">
          <Button variant="outline" onClick={() => requestSwitch(newRuleSet)}>
            <FileText className="mr-2 h-4 w-4" />
            New Rule Set
          </Button>
        </div>
      )}

      {/* Saved rule sets: a hover-to-open rail beside the editor on wide
          screens with a pointer, a pinned switcher bar + bottom sheet
          everywhere else (touch screens cannot hover). */}
      <div className={savedRuleSets.length > 0 ? "rail:flex rail:items-start rail:gap-4" : undefined}>
      {savedRuleSets.length > 0 && <RuleSetRail {...navigatorProps} />}
      <div ref={editorTopRef} className="min-w-0 flex-1 scroll-mt-4">
      {savedRuleSets.length > 0 && <RuleSetSwitcherBar {...navigatorProps} />}
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
                    <ColorChip key={id} className="gap-1 border-primary/25 bg-primary/10 text-primary">
                      {server?.name ?? id}
                      {server && <ServerTypeChip type={server.type} />}
                      <button
                        type="button"
                        onClick={() => setServerIds((prev) => prev.filter((sid) => sid !== id))}
                        className="hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </ColorChip>
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

          {ruleBuilder}

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

                {deletesArrRecord(actionType) && (
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
                      disabled={deletesArrRecord(actionType) || !arrInstanceId}
                    />
                    <Label htmlFor="manage-tags" className={(deletesArrRecord(actionType) || !arrInstanceId) ? "text-muted-foreground" : ""}>
                      Manage Tags
                    </Label>
                    {deletesArrRecord(actionType) && (
                      <span className="text-xs text-muted-foreground">(disabled when deleting from Arr)</span>
                    )}
                    {!deletesArrRecord(actionType) && !arrInstanceId && (
                      <span className="text-xs text-muted-foreground">(select a {arrServiceName} server above)</span>
                    )}
                  </div>

                  {manageTagsEnabled && !deletesArrRecord(actionType) && arrInstanceId && (
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
                            <ColorChip
                              key={tag}
                              className={`gap-1 ${
                                tagMode === "add"
                                  ? "border-green/30 bg-green-dim text-green"
                                  : "border-red/30 bg-red-dim text-red"
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
                            </ColorChip>
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

          {ruleUsesPlayActivity && serversAwaitingPlayHistory.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-amber shrink-0" />
              <div className="space-y-1">
                <p className="font-medium text-amber">
                  Play history not established yet
                </p>
                <p className="text-muted-foreground">
                  This rule set uses play-activity criteria (watched by, play count,
                  last played), and until every server it reads can answer them,
                  Preview, Test Media, and detection are paused rather than matching
                  your whole library.
                </p>
                {/* Per-server rather than one blended sentence: the two faults
                    have opposite remedies, so a server that is merely still
                    importing and one whose marker was withdrawn must not be
                    described the same way. */}
                <ul className="space-y-1">
                  {serversAwaitingPlayHistory.map((s) => (
                    <li key={s.id} className="text-muted-foreground">
                      <span className="text-foreground">{s.name}</span>
                      {s.playHistoryFault === "importing" ? (
                        <>
                          {" "}&mdash; its Tracearr history import is still walking back
                          through the archive, so anything played before that point still
                          looks never-watched. Watch the progress under Settings &rarr;
                          Servers; this clears itself when the import completes.
                        </>
                      ) : (
                        <>
                          {" "}&mdash; no sync has established what was played there. It has
                          never synced, or the history was cleared by a watch-history
                          source change, a purge, or a backup restore. This clears on the
                          next successful watch-history sync &mdash; run one from Library
                          &rarr; History &rarr; Refresh, or wait for the scheduled sync.
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <LoadingButton
              onClick={handlePreview}
              loading={previewing}
              icon={Eye}
              disabled={groups.length === 0 || !validateAllRules(groups) || serverIds.length === 0 || (ruleUsesArr && !arrInstanceId) || (ruleUsesSeerr && !seerrConnected)}
              variant="secondary"
            >
              Preview
            </LoadingButton>
            <Button
              onClick={() => setShowTestMediaDialog(true)}
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
                onClick={() => { setSaveError(null); setShowImportDialog(true); }}
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
        <RulePreviewSection
          items={preview}
          mediaType={mediaType}
          diffMap={previewDiffMap}
          diffCounts={previewDiffCounts}
          exceptedItemIds={exceptedItemIds}
          onItemClick={openDetailPanel}
        />
      )}
      </div>
      </div>

      <ExportRuleSetDialog open={showExportDialog} onOpenChange={setShowExportDialog} json={exportJson} />

      <ImportRuleSetDialog open={showImportDialog} onOpenChange={setShowImportDialog} onImport={handleImportJson} />

      <TestMediaDialog
        open={showTestMediaDialog}
        onOpenChange={setShowTestMediaDialog}
        groups={groups}
        mediaType={mediaType}
        seriesScope={scopeConfig ? seriesScope : undefined}
        serverIds={serverIds}
        arrInstanceId={arrInstanceId}
        ruleSetId={activeRuleSetId}
      />

      {/* Unsaved edits: confirm before switching rule sets */}
      <ConfirmDialog
        open={pendingSwitch !== null}
        onOpenChange={(open) => { if (!open) setPendingSwitch(null); }}
        title="Discard unsaved changes?"
        description={
          activeRuleSetId
            ? `Your edits to "${snapshot?.name ?? name}" have not been saved.`
            : "This new rule set has not been saved."
        }
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        destructive
        onConfirm={() => {
          const action = pendingSwitch;
          setPendingSwitch(null);
          if (action) runSwitch(action);
        }}
      />

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}
        title="Delete Rule Set?"
        description={
          <>
            This will permanently delete the rule set &ldquo;{deleteConfirmName}&rdquo;.
            {deleteConfirmHasCollection && (
              <> Its items will be removed from the linked Plex collection (the
              collection itself is kept for any other rules using it).</>
            )}
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleteConfirmId) void deleteRuleSet(deleteConfirmId, deleteConfirmCleanupTags);
        }}
      >
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
      </ConfirmDialog>

      {/* Delete collection confirmation */}
      <ConfirmDialog
        open={showDeleteCollectionDialog}
        onOpenChange={setShowDeleteCollectionDialog}
        title="Delete Collection?"
        description={
          <>
            This permanently deletes the collection definition &ldquo;{collectionName}&rdquo; and removes it from Plex.
            {currentRuleUsesSelected && <> It will also be removed from this rule.</>} This can&rsquo;t be undone.
          </>
        }
        confirmLabel="Delete Collection"
        confirmIcon={Trash2}
        destructive
        pending={deletingCollection}
        onConfirm={handleDeleteCollection}
      />

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
                  const diffBody: Record<string, unknown> = { rules: groups, type: mediaType, serverIds, actionEnabled, actionType, arrInstanceId: arrInstanceId || null };
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
        <DialogContent className="max-w-lg max-h-[80dvh] overflow-y-auto">
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
                note={
                  // The PUT clears every match when the instance the Arr criteria
                  // are read from changes, so nothing scheduled survives that save.
                  ruleUsesArr && snapshot && snapshot.arrInstanceId !== arrInstanceId
                    ? "Matches restart against the new *arr instance — pending actions are rescheduled"
                    : "Scheduled actions will be preserved"
                }
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
      <ConfirmDialog
        open={showRescheduleDialog}
        onOpenChange={setShowRescheduleDialog}
        title="Update Pending Actions"
        description={
          <>
            Action delay changed from {rescheduleOldDelay} to {rescheduleNewDelay} day{rescheduleNewDelay !== 1 ? "s" : ""}.
            Would you like to reschedule existing pending actions to {rescheduleNewDelay} day{rescheduleNewDelay !== 1 ? "s" : ""} from today?
          </>
        }
        cancelLabel="No, keep current schedule"
        confirmLabel="Yes, reschedule"
        pending={rescheduling}
        onConfirm={async () => {
          // The dialog stays open, spinning, while the POST is in flight.
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
      />

      <ConfirmDialog
        open={showRecycleBinModal}
        onOpenChange={(open) => {
          if (!open) {
            pendingSaveOptionsRef.current = undefined;
            setRecycleBinAcknowledged(false);
          }
          setShowRecycleBinModal(open);
        }}
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber" />
            Recycle Bin Disabled
          </span>
        }
        description={
          <>
            The selected {arrServiceName} instance has no recycle bin configured.
            Files removed by this lifecycle rule will be permanently deleted with no
            way to recover them.
          </>
        }
        confirmLabel="Save anyway"
        confirmDisabled={!recycleBinAcknowledged}
        onConfirm={() => {
          if (arrInstanceId) recycleBinAcknowledgedRef.current.add(arrInstanceId);
          const opts = pendingSaveOptionsRef.current;
          pendingSaveOptionsRef.current = undefined;
          setRecycleBinAcknowledged(false);
          void executeSave(opts);
        }}
      >
        {recycleBinStatus?.arrUrl && (
          <p className="text-sm text-muted-foreground">
            You can configure a recycle bin path in{" "}
            <a
              href={`${stripTrailingSlashes(recycleBinStatus.arrUrl)}/settings/mediamanagement`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline inline-flex items-center gap-1"
            >
              {arrServiceName} settings <ExternalLink className="h-3 w-3" />
            </a>
            .
          </p>
        )}
        <label className="flex items-center gap-2 cursor-pointer py-2">
          <Checkbox
            checked={recycleBinAcknowledged}
            onCheckedChange={(c) => setRecycleBinAcknowledged(c === true)}
          />
          <span className="text-sm">
            I understand that deletes will be permanent and unrecoverable.
          </span>
        </label>
      </ConfirmDialog>
        </div>
    </div>

      {detailPanel.panelProps && selectedPreview && (
        <MediaDetailSidePanel
          {...detailPanel.panelProps}
          matchedCriteria={selectedPreview.matchedCriteria}
          ruleGroups={groups}
          builderConfig={ruleBuilderConfig}
          allActualValues={selectedPreview.actualValues}
        />
      )}
    </>
  );
}
