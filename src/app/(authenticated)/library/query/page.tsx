"use client";

import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { usePanelResize } from "@/hooks/use-panel-resize";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import { ServerChips } from "@/components/server-chips";
import { ServerTypeChip } from "@/components/server-type-chip";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Play,
  Save,
  Plus,
  Trash2,
  ChevronDown,
  Search,
  Loader2,
  Copy,
  LayoutGrid,
  TableProperties,
  Columns3,
  Calendar,
  Clock,
  HardDrive,
  Layers,
  AlertTriangle,
  ArrowRightLeft,
  Check,
  History,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { QueryBuilder, queryBuilderConfig, countAllRules, validateAllRules } from "@/components/query-builder";
import { BuilderWithPseudocode } from "@/components/builder/builder-with-pseudocode";
import { IntegrationUnreachableBanner } from "@/components/integration-unreachable-banner";
import { useIntegrationsHealth, deriveIntegrationsStatus, arrTypeForMediaType, type ArrType } from "@/hooks/use-integrations-health";
import { hasArrRules, hasSeerrRules, type QueryGroup, type QueryDefinition } from "@/lib/query/types";
import type { MediaItemWithRelations } from "@/lib/types";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { MediaCard , CARD_CONTENT_HEIGHT } from "@/components/media-card";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { CardSizeControl } from "@/components/card-size-control";
import { useCardSize, estimateContentWidth } from "@/hooks/use-card-size";
import { useChipColors } from "@/components/chip-color-provider";
import { useServers } from "@/hooks/use-servers";
import { formatFileSize, formatDuration, formatBytesNum } from "@/lib/format";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { generateId } from "@/lib/utils";
import { MEDIA_TYPE_BADGE_COLORS, mediaTypeLabel } from "@/lib/theme/media-type-colors";
import { EmptyState } from "@/components/empty-state";
import { ConvertQueryToRuleDialog } from "@/components/convert-query-to-rule-dialog";
import { QueryProgress, useStreamProgress } from "@/components/query-progress";
import { consumeProgressStream } from "@/lib/progress/client";
import type { ProgressUpdate } from "@/lib/progress/types";
import { batchIds } from "@/lib/query/batch";
import { QueryActionBar, type ArrFamily, type ArrFamilyMeta, type QueryActionConfig } from "@/components/query-action-bar";
import { toast } from "sonner";

interface SavedQuery {
  id: string;
  name: string;
  query: QueryDefinition;
  createdAt: string;
  updatedAt: string;
}

interface QueryResultItem {
  id: string;
  title: string;
  parentTitle: string | null;
  year: number | null;
  type: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  summary: string | null;
  contentRating: string | null;
  rating: number | null;
  ratingImage: string | null;
  audienceRating: number | null;
  audienceRatingImage: string | null;
  resolution: string | null;
  dynamicRange: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioProfile: string | null;
  container: string | null;
  fileSize: string | null;
  duration: number | null;
  genres: string[] | null;
  studio: string | null;
  playCount: number;
  lastPlayedAt: string | null;
  addedAt: string | null;
  matchedEpisodes?: number;
  seasonCount?: number;
  library: {
    title: string;
    mediaServer: { id: string; name: string; type: string };
  } | null;
  servers?: Array<{ serverId: string; serverName: string; serverType: string }>;
}

const FALLBACK_ICONS: Record<string, "movie" | "series" | "music"> = {
  MOVIE: "movie",
  SERIES: "series",
  MUSIC: "music",
};

function makeDefaultGroup(): QueryGroup {
  return {
    id: generateId(),
    condition: "AND",
    rules: [
      {
        id: generateId(),
        field: "title",
        operator: "contains",
        value: "",
        condition: "OR",
      },
    ],
    groups: [],
  };
}

// ── In-progress query draft ─────────────────────────────────────
// Auto-persisted to sessionStorage so an unsaved query survives accidentally
// navigating away and coming back (tab-scoped, cleared when the tab closes).
// Distinct from "Saved queries", which are persisted to the database.
const QUERY_DRAFT_KEY = "query-builder-draft";

/**
 * Auto-saved, in-progress query. Wraps the same `QueryDefinition` the engine
 * runs (so there is no parallel field list to keep in sync) plus the id of the
 * saved query being edited, if any.
 */
interface QueryDraft {
  definition: QueryDefinition;
  activeQueryId: string | null;
}

/** A pristine query definition — the empty/default builder state. */
function makeEmptyDefinition(): QueryDefinition {
  return {
    mediaTypes: [],
    serverIds: [],
    groups: [makeDefaultGroup()],
    sortBy: "title",
    sortOrder: "asc",
    includeEpisodes: false,
  };
}

/** True if any rule anywhere in the tree has a non-empty value. */
function anyRuleConfigured(groups: QueryGroup[]): boolean {
  return groups.some(
    (g) =>
      g.rules.some((r) => String(r.value ?? "").trim() !== "") ||
      anyRuleConfigured(g.groups ?? []),
  );
}

/**
 * Whether a draft holds anything worth restoring. A pristine builder (no media
 * types, default scope/sort, and the single empty starter rule) is treated as
 * empty so we neither persist nor advertise a restore for it.
 */
function queryHasContent(def: QueryDefinition, activeQueryId: string | null): boolean {
  return (
    (def.mediaTypes?.length ?? 0) > 0 ||
    (def.serverIds?.length ?? 0) > 0 ||
    Boolean(def.includeEpisodes) ||
    def.sortBy !== "title" ||
    def.sortOrder !== "asc" ||
    Object.values(def.arrServerIds ?? {}).some(Boolean) ||
    Boolean(activeQueryId) ||
    anyRuleConfigured(def.groups)
  );
}

function formatResolution(res: string | null) {
  if (!res) return "";
  const label = normalizeResolutionLabel(res);
  return label === "Other" ? res : label;
}

/** Aligned label + control row used inside the Query Scope card. */
function ScopeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="pt-1.5 text-sm font-medium text-muted-foreground sm:w-24 sm:shrink-0">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// Plural labels for the media-type scope pills — distinct from the shared
// singular MEDIA_TYPE_LABELS used by the type chips (which read "Movie").
const MEDIA_TYPE_PLURAL_LABELS: Record<"MOVIE" | "SERIES" | "MUSIC", string> = {
  MOVIE: "Movies",
  SERIES: "Series",
  MUSIC: "Music",
};

// ── Column definitions ──────────────────────────────────────────

interface QueryColumn extends DataTableColumn<QueryResultItem> {
  group: string;
  defaultVisible: boolean;
}

const COLUMN_GROUPS: Record<string, string> = {
  core: "Core",
  video: "Video",
  audio: "Audio",
  file: "File",
  playback: "Playback",
};

const VISIBLE_KEY = "query-visible-columns";

