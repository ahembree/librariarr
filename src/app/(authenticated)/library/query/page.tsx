"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { usePanelResize } from "@/hooks/use-panel-resize";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import { ServerChips } from "@/components/server-chips";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { QueryBuilder, queryBuilderConfig, countAllRules, validateAllRules } from "@/components/query-builder";
import { BuilderWithPseudocode } from "@/components/builder/builder-with-pseudocode";
import type { QueryGroup, QueryDefinition } from "@/lib/query/types";
import type { MediaItemWithRelations } from "@/lib/types";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { MediaCard } from "@/components/media-card";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { CardSizeControl } from "@/components/card-size-control";
import { useCardSize } from "@/hooks/use-card-size";
import { useChipColors } from "@/components/chip-color-provider";
import { useServers } from "@/hooks/use-servers";
import { formatFileSize, formatDuration } from "@/lib/format";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { generateId } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";

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
  resolution: string | null;
  dynamicRange: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioProfile: string | null;
  container: string | null;
  fileSize: string | null;
  duration: number | null;
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

const TYPE_BADGE_COLORS: Record<string, string> = {
  MOVIE: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  SERIES: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  MUSIC: "bg-green-500/20 text-green-400 border-green-500/30",
};

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

function formatResolution(res: string | null) {
  if (!res) return "";
  const label = normalizeResolutionLabel(res);
  return label === "Other" ? res : label;
}

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
const CARD_CONTENT_HEIGHT = 138; // Fixed content area below poster (matches h-34.5 in MediaCard)
const CARD_BORDER = 2; // 1px top + 1px bottom border on Card
const QUALITY_BAR_HEIGHT = 12; // h-1 quality bar (4px) + py-1 padding (8px)
const CACHE_KEY = "query-page-state";

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

  // Results state
  const [results, setResults] = useState<QueryResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);

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

  // Distinct values for dropdowns
  const [distinctValues, setDistinctValues] = useState<Record<string, string[]>>({});

  // State cache ref for scroll restoration (read at navigation time via ref to keep navigateToItem stable)
  const cacheRef = useRef({
    mediaTypes, selectedServerIds, groups, sortBy, sortOrder,
    includeEpisodes, arrServerIds, results, activeQueryId,
  });
  cacheRef.current = {
    mediaTypes, selectedServerIds, groups, sortBy, sortOrder,
    includeEpisodes, arrServerIds, results, activeQueryId,
  };

  // Restore cached state from back navigation
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (!cached) return;
      sessionStorage.removeItem(CACHE_KEY);
      const data = JSON.parse(cached);
      if (data.results?.length > 0) {
        setMediaTypes(data.mediaTypes ?? []);
        setSelectedServerIds(data.selectedServerIds ?? []);
        setGroups(data.groups ?? [makeDefaultGroup()]);
        setSortBy(data.sortBy ?? "title");
        setSortOrder(data.sortOrder ?? "asc");
        setIncludeEpisodes(data.includeEpisodes ?? false);
        setArrServerIds(data.arrServerIds ?? {});
        setActiveQueryId(data.activeQueryId ?? null);
        setResults(data.results);
        setHasRun(true);
        const scrollTop = data.scrollTop ?? 0;
        const scrollFraction = data.scrollFraction ?? 0;
        if (scrollTop > 0) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const main = document.querySelector<HTMLElement>("main");
              if (main) {
                if (scrollFraction > 0) {
                  const maxScroll = main.scrollHeight - main.clientHeight;
                  main.scrollTo({ top: Math.round(scrollFraction * maxScroll), behavior: "instant" });
                } else {
                  main.scrollTo({ top: scrollTop, behavior: "instant" });
                }
              }
            });
          });
        }
      }
    } catch { /* invalid cache, ignore */ }
  }, []);

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
        if (data) setDistinctValues(data);
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

  // Fetch Arr metadata when selected Arr servers change (for dropdown distinct values)
  useEffect(() => {
    const fetchArrMetadata = async () => {
      const newArrTags: string[] = [];
      const newArrProfiles: string[] = [];

      const promises: Promise<void>[] = [];

      if (arrServerIds.radarr) {
        promises.push(
          fetch(`/api/integrations/radarr/${arrServerIds.radarr}/metadata`)
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
              if (data?.tags) newArrTags.push(...data.tags.map((t: { label: string }) => t.label));
              if (data?.qualityProfiles) newArrProfiles.push(...data.qualityProfiles.map((p: { name: string }) => p.name));
            })
            .catch(() => {}),
        );
      }
      if (arrServerIds.sonarr) {
        promises.push(
          fetch(`/api/integrations/sonarr/${arrServerIds.sonarr}/metadata`)
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
              if (data?.tags) newArrTags.push(...data.tags.map((t: { label: string }) => t.label));
              if (data?.qualityProfiles) newArrProfiles.push(...data.qualityProfiles.map((p: { name: string }) => p.name));
            })
            .catch(() => {}),
        );
      }
      if (arrServerIds.lidarr) {
        promises.push(
          fetch(`/api/integrations/lidarr/${arrServerIds.lidarr}/metadata`)
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
              if (data?.tags) newArrTags.push(...data.tags.map((t: { label: string }) => t.label));
              if (data?.qualityProfiles) newArrProfiles.push(...data.qualityProfiles.map((p: { name: string }) => p.name));
            })
            .catch(() => {}),
        );
      }

      await Promise.all(promises);

      // Deduplicate and sort
      const uniqueTags = [...new Set(newArrTags)].sort((a, b) => a.localeCompare(b));
      const uniqueProfiles = [...new Set(newArrProfiles)].sort((a, b) => a.localeCompare(b));

      setDistinctValues((prev) => ({
        ...prev,
        arrTag: uniqueTags,
        arrQualityProfile: uniqueProfiles,
      }));
    };

    if (arrServerIds.radarr || arrServerIds.sonarr || arrServerIds.lidarr) {
      fetchArrMetadata();
    } else {
      setDistinctValues((prev) => ({ ...prev, arrTag: [], arrQualityProfile: [] }));
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
        <ColorChip className={TYPE_BADGE_COLORS[item.type] ?? ""}>
          {item.type === "MOVIE" ? "Movie" : item.type === "SERIES" ? "Series" : "Music"}
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

  const runQuery = useCallback(
    async () => {
      setLoading(true);
      setHasRun(true);
      try {
        const cleanedArrServerIds = Object.fromEntries(
          Object.entries(arrServerIds).filter(([, v]) => v),
        );
        const definition: QueryDefinition = {
          mediaTypes: mediaTypes as QueryDefinition["mediaTypes"],
          serverIds: selectedServerIds,
          groups,
          sortBy,
          sortOrder,
          includeEpisodes,
          ...(Object.keys(cleanedArrServerIds).length > 0 && { arrServerIds: cleanedArrServerIds }),
        };

        const resp = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: definition, limit: 0 }),
        });

        if (!resp.ok) throw new Error("Query failed");
        const data = await resp.json();
        setResults(data.items ?? []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [mediaTypes, selectedServerIds, groups, sortBy, sortOrder, includeEpisodes, arrServerIds],
  );

  // ── Save/Load/Delete handlers ──

  const handleSave = async () => {
    const name = saveName.trim();
    if (!name) return;
    const cleanedArrServerIds = Object.fromEntries(
      Object.entries(arrServerIds).filter(([, v]) => v),
    );
    const definition: QueryDefinition = {
      mediaTypes: mediaTypes as QueryDefinition["mediaTypes"],
      serverIds: selectedServerIds,
      groups, sortBy, sortOrder, includeEpisodes,
      ...(Object.keys(cleanedArrServerIds).length > 0 && { arrServerIds: cleanedArrServerIds }),
    };
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
        }
      }
    } catch { /* silent */ }
    setSavePopoverOpen(false);
    setSaveName("");
  };

  const handleSaveAs = () => { setActiveQueryId(null); setSaveName(""); setSavePopoverOpen(true); };

  const handleLoad = (queryId: string) => {
    const query = savedQueries.find((q) => q.id === queryId);
    if (!query) return;
    setActiveQueryId(query.id);
    setMediaTypes(query.query.mediaTypes ?? []);
    setSelectedServerIds(query.query.serverIds ?? []);
    setGroups(query.query.groups ?? [makeDefaultGroup()]);
    setSortBy(query.query.sortBy ?? "title");
    setSortOrder(query.query.sortOrder ?? "asc");
    setIncludeEpisodes(query.query.includeEpisodes ?? false);
    setArrServerIds(query.query.arrServerIds ?? {});
    setHasRun(false);
    setResults([]);
  };

  const handleDelete = async () => {
    if (!activeQueryId) return;
    try {
      const resp = await fetch(`/api/saved-queries/${activeQueryId}`, { method: "DELETE" });
      if (resp.ok) {
        setSavedQueries((prev) => prev.filter((q) => q.id !== activeQueryId));
        setActiveQueryId(null);
      }
    } catch { /* silent */ }
  };

  const handleNew = () => {
    setActiveQueryId(null);
    setMediaTypes([]); setSelectedServerIds([]); setGroups([makeDefaultGroup()]);
    setSortBy("title"); setSortOrder("asc"); setIncludeEpisodes(false);
    setArrServerIds({});
    setHasRun(false); setResults([]);
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

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useEffect(() => {
    // Walk up the DOM to find the nearest scrollable ancestor
    let el = gridContainerRef.current?.parentElement ?? null;
    while (el) {
      const style = getComputedStyle(el);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        scrollElementRef.current = el;
        return;
      }
      el = el.parentElement;
    }
    scrollElementRef.current = document.querySelector<HTMLElement>("main");
  }, []);

  useLayoutEffect(() => {
    if (gridContainerRef.current) {
      setScrollMargin(gridContainerRef.current.offsetTop);
    }
  }, []);

  const rowCount = useMemo(
    () => (results.length > 0 ? Math.ceil(results.length / cardColumns) : 0),
    [results.length, cardColumns],
  );

  const estimateSize = useCallback(() => {
    const container = gridContainerRef.current;
    if (!container) return 350;
    const containerWidth = container.offsetWidth;
    const columnWidth = (containerWidth - GAP * (cardColumns - 1)) / cardColumns;
    const posterHeight = columnWidth * 1.5;
    return Math.round(posterHeight + QUALITY_BAR_HEIGHT + CARD_CONTENT_HEIGHT + CARD_BORDER + GAP);
  }, [cardColumns]);

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
    <div className="flex h-full">
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Query Builder</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Search across all media types, servers, and metadata
          </p>
        </div>
      </div>

      {/* Saved queries toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {savedQueries.length > 0 && (
          <Select value={activeQueryId ?? ""} onValueChange={(v) => handleLoad(v)}>
            <SelectTrigger className="w-full sm:w-60">
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
      </div>

      {/* Scope: media types + servers */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-sm font-medium text-muted-foreground">Media Types:</span>
          <div className="flex gap-2">
            {(["MOVIE", "SERIES", "MUSIC"] as const).map((type) => (
              <label key={type} className="flex items-center gap-1.5 cursor-pointer">
                <Checkbox checked={mediaTypes.includes(type)} onCheckedChange={() => toggleMediaType(type)} />
                <span className="text-sm">{type === "MOVIE" ? "Movies" : type === "SERIES" ? "Series" : "Music"}</span>
              </label>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">(empty = all types)</span>
        </div>

        {(mediaTypes.length === 0 || mediaTypes.includes("SERIES")) && (
          <div className="flex items-center gap-4 sm:pl-27">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox checked={includeEpisodes} onCheckedChange={(checked) => setIncludeEpisodes(checked === true)} />
              <span className="text-sm">Include individual episodes</span>
            </label>
            <span className="text-xs text-muted-foreground">
              {includeEpisodes ? "Showing individual episodes" : "Grouping series by show"}
            </span>
          </div>
        )}

        {servers.length > 1 && (
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-sm font-medium text-muted-foreground">Servers:</span>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <span className="truncate">
                    {selectedServerIds.length === 0 ? "All Servers" : `${selectedServerIds.length} selected`}
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
                            <div className={`mr-2 flex h-4 w-4 items-center justify-center rounded-sm border ${isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/50"}`}>
                              {isSelected && <span className="text-xs">✓</span>}
                            </div>
                            {s.name}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                  {selectedServerIds.length > 0 && (
                    <div className="border-t p-1">
                      <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setSelectedServerIds([])}>
                        Clear all
                      </Button>
                    </div>
                  )}
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        )}

        {/* Arr server selectors — shown when any Arr type has instances */}
        {(arrInstances.radarr.length > 0 || arrInstances.sonarr.length > 0 || arrInstances.lidarr.length > 0) && (() => {
          const showRadarr = arrInstances.radarr.length > 0 && (mediaTypes.length === 0 || mediaTypes.includes("MOVIE"));
          const showSonarr = arrInstances.sonarr.length > 0 && (mediaTypes.length === 0 || mediaTypes.includes("SERIES"));
          const showLidarr = arrInstances.lidarr.length > 0 && (mediaTypes.length === 0 || mediaTypes.includes("MUSIC"));
          if (!showRadarr && !showSonarr && !showLidarr) return null;
          return (
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-sm font-medium text-muted-foreground">Arr Servers:</span>
              <div className="flex flex-wrap gap-2">
                {showRadarr && (
                  <Select
                    value={arrServerIds.radarr ?? "none"}
                    onValueChange={(v) => setArrServerIds((prev) => ({ ...prev, radarr: v === "none" ? undefined : v }))}
                  >
                    <SelectTrigger className="w-48 h-8">
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
                    <SelectTrigger className="w-48 h-8">
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
                    <SelectTrigger className="w-48 h-8">
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
            </div>
          );
        })()}
      </div>

      {/* Query builder */}
      <BuilderWithPseudocode groups={groups} config={queryBuilderConfig}>
        <QueryBuilder groups={groups} onChange={setGroups} distinctValues={distinctValues} arrConnected={hasAnyArrServer} seerrConnected={seerrConnected} />
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
                    <p className="text-xs font-medium text-muted-foreground mb-1 px-1">{groupLabel}</p>
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
          <p className="text-sm text-muted-foreground">
            {loading ? "Searching..." : `${results.length} result${results.length !== 1 ? "s" : ""} found`}
          </p>

          {results.length > 0 ? (
            viewMode === "table" ? (
              <DataTable
                columns={activeColumns}
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
                      duration: item.duration,
                      resolution: item.resolution,
                      dynamicRange: item.dynamicRange,
                      audioProfile: item.audioProfile,
                      fileSize: item.fileSize,
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
                            <MediaCard
                              key={item.id}
                              imageUrl={`/api/media/${item.id}/image`}
                              title={item.title}
                              fallbackIcon={FALLBACK_ICONS[item.type] ?? "movie"}
                              onClick={() => navigateToItem(item)}
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
                                <ColorChip className={TYPE_BADGE_COLORS[item.type] ?? ""}>
                                  {item.type === "MOVIE" ? "Movie" : item.type === "SERIES" ? "Series" : "Music"}
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
                                    duration: item.duration,
                                    resolution: item.resolution,
                                    dynamicRange: item.dynamicRange,
                                    audioProfile: item.audioProfile,
                                    fileSize: item.fileSize,
                                    playCount: item.playCount,
                                    lastPlayedAt: item.lastPlayedAt,
                                    addedAt: item.addedAt,
                                    servers: item.servers,
                                  }}
                                />
                              }
                            />
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
    </div>
  );
}
