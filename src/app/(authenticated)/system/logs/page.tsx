"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bug,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileText,
  Info,
  Pause,
  Play,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { LogConsoleSkeleton } from "@/components/skeletons";

interface LogEntry {
  id: string;
  level: string;
  category: string;
  source: string;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

// Console level colors from the handoff: debug=faint, info=sky, warn=amber,
// error=red — rendered as colored mono text, not chips.
const LEVEL_TEXT: Record<string, string> = {
  DEBUG: "text-faint",
  INFO: "text-sky",
  WARN: "text-amber",
  ERROR: "text-red",
};

const LEVEL_ICONS: Record<string, React.ReactNode> = {
  DEBUG: <Bug className="h-4 w-4 text-faint" />,
  INFO: <Info className="h-4 w-4 text-sky" />,
  WARN: <TriangleAlert className="h-4 w-4 text-amber" />,
  ERROR: <CircleAlert className="h-4 w-4 text-red" />,
};

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);

  // Filters
  const [activeLevels, setActiveLevels] = useState<Set<string>>(
    new Set(["INFO", "WARN", "ERROR"])
  );
  const [category, setCategory] = useState("all");
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sources, setSources] = useState<string[]>([]);

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (activeLevels.size > 0 && activeLevels.size < LOG_LEVELS.length) {
        params.set("level", [...activeLevels].join(","));
      }
      if (category && category !== "all") params.set("category", category);
      if (source && source !== "all") params.set("source", source);
      if (search) params.set("search", search);
      params.set("page", page.toString());
      params.set("limit", "100");

      const res = await fetch(`/api/system/logs?${params}`);
      const data = await res.json();
      setLogs(data.logs ?? []);
      setTotal(data.total ?? 0);
      setPages(data.pages ?? 1);
    } catch {
      // Ignore fetch errors
    } finally {
      setLoading(false);
    }
  }, [activeLevels, category, source, search, page]);

  // Fetch distinct sources on mount
  useEffect(() => {
    fetch("/api/system/logs/sources")
      .then((r) => r.json())
      .then((data) => {
        setSources(data.sources ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void (async () => { await fetchLogs(); })();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const toggleLevel = (level: string) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
    setPage(1);
  };

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const clearFilters = () => {
    setActiveLevels(new Set(["INFO", "WARN", "ERROR"]));
    setCategory("all");
    setSource("all");
    setSearch("");
    setSearchInput("");
    setPage(1);
  };

  const hasFilters =
    activeLevels.size !== 3 ||
    !["INFO", "WARN", "ERROR"].every((l) => activeLevels.has(l)) ||
    category !== "all" ||
    source !== "all" ||
    search !== "";

  function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Logs</h1>
          <p className="text-muted-foreground mt-1">
            Application activity from the backend, API requests, and database operations.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant={autoRefresh ? "default" : "outline"}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? (
              <Pause className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            {autoRefresh ? "Live" : "Auto-refresh"}
          </Button>
          <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* Log level dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="default">
              Log Levels
              {activeLevels.size < LOG_LEVELS.length && (
                <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-xs">
                  {activeLevels.size}
                </Badge>
              )}
              <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Filter by level</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {LOG_LEVELS.map((level) => (
              <DropdownMenuCheckboxItem
                key={level}
                checked={activeLevels.has(level)}
                onCheckedChange={() => toggleLevel(level)}
                onSelect={(e) => e.preventDefault()}
              >
                <span className="flex items-center gap-2">
                  {LEVEL_ICONS[level]}
                  {level}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Category filter */}
        <Select value={category} onValueChange={(v) => { setCategory(v); setPage(1); }}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="BACKEND">Backend</SelectItem>
            <SelectItem value="API">API</SelectItem>
            <SelectItem value="DB">DB</SelectItem>
          </SelectContent>
        </Select>

        {/* Source filter */}
        {sources.length > 0 && (
          <Select value={source} onValueChange={(v) => { setSource(v); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="All Sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sources</SelectItem>
              {sources.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Search */}
        <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-initial">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search messages..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="pl-8 pr-8"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => { setSearchInput(""); if (search) { setSearch(""); setPage(1); } }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Button onClick={handleSearch} variant="secondary" size="default" disabled={searchInput === search}>
          Search
        </Button>

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 h-4 w-4" />
            Clear all
          </Button>
        )}
      </div>

      {/* Result count */}
      {!loading && logs.length > 0 && (
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {total.toLocaleString()} {total === 1 ? "entry" : "entries"}
            {hasFilters && " matching filters"}
          </span>
          {autoRefresh && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>Live · refreshing every 5s</span>
            </span>
          )}
        </div>
      )}

      {/* Console */}
      {loading && logs.length === 0 ? (
        <LogConsoleSkeleton />
      ) : logs.length === 0 ? (
        <EmptyState icon={FileText} title="No log entries found" description="Logs will appear here as activity occurs." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-surface-0 shadow-[var(--shadow-card)]">
          <div className="min-h-[200px] overflow-x-hidden py-2">
            {logs.map((log) => (
              <div
                key={log.id}
                className="flex items-baseline gap-3 px-4 py-[5px] transition-colors hover:bg-white/[0.03]"
              >
                <span className="shrink-0 font-mono text-[11px] whitespace-nowrap text-faint tabular-nums">
                  {formatTimestamp(log.createdAt)}
                </span>
                <span
                  className={`w-12 shrink-0 font-mono text-[10px] font-semibold tracking-[0.05em] uppercase ${LEVEL_TEXT[log.level] ?? "text-faint"}`}
                >
                  {log.level}
                </span>
                <span className="shrink-0 font-mono text-[11.5px] text-brand-bright">{log.source}</span>
                <span className="min-w-0 flex-1 font-mono text-[12px] break-words text-muted-foreground">
                  {log.message}
                  {log.meta && Object.keys(log.meta).length > 0 && (
                    <span className="mt-0.5 block font-mono text-[11px] break-all whitespace-pre-wrap text-faint">
                      {JSON.stringify(log.meta)}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="text-sm text-muted-foreground mr-2">
            Page {page} of {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