function loadVisibleColumns(): Set<string> {
  try {
    const stored = localStorage.getItem(VISIBLE_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* use defaults */ }
  return new Set<string>();
}

function saveVisibleColumns(cols: Set<string>) {
  localStorage.setItem(VISIBLE_KEY, JSON.stringify([...cols]));
}

const GAP = 16;
const CARD_BORDER = 2; // 1px top + 1px bottom border on Card
const QUALITY_BAR_HEIGHT = 12; // h-1 quality bar (4px) + py-1 padding (8px)

// ── Component ───────────────────────────────────────────────────

export default function QueryPage() {
  const { servers } = useServers();
  const { getHex, getBadgeStyle } = useChipColors();
  const { width: panelWidth, resizeHandleProps } = usePanelResize({
    storageKey: "library-query-panel-width",
    defaultWidth: 480,
    minWidth: 360,
    maxWidth: 800,
  });
  const [selectedItem, setSelectedItem] = useState<QueryResultItem | null>(null);

  // Result selection (for triggering ad-hoc lifecycle actions)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [executingAction, setExecutingAction] = useState(false);
  // Live progress for the in-flight action (mirrors the query progress bar).
  const { state: actionProgress, handleUpdate: onActionProgress, reset: resetActionProgress } = useStreamProgress();
  const [arrMeta, setArrMeta] = useState<Record<ArrFamily, ArrFamilyMeta>>({
    radarr: { qualityProfiles: [], tags: [] },
    sonarr: { qualityProfiles: [], tags: [] },
    lidarr: { qualityProfiles: [], tags: [] },
  });

  // Query state
  const [mediaTypes, setMediaTypes] = useState<string[]>([]);
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);
  const [groups, setGroups] = useState<QueryGroup[]>([makeDefaultGroup()]);
  const [sortBy, setSortBy] = useState("title");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [includeEpisodes, setIncludeEpisodes] = useState(false);
  const [arrServerIds, setArrServerIds] = useState<{ radarr?: string; sonarr?: string; lidarr?: string }>({});

  // Arr instances
  const [arrInstances, setArrInstances] = useState<{
    radarr: Array<{ id: string; name: string }>;
    sonarr: Array<{ id: string; name: string }>;
    lidarr: Array<{ id: string; name: string }>;
  }>({ radarr: [], sonarr: [], lidarr: [] });

  // Seerr integration status
  const [seerrConnected, setSeerrConnected] = useState(false);
  const [seerrInstanceId, setSeerrInstanceId] = useState<string | null>(null);

  // Integration reachability (configured but currently online?)
  const { health: integrationsHealth } = useIntegrationsHealth();
  const relevantArrTypes = useMemo<readonly ArrType[]>(() => {
    if (mediaTypes.length === 0) return ["sonarr", "radarr", "lidarr"];
    return mediaTypes.map((t) => arrTypeForMediaType(t as "MOVIE" | "SERIES" | "MUSIC"));
  }, [mediaTypes]);
  // Only check the specific Arr server IDs the query references.
  const arrInstanceIds = useMemo<readonly string[]>(
    () => [arrServerIds.radarr, arrServerIds.sonarr, arrServerIds.lidarr].filter(
      (id): id is string => Boolean(id),
    ),
    [arrServerIds.radarr, arrServerIds.sonarr, arrServerIds.lidarr],
  );
  const seerrInstanceIds = useMemo<readonly string[]>(
    () => (seerrInstanceId ? [seerrInstanceId] : []),
    [seerrInstanceId],
  );
  const integrationsStatus = useMemo(
    () => deriveIntegrationsStatus(integrationsHealth, {
      relevantArrTypes,
      arrInstanceIds,
      seerrInstanceIds,
    }),
    [integrationsHealth, relevantArrTypes, arrInstanceIds, seerrInstanceIds],
  );

  // Results state
  const [results, setResults] = useState<QueryResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const { state: queryProgress, handleUpdate: onQueryProgress, reset: resetQueryProgress } = useStreamProgress();

  // View state
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const { size, setSize, columns: cardColumns } = useCardSize();

  // Column visibility
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => new Set<string>());

  // Load preferences on mount
  useEffect(() => {
    const stored = localStorage.getItem("query-view-mode") as "table" | "cards" | null;
    if (stored) setViewMode(stored);
    const cols = loadVisibleColumns();
    if (cols.size > 0) setVisibleCols(cols);
  }, []);

  // Saved queries
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");
  const [savePopoverOpen, setSavePopoverOpen] = useState(false);

  // In-progress query draft restored from a previous visit (see QUERY_DRAFT_KEY).
  const [draftRestored, setDraftRestored] = useState(false);
  const draftReadyRef = useRef(false);

  // Convert-to-lifecycle-rule dialog
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);

  // Distinct values for dropdowns
  const [distinctValues, setDistinctValues] = useState<Record<string, string[]>>({});

  // Load saved queries, distinct values, and Arr instances on mount
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    fetch("/api/saved-queries")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.queries) setSavedQueries(data.queries);
      })
      .catch(() => {});

    fetch("/api/query/distinct-values")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        // Merge rather than replace: Seerr requester names and Arr metadata are
        // fetched and merged separately. A bare setDistinctValues(data) would
        // clobber seerrRequestedBy when this fetch resolves after the Seerr
        // metadata fetch, dropping the enumerated dropdown back to a text input.
        if (data) setDistinctValues((prev) => ({ ...prev, ...data }));
      })
      .catch(() => {});

    // Fetch Arr instances (all 3 types in parallel)
    Promise.all([
      fetch("/api/integrations/radarr").then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/integrations/sonarr").then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/integrations/lidarr").then((r) => r.ok ? r.json() : null).catch(() => null),
    ]).then(([radarrData, sonarrData, lidarrData]) => {
      setArrInstances({
        radarr: (radarrData?.instances ?? []).map((i: { id: string; name: string }) => ({ id: i.id, name: i.name })),
        sonarr: (sonarrData?.instances ?? []).map((i: { id: string; name: string }) => ({ id: i.id, name: i.name })),
        lidarr: (lidarrData?.instances ?? []).map((i: { id: string; name: string }) => ({ id: i.id, name: i.name })),
      });
    });

    // Fetch Seerr instances to determine connection status
    fetch("/api/integrations/seerr")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        const instances = data?.instances ?? [];
        setSeerrConnected(instances.length > 0);
        setSeerrInstanceId(instances.length > 0 ? instances[0].id : null);
        if (instances.length > 0) {
          fetch(`/api/integrations/seerr/${instances[0].id}/metadata`)
            .then((r) => r.ok ? r.json() : null)
            .then((metaData) => {
              if (metaData?.users) {
                setDistinctValues((prev) => ({ ...prev, seerrRequestedBy: metaData.users }));
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  // Fetch Arr metadata when selected Arr servers change (for dropdown distinct
  // values AND the action bar's per-family quality profiles + tags).
  useEffect(() => {
    const fetchArrMetadata = async () => {
      const meta: Record<ArrFamily, ArrFamilyMeta> = {
        radarr: { qualityProfiles: [], tags: [] },
        sonarr: { qualityProfiles: [], tags: [] },
        lidarr: { qualityProfiles: [], tags: [] },
      };
      const newArrLanguages: string[] = [];
      const newArrStatuses: string[] = [];
      const newArrSeriesTypes: string[] = [];
      const newArrQualityNames: string[] = [];

      const fetchFamily = async (family: ArrFamily, id: string) => {
        try {
          const r = await fetch(`/api/integrations/${family}/${id}/metadata`);
          if (!r.ok) return;
          const data = await r.json();
          meta[family] = {
            qualityProfiles: (data?.qualityProfiles ?? []).map((p: { id: number; name: string }) => ({ id: p.id, name: p.name })),
            tags: (data?.tags ?? []).map((t: { label: string }) => t.label),
          };
          // The metadata route only includes the keys relevant to its Arr type
          // (Sonarr: statuses/seriesTypes; Radarr: qualityNames), so each push is
          // a no-op when the key is absent.
          if (data?.languages) newArrLanguages.push(...data.languages);
          if (data?.statuses) newArrStatuses.push(...data.statuses);
          if (data?.seriesTypes) newArrSeriesTypes.push(...data.seriesTypes);
          if (data?.qualityNames) newArrQualityNames.push(...data.qualityNames);
        } catch { /* ignore */ }
      };

      const promises: Promise<void>[] = [];
      if (arrServerIds.radarr) promises.push(fetchFamily("radarr", arrServerIds.radarr));
      if (arrServerIds.sonarr) promises.push(fetchFamily("sonarr", arrServerIds.sonarr));
      if (arrServerIds.lidarr) promises.push(fetchFamily("lidarr", arrServerIds.lidarr));
      await Promise.all(promises);

      setArrMeta(meta);

      const uniqueSorted = (vals: string[]) =>
        [...new Set(vals)].sort((a, b) => a.localeCompare(b));


      // Deduplicate and sort for the query builder dropdowns
      const allTags = [meta.radarr, meta.sonarr, meta.lidarr].flatMap((m) => m.tags);
      const allProfiles = [meta.radarr, meta.sonarr, meta.lidarr].flatMap((m) => m.qualityProfiles.map((p) => p.name));
      setDistinctValues((prev) => ({
        ...prev,
        arrTag: uniqueSorted(allTags),
        arrQualityProfile: uniqueSorted(allProfiles),
        arrOriginalLanguage: uniqueSorted(newArrLanguages),
        arrStatus: uniqueSorted(newArrStatuses),
        arrSeriesType: uniqueSorted(newArrSeriesTypes),
        arrQualityName: uniqueSorted(newArrQualityNames),
      }));
    };

    if (arrServerIds.radarr || arrServerIds.sonarr || arrServerIds.lidarr) {
      fetchArrMetadata();
    } else {
      setArrMeta({
        radarr: { qualityProfiles: [], tags: [] },
        sonarr: { qualityProfiles: [], tags: [] },
        lidarr: { qualityProfiles: [], tags: [] },
      });
      setDistinctValues((prev) => ({
        ...prev,
        arrTag: [],
        arrQualityProfile: [],
        arrOriginalLanguage: [],
        arrStatus: [],
        arrSeriesType: [],
        arrQualityName: [],
      }));
    }
  }, [arrServerIds]);

  // ── All column definitions (with chip styles) ──

  const allColumns: QueryColumn[] = useMemo(() => [
    {
      id: "type",
      header: "Type",
      defaultWidth: 80,
      group: "core",
      defaultVisible: true,
      accessor: (item) => (
        <ColorChip className={MEDIA_TYPE_BADGE_COLORS[item.type] ?? ""}>
          {mediaTypeLabel(item.type)}
        </ColorChip>
      ),
      sortValue: (item) => item.type,
    },
    {
      id: "title",
      header: "Title",
      defaultWidth: 300,
      group: "core",
      defaultVisible: true,
      accessor: (item) => (
        <div className="flex flex-col">
          <span className="truncate">{item.title}</span>
          {item.matchedEpisodes != null ? (
            <span className="text-xs text-muted-foreground truncate">
              {item.seasonCount} season{item.seasonCount !== 1 ? "s" : ""}, {item.matchedEpisodes} episode{item.matchedEpisodes !== 1 ? "s" : ""} matched
            </span>
          ) : item.parentTitle ? (
            <span className="text-xs text-muted-foreground truncate">
              {item.parentTitle}
              {item.seasonNumber != null && ` S${String(item.seasonNumber).padStart(2, "0")}`}
              {item.episodeNumber != null && `E${String(item.episodeNumber).padStart(2, "0")}`}
            </span>
          ) : null}
        </div>
      ),
      sortValue: (item) => item.title.toLowerCase(),
    },
    {
      id: "year",
      header: "Year",
      defaultWidth: 60,
      group: "core",
      defaultVisible: true,
      className: "text-muted-foreground",
      accessor: (item) => item.year ?? "-",
      sortValue: (item) => item.year,
    },
    {
      id: "resolution",
      header: "Resolution",
      defaultWidth: 90,
      group: "video",
      defaultVisible: true,
      accessor: (item) => {
        if (item.matchedEpisodes != null) return "-";
        const label = formatResolution(item.resolution);
        if (!label) return "-";
        return (
          <ColorChip style={getBadgeStyle("resolution", label)}>
            {label}
          </ColorChip>
        );
      },
      sortValue: (item) => item.resolution,
    },
    {
      id: "videoCodec",
      header: "Video Codec",
      defaultWidth: 90,
      group: "video",
      defaultVisible: true,
      className: "text-muted-foreground",
      accessor: (item) => item.matchedEpisodes != null ? "-" : (item.videoCodec ?? "-"),
      sortValue: (item) => item.videoCodec,
    },
    {
      id: "dynamicRange",
      header: "Dynamic Range",
      defaultWidth: 110,
      group: "video",
      defaultVisible: true,
      accessor: (item) => {
        if (item.matchedEpisodes != null) return "-";
        const dr = item.dynamicRange;
        if (!dr) return "-";
        return (
          <ColorChip style={getBadgeStyle("dynamicRange", dr)}>
            {dr}
          </ColorChip>
        );
      },
      sortValue: (item) => item.dynamicRange,
    },
    {
      id: "audioCodec",
      header: "Audio Codec",
      defaultWidth: 110,
      group: "audio",
      defaultVisible: true,
      accessor: (item) => {
        if (item.matchedEpisodes != null) return "-";
        const codec = item.audioCodec;
        if (!codec) return "-";
        return (
          <ColorChip style={getBadgeStyle("audioCodec", codec)}>
            {codec}
          </ColorChip>
        );
      },
      sortValue: (item) => item.audioCodec,
    },
    {
      id: "audioProfile",
      header: "Audio Profile",
      defaultWidth: 110,
      group: "audio",
      defaultVisible: false,
      accessor: (item) => {
        if (item.matchedEpisodes != null) return "-";
        const ap = item.audioProfile as string | null;
        if (!ap) return "-";
        return (
          <ColorChip style={getBadgeStyle("audioProfile", ap)}>
            {ap}
          </ColorChip>
        );
      },
      sortValue: (item) => item.audioProfile as string | null,
    },
    {
      id: "container",
      header: "Container",
      defaultWidth: 70,
      group: "file",
      defaultVisible: false,
      className: "text-muted-foreground",
      accessor: (item) => item.matchedEpisodes != null ? "-" : (item.container ?? "-"),
      sortValue: (item) => item.container,
    },
    {
      id: "fileSize",
      header: "Size",
      defaultWidth: 90,
      group: "file",
      defaultVisible: true,
      className: "text-right text-muted-foreground",
      headerClassName: "text-right",
      accessor: (item) => formatFileSize(item.fileSize),
      sortValue: (item) => (item.fileSize ? Number(item.fileSize) : null),
    },
    {
      id: "duration",
      header: "Duration",
      defaultWidth: 80,
      group: "file",
      defaultVisible: true,
      className: "text-right text-muted-foreground",
      headerClassName: "text-right",
      accessor: (item) => item.matchedEpisodes != null ? "-" : formatDuration(item.duration),
      sortValue: (item) => item.duration,
    },
    {
      id: "playCount",
      header: "Plays",
      defaultWidth: 55,
      group: "playback",
      defaultVisible: true,
      className: "text-right text-muted-foreground",
      headerClassName: "text-right",
      accessor: (item) => item.playCount,
      sortValue: (item) => item.playCount,
    },
    {
      id: "server",
      header: "Server",
      defaultWidth: 100,
      group: "core",
      defaultVisible: true,
      accessor: (item) => {
        const servers = item.servers ?? (item.library?.mediaServer ? [{ serverId: item.library.mediaServer.id, serverName: item.library.mediaServer.name, serverType: item.library.mediaServer.type }] : []);
        return servers.length > 0 ? <ServerChips servers={servers} /> : "-";
      },
      sortValue: (item) => item.servers?.[0]?.serverName ?? item.library?.mediaServer?.name ?? null,
    },
  ], [getBadgeStyle]);

  // Resolve which columns are visible
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
      if (next.has(colId)) {
        // Don't allow hiding title
        if (colId === "title") return next;
        next.delete(colId);
      } else {
        next.add(colId);
      }
      saveVisibleColumns(next);
      return next;
    });
  }, [allColumns]);

  const effectiveVisible = useMemo(() => {
    if (visibleCols.size === 0) {
      return new Set(allColumns.filter((c) => c.defaultVisible).map((c) => c.id));
    }
    return visibleCols;
  }, [allColumns, visibleCols]);

  const isValid = useMemo(() => {
    return groups.length > 0 && validateAllRules(groups);
  }, [groups]);

  const ruleCount = useMemo(() => countAllRules(groups), [groups]);

  const hasAnyArrServer = !!(arrServerIds.radarr || arrServerIds.sonarr || arrServerIds.lidarr);
  const hasAnyArrInstanceAvailable = arrInstances.radarr.length > 0 || arrInstances.sonarr.length > 0 || arrInstances.lidarr.length > 0;
  const orphanArrRules = useMemo(() => hasArrRules(groups) && !hasAnyArrServer, [groups, hasAnyArrServer]);
  const orphanSeerrRules = useMemo(() => hasSeerrRules(groups) && !seerrConnected, [groups, seerrConnected]);
  const seerrWithMusic = useMemo(
    () => hasSeerrRules(groups) && seerrConnected && (mediaTypes.length === 0 || mediaTypes.includes("MUSIC")),
    [groups, seerrConnected, mediaTypes],
  );

  const buildDefinition = useCallback((): QueryDefinition => {
    const cleanedArrServerIds = Object.fromEntries(
      Object.entries(arrServerIds).filter(([, v]) => v),
    );
    return {
      mediaTypes: mediaTypes as QueryDefinition["mediaTypes"],
      serverIds: selectedServerIds,
      groups,
      sortBy,
      sortOrder,
      includeEpisodes,
      ...(Object.keys(cleanedArrServerIds).length > 0 && { arrServerIds: cleanedArrServerIds }),
      ...(seerrInstanceId && { seerrInstanceId }),
    };
  }, [mediaTypes, selectedServerIds, groups, sortBy, sortOrder, includeEpisodes, arrServerIds, seerrInstanceId]);

  // Inverse of buildDefinition: load a QueryDefinition into the builder. Shared
  // by saved-query loads, draft restore, and New, so the field list lives once.
  const applyQueryDefinition = useCallback((def: QueryDefinition) => {
    setMediaTypes(def.mediaTypes ?? []);
    setSelectedServerIds(def.serverIds ?? []);
    setGroups(def.groups ?? [makeDefaultGroup()]);
    setSortBy(def.sortBy ?? "title");
    setSortOrder(def.sortOrder === "desc" ? "desc" : "asc");
    setIncludeEpisodes(def.includeEpisodes ?? false);
    setArrServerIds(def.arrServerIds ?? {});
    setHasRun(false);
    setResults([]);
  }, []);

  // The definition that produced the currently displayed results. Ad-hoc actions
  // must validate against THIS (not the live builder state, which the user may
  // have edited without re-running), so the selection matches what's on screen.
  const lastRunDefinitionRef = useRef<QueryDefinition | null>(null);

  const runQuery = useCallback(
    async () => {
      setLoading(true);
      setHasRun(true);
      setSelectedIds(new Set());
      resetQueryProgress();
      const definition = buildDefinition();
      lastRunDefinitionRef.current = definition;
      try {
        const resp = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: definition, limit: 0 }),
        });

        if (!resp.ok) throw new Error("Query failed");
        const data = await consumeProgressStream<{ items?: QueryResultItem[] }>(resp, onQueryProgress);
        setResults(data.items ?? []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
        resetQueryProgress();
      }
    },
    [buildDefinition, onQueryProgress, resetQueryProgress],
  );

  // Persist the in-progress query to sessionStorage so it survives navigating
  // away and back. The first run restores any existing draft (without
  // re-persisting); every later run mirrors the live builder into the draft,
  // clearing it once the builder is back to an empty/default state.
  useEffect(() => {
    if (!draftReadyRef.current) {
      draftReadyRef.current = true;
      try {
        const raw = sessionStorage.getItem(QUERY_DRAFT_KEY);
        if (raw) {
          const d = JSON.parse(raw) as Partial<QueryDraft>;
          const def = d?.definition;
          if (def && Array.isArray(def.groups) && def.groups.length > 0) {
            applyQueryDefinition(def);
            if (d.activeQueryId) setActiveQueryId(d.activeQueryId);
            setDraftRestored(true);
          }
        }
      } catch {
        /* ignore malformed draft */
      }
      return;
    }
    const definition = buildDefinition();
    try {
      if (queryHasContent(definition, activeQueryId)) {
        const draft: QueryDraft = { definition, activeQueryId };
        sessionStorage.setItem(QUERY_DRAFT_KEY, JSON.stringify(draft));
      } else {
        sessionStorage.removeItem(QUERY_DRAFT_KEY);
      }
    } catch {
      /* storage unavailable (private mode / quota) */
    }
  }, [buildDefinition, applyQueryDefinition, activeQueryId]);

  // ── Selection + ad-hoc action handlers ──

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Whole-result-set selection state, shared by the table header checkbox and
  // the card-view "Select all" control.
  const { allSelected, someSelected } = useMemo(() => {
    const all = results.length > 0 && results.every((r) => selectedIds.has(r.id));
    return { allSelected: all, someSelected: selectedIds.size > 0 && !all };
  }, [results, selectedIds]);

  const toggleSelectAll = useCallback(() => {
    // Re-derive from the latest selection inside the updater so the toggle is
    // correct regardless of when it was last rendered.
    setSelectedIds((prev) => {
      const all = results.length > 0 && results.every((r) => prev.has(r.id));
      return all ? new Set() : new Set(results.map((r) => r.id));
    });
  }, [results]);

  // Per-selection aggregates computed in a single pass over the (potentially
  // large) result set: per-type selected counts, total size of all results, and
  // total size of the selection. Series rows already carry the aggregated sum of
  // their episodes, and no result path emits both a series row and its episodes,
  // so summing the row-level fileSize is correct for grouped and flat sets alike.
  const { selectionTypeCounts, totalSize, selectedSize } = useMemo(() => {
    const counts = { MOVIE: 0, SERIES: 0, MUSIC: 0 };
    let total = 0;
    let selected = 0;
    for (const r of results) {
      const bytes = r.fileSize ? Number(r.fileSize) : 0;
      const validBytes = Number.isFinite(bytes) && bytes > 0;
      if (validBytes) total += bytes;
      if (selectedIds.has(r.id)) {
        if (validBytes) selected += bytes;
        if (r.type === "MOVIE" || r.type === "SERIES" || r.type === "MUSIC") counts[r.type]++;
      }
    }
    return { selectionTypeCounts: counts, totalSize: total, selectedSize: selected };
  }, [results, selectedIds]);

  const executeAction = useCallback(
    async (config: QueryActionConfig) => {
      setExecutingAction(true);
      resetActionProgress();
      // The server caps each request at MAX_QUERY_ACTION_ITEMS ids (a safety
      // bound — every item drives its own *arr calls). Chunk a larger selection
      // into sequential, individually-bounded requests so any size can run.
      // Each batch is re-validated against the live query server-side, and its
      // completed actions are recorded before the next batch starts, so a
      // failure part-way never rolls back already-finished work.
      const definition = lastRunDefinitionRef.current ?? buildDefinition();
      const batches = batchIds([...selectedIds]);
      const totals = { executed: 0, failed: 0, skipped: 0, errors: [] as string[] };
      const multi = batches.length > 1;
      try {
        for (let b = 0; b < batches.length; b++) {
          // Label each phase with its batch position so the shared progress bar
          // shows "Batch 2/3 · Running action" without any change to the stream.
          const forward = (update: ProgressUpdate) => {
            if (multi && update.type === "plan") {
              onActionProgress({
                ...update,
                phases: update.phases.map((p) => ({ ...p, label: `Batch ${b + 1}/${batches.length} · ${p.label}` })),
              });
            } else {
              onActionProgress(update);
            }
          };

          const resp = await fetch("/api/query/actions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: definition, mediaItemIds: batches[b], ...config }),
          });
          if (!resp.ok) {
            // Auth/validation failures come back as plain JSON (before streaming).
            const data = await resp.json().catch(() => null);
            const reason = data?.error ?? "Unknown error";
            const done = totals.executed + totals.failed + totals.skipped;
            if (done > 0) {
              // Some batches already completed and are recorded server-side.
              // Stop here (fail-closed), but report the partial result and
              // refresh so the finished work is reflected.
              const parts = [`${totals.executed} executed`];
              if (totals.failed > 0) parts.push(`${totals.failed} failed`);
              if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`);
              toast.warning("Action stopped part-way", {
                description: `Batch ${b + 1}/${batches.length} failed: ${reason}. Completed so far: ${parts.join(", ")}. Re-run to finish the rest.`,
              });
              clearSelection();
              runQuery();
            } else {
              toast.error("Action failed", {
                description: multi ? `Batch ${b + 1}/${batches.length}: ${reason}` : reason,
              });
            }
            return;
          }

          // The result is streamed as NDJSON with live phase progress.
          const data = await consumeProgressStream<{
            executed: number;
            failed: number;
            skipped: number;
            errors: string[];
          }>(resp, forward);
          totals.executed += data.executed;
          totals.failed += data.failed;
          totals.skipped += data.skipped;
          if (data.errors?.length) totals.errors.push(...data.errors);
        }

        const parts = [`${totals.executed} executed`];
        if (totals.failed > 0) parts.push(`${totals.failed} failed`);
        if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`);
        const suffix = multi ? ` across ${batches.length} batches` : "";
        if (totals.failed > 0) {
          toast.warning("Action completed with errors", { description: `${parts.join(", ")}${suffix}` });
        } else {
          toast.success("Action complete", { description: `${parts.join(", ")}${suffix}` });
        }
        clearSelection();
        runQuery();
      } catch {
        // Reached on a network failure OR an in-band stream error event. Keep
        // the message neutral — the server's raw error isn't surfaced — and
        // avoid implying a connectivity problem when the server did respond.
        const done = totals.executed + totals.failed + totals.skipped;
        if (done > 0) {
          // Earlier batches finished and are recorded server-side; refresh so
          // the results reflect them and let the user re-run for the rest.
          toast.error("Action stopped part-way", {
            description: "Some items were processed before the error — re-run to finish the rest.",
          });
          clearSelection();
          runQuery();
        } else {
          // Nothing landed — leave the selection intact so a transient error is
          // trivial to retry.
          toast.error("Action failed", { description: "The action could not be completed." });
        }
      } finally {
        setExecutingAction(false);
        resetActionProgress();
      }
    },
    [buildDefinition, selectedIds, clearSelection, runQuery, onActionProgress, resetActionProgress],
  );

  // Table columns with a leading selection checkbox column.
  const tableColumns = useMemo<QueryColumn[]>(() => {
    const selectionColumn: QueryColumn = {
      id: "__select",
      group: "core",
      defaultVisible: true,
      sortable: false,
      defaultWidth: 44,
      className: "text-center",
      headerClassName: "text-center",
      suppressRowHover: true,
      header: (
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={toggleSelectAll}
          aria-label="Select all results"
        />
      ),
      accessor: (item) => (
        <Checkbox
          checked={selectedIds.has(item.id)}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={() => toggleSelect(item.id)}
          aria-label={`Select ${item.title}`}
        />
      ),
    };
    return [selectionColumn, ...activeColumns];
  }, [activeColumns, selectedIds, toggleSelect, allSelected, someSelected, toggleSelectAll]);

  // ── Save/Load/Delete handlers ──

  const handleSave = async () => {
    const name = saveName.trim();
    if (!name) return;
    const definition = buildDefinition();
    try {
      if (activeQueryId) {
        const resp = await fetch(`/api/saved-queries/${activeQueryId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, query: definition }),
        });
        if (resp.ok) {
          const data = await resp.json();
          setSavedQueries((prev) =>
            prev.map((q) => (q.id === activeQueryId ? { ...q, ...data.query } : q)),
          );
          toast.success("Query updated", { description: name });
        } else {
          toast.error("Couldn't save query");
        }
      } else {
        const resp = await fetch("/api/saved-queries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, query: definition }),
        });
        if (resp.ok) {
          const data = await resp.json();
          setSavedQueries((prev) => [data.query, ...prev]);
          setActiveQueryId(data.query.id);
          toast.success("Query saved", { description: name });
        } else {
          toast.error("Couldn't save query");
        }
      }
    } catch {
      toast.error("Couldn't save query");
    }
    setSavePopoverOpen(false);
    setSaveName("");
  };

  const handleSaveAs = () => { setActiveQueryId(null); setSaveName(""); setSavePopoverOpen(true); };

  const handleLoad = (queryId: string) => {
    const query = savedQueries.find((q) => q.id === queryId);
    if (!query) return;
    setActiveQueryId(query.id);
    applyQueryDefinition(query.query);
    // Explicitly loading a query supersedes any restored-draft notice.
    setDraftRestored(false);
  };

  const handleDelete = async () => {
    if (!activeQueryId) return;
    try {
      const resp = await fetch(`/api/saved-queries/${activeQueryId}`, { method: "DELETE" });
      if (resp.ok) {
        setSavedQueries((prev) => prev.filter((q) => q.id !== activeQueryId));
        setActiveQueryId(null);
        toast.success("Query deleted");
      } else {
        toast.error("Couldn't delete query");
      }
    } catch {
      toast.error("Couldn't delete query");
    }
  };

  const handleNew = () => {
    setActiveQueryId(null);
    applyQueryDefinition(makeEmptyDefinition());
    // Reset clears the draft via the persistence effect; hide the restore notice.
    setDraftRestored(false);
  };

  const toggleMediaType = (type: string) => {
    setMediaTypes((prev) => prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]);
  };

  const toggleServer = (serverId: string) => {
    setSelectedServerIds((prev) =>
      prev.includes(serverId) ? prev.filter((s) => s !== serverId) : [...prev, serverId],
    );
  };

  const navigateToItem = useCallback((item: QueryResultItem) => {
    setSelectedItem(item);
  }, []);

  const handleViewModeChange = (mode: "table" | "cards") => {
    setViewMode(mode);
    localStorage.setItem("query-view-mode", mode);
  };

  const activeQuery = savedQueries.find((q) => q.id === activeQueryId);

  // ── Card grid virtualizer ──

  const [gridNode, setGridNode] = useState<HTMLDivElement | null>(null);
  const gridContainerRef = useCallback((node: HTMLDivElement | null) => {
    setGridNode(node);
  }, []);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useEffect(() => {
    if (!gridNode) {
      scrollElementRef.current = null;
      setScrollMargin(0);
      return;
    }
    // Walk up the DOM to find the nearest scrollable ancestor
    let el: HTMLElement | null = gridNode.parentElement;
    while (el) {
      const style = getComputedStyle(el);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        scrollElementRef.current = el;
        break;
      }
      el = el.parentElement;
    }
    if (!el) {
      scrollElementRef.current = document.querySelector<HTMLElement>("main");
    }
    setScrollMargin(gridNode.offsetTop);
  }, [gridNode]);

  const rowCount = useMemo(
    () => (results.length > 0 ? Math.ceil(results.length / cardColumns) : 0),
    [results.length, cardColumns],
  );

  const estimateSize = useCallback(() => {
    const containerWidth = gridNode?.offsetWidth || estimateContentWidth(window.innerWidth);
    const columnWidth = (containerWidth - GAP * (cardColumns - 1)) / cardColumns;
    const posterHeight = columnWidth * 1.5;
    return Math.round(posterHeight + QUALITY_BAR_HEIGHT + CARD_CONTENT_HEIGHT + CARD_BORDER + GAP);
  }, [cardColumns, gridNode]);

  const gridVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize,
    overscan: 10,
    scrollMargin,
  });

  useEffect(() => {
    gridVirtualizer.measure();
  }, [cardColumns, gridVirtualizer]);

  const virtualRows = gridVirtualizer.getVirtualItems();

  const getItemDetailUrl = (item: QueryResultItem): string => {
    switch (item.type) {
      case "MOVIE": return `/library/movies/${item.id}`;
      case "SERIES": return `/library/series/show/${item.id}`;
      case "MUSIC": return `/library/music/${item.id}`;
      default: return `/library/movies/${item.id}`;
    }
  };

  return (
    <>
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Query Builder</h1>
          <p className="text-muted-foreground mt-1">
            Build ad-hoc queries across your media library.
          </p>
        </div>
      </div>

      {/* Saved queries toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {savedQueries.length > 0 && (
          <Select value={activeQueryId ?? ""} onValueChange={(v) => handleLoad(v)}>
            <SelectTrigger className="w-full sm:w-56" size="sm">
              <SelectValue placeholder="Load saved query..." />
            </SelectTrigger>
            <SelectContent>
              {savedQueries.map((q) => (
                <SelectItem key={q.id} value={q.id}>{q.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Popover open={savePopoverOpen} onOpenChange={setSavePopoverOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" onClick={() => { setSaveName(activeQuery?.name ?? ""); setSavePopoverOpen(true); }}>
              <Save className="mr-1.5 h-3.5 w-3.5" />Save
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 max-w-[calc(100vw-2rem)]" align="start">
            <div className="space-y-3">
              <p className="text-sm font-medium">{activeQueryId ? "Update saved query" : "Save query as"}</p>
              <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Query name..." onKeyDown={(e) => e.key === "Enter" && handleSave()} />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave} disabled={!saveName.trim()}>
                  {activeQueryId ? "Update" : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSavePopoverOpen(false)}>Cancel</Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {activeQueryId && (
          <>
            <Button variant="outline" size="sm" onClick={handleSaveAs}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />Save As
            </Button>
            <Button variant="outline" size="sm" onClick={handleDelete} className="text-destructive hover:text-destructive">
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete
            </Button>
          </>
        )}

        <Button variant="outline" size="sm" onClick={handleNew}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />New
        </Button>

        <div className="mx-1 hidden h-5 w-px bg-border sm:block" />

        <Button
          variant="outline"
          size="sm"
          onClick={() => setConvertDialogOpen(true)}
          disabled={!isValid || mediaTypes.length === 0 || servers.length === 0}
          title={
            ruleCount === 0
              ? "Add at least one rule first"
              : !isValid
                ? "Fill in all rule values first"
                : mediaTypes.length === 0
                  ? "Pick at least one media type first"
                  : servers.length === 0
                    ? "Connect a server first"
                    : "Create a lifecycle rule set from this query"
          }
        >
          <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />Convert to Lifecycle Rule
        </Button>
      </div>

      {/* Restored draft notice */}
      {draftRestored && (
        <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <History className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-muted-foreground">
            Restored your unsaved query from this session.
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7" onClick={handleNew}>
              Discard
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setDraftRestored(false)}
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Query Scope */}
      <div className="rounded-lg border bg-card/40 p-4">
        <p className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          Query Scope
        </p>
        <div className="space-y-3">
          {/* Media types — segmented pills */}
          <ScopeRow label="Media types">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {(["MOVIE", "SERIES", "MUSIC"] as const).map((type) => {
                  const selected = mediaTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleMediaType(type)}
                      aria-pressed={selected}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
                        selected
                          ? "border-primary bg-primary/15 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {selected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                      {MEDIA_TYPE_PLURAL_LABELS[type]}
                    </button>
                  );
                })}
                <span className="ml-1 text-xs text-muted-foreground">
                  {mediaTypes.length === 0 ? "All types" : "None selected = all types"}
                </span>
              </div>

              {(mediaTypes.length === 0 || mediaTypes.includes("SERIES")) && (
                <label className="flex w-fit cursor-pointer items-center gap-1.5">
                  <Checkbox checked={includeEpisodes} onCheckedChange={(checked) => setIncludeEpisodes(checked === true)} />
                  <span className="text-sm">Include individual episodes</span>
                  <span className="text-xs text-muted-foreground">
                    — {includeEpisodes ? "showing individual episodes" : "grouping series by show"}
                  </span>
                </label>
              )}
            </div>
          </ScopeRow>

          {servers.length > 1 && (
            <ScopeRow label="Servers">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full justify-between sm:w-56">
                    <span className="truncate">
                      {selectedServerIds.length === 0 ? "All servers" : `${selectedServerIds.length} selected`}
                    </span>
                    <ChevronDown className="ml-1.5 h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56 max-w-[calc(100vw-2rem)] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search servers..." />
                    <CommandList>
                      <CommandEmpty>No servers found.</CommandEmpty>
                      <CommandGroup>
                        {servers.map((s) => {
                          const isSelected = selectedServerIds.includes(s.id);
                          return (
                            <CommandItem key={s.id} onSelect={() => toggleServer(s.id)}>
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => toggleServer(s.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="mr-2"
                              />
                              {s.name}
                              {s.type && <ServerTypeChip type={s.type} className="ml-1.5" />}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                    {selectedServerIds.length > 0 && (
                      <>
                        <Separator />
                        <div className="p-1">
                          <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setSelectedServerIds([])}>
                            Clear all
                          </Button>
                        </div>
                      </>
                    )}
                  </Command>
                </PopoverContent>
              </Popover>
            </ScopeRow>
          )}

          {/* Arr server selectors — shown when any Arr type has instances */}
          {(arrInstances.radarr.length > 0 || arrInstances.sonarr.length > 0 || arrInstances.lidarr.length > 0) && (() => {
            const showRadarr = arrInstances.radarr.length > 0 && (mediaTypes.length === 0 || mediaTypes.includes("MOVIE"));
            const showSonarr = arrInstances.sonarr.length > 0 && (mediaTypes.length === 0 || mediaTypes.includes("SERIES"));
            const showLidarr = arrInstances.lidarr.length > 0 && (mediaTypes.length === 0 || mediaTypes.includes("MUSIC"));
            if (!showRadarr && !showSonarr && !showLidarr) return null;
            return (
              <ScopeRow label="Arr servers">
                <div className="flex flex-wrap gap-2">
                  {showRadarr && (
                    <Select
                      value={arrServerIds.radarr ?? "none"}
                      onValueChange={(v) => setArrServerIds((prev) => ({ ...prev, radarr: v === "none" ? undefined : v }))}
                    >
                      <SelectTrigger className="h-8 w-44" size="sm">
                        <SelectValue placeholder="Radarr" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Radarr: None</SelectItem>
                        {arrInstances.radarr.map((inst) => (
                          <SelectItem key={inst.id} value={inst.id}>{inst.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {showSonarr && (
                    <Select
                      value={arrServerIds.sonarr ?? "none"}
                      onValueChange={(v) => setArrServerIds((prev) => ({ ...prev, sonarr: v === "none" ? undefined : v }))}
                    >
                      <SelectTrigger className="h-8 w-44" size="sm">
                        <SelectValue placeholder="Sonarr" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Sonarr: None</SelectItem>
                        {arrInstances.sonarr.map((inst) => (
                          <SelectItem key={inst.id} value={inst.id}>{inst.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {showLidarr && (
                    <Select
                      value={arrServerIds.lidarr ?? "none"}
                      onValueChange={(v) => setArrServerIds((prev) => ({ ...prev, lidarr: v === "none" ? undefined : v }))}
                    >
                      <SelectTrigger className="h-8 w-44" size="sm">
                        <SelectValue placeholder="Lidarr" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Lidarr: None</SelectItem>
                        {arrInstances.lidarr.map((inst) => (
                          <SelectItem key={inst.id} value={inst.id}>{inst.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </ScopeRow>
            );
          })()}
        </div>
      </div>

      {/* Connectivity warning: rules reference an integration that's configured but currently down */}
      <IntegrationUnreachableBanner
        health={integrationsHealth}
        hasArrRules={hasArrRules(groups)}
        hasSeerrRules={hasSeerrRules(groups)}
        relevantArrTypes={relevantArrTypes}
        arrInstanceIds={arrInstanceIds}
        seerrInstanceIds={seerrInstanceIds}
        subjectLabel="This query"
      />

      {/* Hint: orphaned Arr/Seerr rules with no integration to evaluate them */}
      {(orphanArrRules || orphanSeerrRules || seerrWithMusic) && (
        <div className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-amber shrink-0" />
          <div className="space-y-1">
            <p className="font-medium text-amber">Some criteria can&apos;t be evaluated</p>
            {orphanArrRules && (
              <p className="text-muted-foreground">
                This query uses Arr criteria but no Arr server is{" "}
                {hasAnyArrInstanceAvailable
                  ? "selected above for the relevant media type. Pick one to evaluate Arr rules — otherwise no items will match."
                  : "configured. Connect Radarr, Sonarr, or Lidarr in Settings → Integrations — otherwise no items will match these rules."}
              </p>
            )}
            {orphanSeerrRules && (
              <p className="text-muted-foreground">
                This query uses Seerr criteria but no Seerr instance is configured. Connect Overseerr or Jellyseerr in Settings → Integrations — otherwise no items will match these rules.
              </p>
            )}
            {seerrWithMusic && (
              <p className="text-muted-foreground">
                Seerr does not support music — music items will never match Seerr criteria, even when Seerr is connected.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Query builder */}
      <BuilderWithPseudocode groups={groups} config={queryBuilderConfig}>
        <QueryBuilder
          groups={groups}
          onChange={setGroups}
          distinctValues={distinctValues}
          arrConnected={hasAnyArrServer}
          arrUnreachable={integrationsStatus.arrUnreachable}
          seerrConnected={seerrConnected}
          seerrUnreachable={integrationsStatus.seerrUnreachable}
          mediaTypes={mediaTypes as ("MOVIE" | "SERIES" | "MUSIC")[]}
          includeEpisodes={includeEpisodes}
        />
      </BuilderWithPseudocode>

      {/* Run + view controls */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {ruleCount} condition{ruleCount !== 1 ? "s" : ""}
        </span>

        <div className="flex-1" />

        {/* View toggle */}
        <div className="flex items-center gap-1 rounded-lg border p-1 h-9">
          <button
            onClick={() => handleViewModeChange("table")}
            className={cn(
              "rounded-md p-1.5 transition-colors",
              viewMode === "table" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
            title="Table view"
            aria-label="Table view"
          >
            <TableProperties className="h-4 w-4" />
          </button>
          <button
            onClick={() => handleViewModeChange("cards")}
            className={cn(
              "rounded-md p-1.5 transition-colors",
              viewMode === "cards" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
            title="Card view"
            aria-label="Card view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>

        {/* Card size (only in card view) */}
        {viewMode === "cards" && <CardSizeControl size={size} onChange={setSize} />}

        {/* Column picker (only in table view) */}
        {viewMode === "table" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="default">
                <Columns3 className="mr-1.5 h-3.5 w-3.5" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 max-w-[calc(100vw-2rem)] max-h-80 overflow-y-auto p-2">
              {Object.entries(COLUMN_GROUPS).map(([groupKey, groupLabel]) => {
                const groupCols = allColumns.filter((c) => c.group === groupKey);
                if (groupCols.length === 0) return null;
                return (
                  <div key={groupKey} className="mb-2 last:mb-0">
                    <p className="mb-1 px-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">{groupLabel}</p>
                    {groupCols.map((col) => (
                      <label key={col.id} className="flex items-center gap-2 px-1 py-1 cursor-pointer rounded hover:bg-muted/50">
                        <Checkbox
                          checked={effectiveVisible.has(col.id)}
                          onCheckedChange={() => toggleColumn(col.id)}
                          disabled={col.id === "title"}
                        />
                        <span className="text-sm">{col.header}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Button onClick={runQuery} disabled={loading || !isValid}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          Run Query
        </Button>
      </div>

      {/* Results */}
      {hasRun && (
        <div className="space-y-3">
          {loading && queryProgress.phases.length > 0 ? (
            <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-3">
              <QueryProgress state={queryProgress} />
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {loading
                  ? "Searching..."
                  : `${results.length} result${results.length !== 1 ? "s" : ""} found${totalSize > 0 ? ` · ${formatBytesNum(totalSize)}` : ""}`}
              </p>
              {viewMode === "cards" && !loading && results.length > 0 && (
                <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all results"
                  />
                  {allSelected ? "Deselect all" : "Select all"}
                </label>
              )}
            </div>
          )}

          {results.length > 0 && (
            <>
              <QueryActionBar
                selectedCount={selectedIds.size}
                selectedSize={selectedSize}
                selectionTypeCounts={selectionTypeCounts}
                arrServerIds={arrServerIds}
                arrMeta={arrMeta}
                executing={executingAction}
                onExecute={executeAction}
                onClear={clearSelection}
              />
              {executingAction && actionProgress.phases.length > 0 && (
                <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-3">
                  <QueryProgress state={actionProgress} />
                </div>
              )}
            </>
          )}

          {results.length > 0 ? (
            viewMode === "table" ? (
              <DataTable
                columns={tableColumns}
                data={results}
                onRowClick={navigateToItem}
                keyExtractor={(item) => item.id}
                defaultSortId="title"
                defaultSortOrder="asc"
                resizeStorageKey="query-results-col-widths"
                renderHoverContent={(item) => (
                  <MediaHoverPopover
                    imageUrl={`/api/media/${item.id}/image${item.type === "SERIES" || item.parentTitle ? "?type=parent" : ""}`}
                    data={{
                      title: item.title,
                      year: item.year,
                      summary: item.summary,
                      contentRating: item.contentRating,
                      rating: item.rating,
                      audienceRating: item.audienceRating,
                      ratingImage: item.ratingImage,
                      audienceRatingImage: item.audienceRatingImage,
                      duration: item.matchedEpisodes != null ? undefined : item.duration,
                      resolution: item.matchedEpisodes != null ? undefined : item.resolution,
                      dynamicRange: item.matchedEpisodes != null ? undefined : item.dynamicRange,
                      audioProfile: item.matchedEpisodes != null ? undefined : item.audioProfile,
                      seasonCount: item.matchedEpisodes != null ? item.seasonCount : undefined,
                      episodeCount: item.matchedEpisodes != null ? item.matchedEpisodes : undefined,
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
              />
            ) : (
              <div ref={gridContainerRef}>
                <div
                  style={{
                    height: gridVirtualizer.getTotalSize(),
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {virtualRows.map((virtualRow) => {
                    const rowStart = virtualRow.index * cardColumns;
                    const rowItems = results.slice(rowStart, rowStart + cardColumns);
                    return (
                      <div
                        key={virtualRow.key}
                        data-index={virtualRow.index}
                        ref={gridVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          paddingBottom: GAP,
                          transform: `translateY(${virtualRow.start - gridVirtualizer.options.scrollMargin}px)`,
                        }}
                      >
                        <div
                          style={{
                            display: "grid",
                            gap: `${GAP}px`,
                            gridTemplateColumns: `repeat(${cardColumns}, minmax(0, 1fr))`,
                          }}
                        >
                          {rowItems.map((item) => (
                            <div
                              key={item.id}
                              className={cn(
                                "relative rounded-lg",
                                selectedIds.has(item.id) && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                              )}
                            >
                              <div
                                className="absolute left-2 top-2 z-10 flex rounded bg-background/80 p-0.5 backdrop-blur"
                                onClick={(e) => { e.stopPropagation(); toggleSelect(item.id); }}
                              >
                                <Checkbox
                                  checked={selectedIds.has(item.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  onCheckedChange={() => toggleSelect(item.id)}
                                  aria-label={`Select ${item.title}`}
                                />
                              </div>
                            <MediaCard
                              imageUrl={`/api/media/${item.id}/image${item.type === "SERIES" || item.parentTitle ? "?type=parent" : ""}`}
                              title={item.title}
                              fallbackIcon={FALLBACK_ICONS[item.type] ?? "movie"}
                              onClick={() => navigateToItem(item)}
                              servers={servers.length > 1 ? item.servers : undefined}
                              metadata={
                                <MetadataLine stacked>
                                  {item.type !== "SERIES" && item.year && <MetadataItem icon={<Calendar />}>{item.year}</MetadataItem>}
                                  {item.matchedEpisodes != null && (
                                    <MetadataItem icon={<Layers />}>
                                      {item.seasonCount}S / {item.matchedEpisodes}E
                                    </MetadataItem>
                                  )}
                                  {item.matchedEpisodes == null && formatDuration(item.duration) && (
                                    <MetadataItem icon={<Clock />}>{formatDuration(item.duration)}</MetadataItem>
                                  )}
                                  {formatFileSize(item.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(item.fileSize)}</MetadataItem>}
                                </MetadataLine>
                              }
                              badges={
                                <ColorChip className={MEDIA_TYPE_BADGE_COLORS[item.type] ?? ""}>
                                  {mediaTypeLabel(item.type)}
                                </ColorChip>
                              }
                              qualityBar={
                                item.matchedEpisodes == null
                                  ? [
                                      ...(item.resolution ? [{ color: getHex("resolution", formatResolution(item.resolution)), weight: 1, label: formatResolution(item.resolution) }] : []),
                                      ...(item.dynamicRange && item.dynamicRange !== "SDR" ? [{ color: getHex("dynamicRange", item.dynamicRange), weight: 1, label: item.dynamicRange }] : []),
                                      ...(item.audioProfile ? [{ color: getHex("audioProfile", item.audioProfile), weight: 1, label: item.audioProfile }] : []),
                                    ]
                                  : undefined
                              }
                              hoverContent={
                                <MediaHoverPopover
                                  data={{
                                    title: item.title,
                                    year: item.year,
                                    summary: item.summary,
                                    contentRating: item.contentRating,
                                    rating: item.rating,
                                    audienceRating: item.audienceRating,
                                    ratingImage: item.ratingImage,
                                    audienceRatingImage: item.audienceRatingImage,
                                    duration: item.matchedEpisodes != null ? undefined : item.duration,
                                    resolution: item.matchedEpisodes != null ? undefined : item.resolution,
                                    dynamicRange: item.matchedEpisodes != null ? undefined : item.dynamicRange,
                                    audioProfile: item.matchedEpisodes != null ? undefined : item.audioProfile,
                                    seasonCount: item.matchedEpisodes != null ? item.seasonCount : undefined,
                                    episodeCount: item.matchedEpisodes != null ? item.matchedEpisodes : undefined,
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
                            />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          ) : !loading ? (
            <EmptyState
              icon={Search}
              title="No results found"
              description="Try adjusting your query conditions or expanding the scope"
            />
          ) : null}
        </div>
      )}
      </div>

      {selectedItem && (
        <MediaDetailSidePanel
          item={selectedItem as unknown as MediaItemWithRelations}
          mediaType={(selectedItem.type as "MOVIE" | "SERIES" | "MUSIC") || "MOVIE"}
          onClose={() => setSelectedItem(null)}
          width={panelWidth}
          resizeHandleProps={resizeHandleProps}
          detailUrl={getItemDetailUrl(selectedItem)}
        />
      )}

      <ConvertQueryToRuleDialog
        open={convertDialogOpen}
        onOpenChange={setConvertDialogOpen}
        query={{
          mediaTypes: mediaTypes as QueryDefinition["mediaTypes"],
          serverIds: selectedServerIds,
          groups,
          sortBy,
          sortOrder,
          includeEpisodes,
          ...(Object.values(arrServerIds).some(Boolean) && { arrServerIds }),
        }}
        availableServerIds={servers.map((s) => s.id)}
        defaultName={activeQuery?.name}
      />
    </>
  );
}
