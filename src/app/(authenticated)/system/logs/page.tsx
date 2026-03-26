"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Info,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";

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

const LEVEL_COLORS: Record<string, string> = {
  DEBUG: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  INFO: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  WARN: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  ERROR: "bg-red-500/20 text-red-400 border-red-500/30",
};

const LEVEL_ICONS: Record<string, React.ReactNode> = {
  DEBUG: <Bug className="h-4 w-4 text-zinc-400" />,
  INFO: <Info className="h-4 w-4 text-blue-400" />,
  WARN: <TriangleAlert className="h-4 w-4 text-amber-400" />,
  ERROR: <CircleAlert className="h-4 w-4 text-red-400" />,
};

const CATEGORY_COLORS: Record<string, string> = {
  BACKEND: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  API: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  DB: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
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
    fetchLogs();
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
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl font-bold">Logs</h1>
        <div className="flex items-center gap-2">
          <Button
            variant={autoRefresh ? "default" : "outline"}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            <RefreshCw
              className={`mr-1 h-3.5 w-3.5 ${autoRefresh ? "animate-spin" : ""}`}
            />
            {autoRefresh ? "Live" : "Auto-refresh"}
          </Button>
          <Button variant="outline" size="sm" onClick={fetchLogs}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
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
        <div className="flex min-w-0 flex-1 gap-2 sm:flex-initial">
          <Input
            placeholder="Search messages..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="min-w-0 flex-1 sm:w-64 sm:flex-initial"
          />
          <Button onClick={handleSearch} variant="secondary" size="default">
            Search
          </Button>
        </div>

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        )}
      </div>

      {/* Log table */}
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-40">Timestamp</TableHead>
              <TableHead className="w-20">Level</TableHead>
              <TableHead className="hidden w-24 md:table-cell">Category</TableHead>
              <TableHead className="hidden w-28 md:table-cell">Source</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  No log entries found.
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                    {formatTimestamp(log.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={LEVEL_COLORS[log.level] ?? ""}
                    >
                      {log.level}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge
                      variant="outline"
                      className={`text-xs ${CATEGORY_COLORS[log.category] ?? ""}`}
                    >
                      {log.category}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden text-sm font-medium md:table-cell">
                    {log.source}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <span className="mb-0.5 flex flex-wrap gap-1 md:hidden">
                      <Badge variant="outline" className={`text-xs ${CATEGORY_COLORS[log.category] ?? ""}`}>{log.category}</Badge>
                      <span className="text-xs text-muted-foreground/70">{log.source}</span>
                    </span>
                    <span className="block">{log.message}</span>
                    {log.meta && Object.keys(log.meta).length > 0 && (
                      <pre className="mt-1 text-xs text-muted-foreground/70 font-mono whitespace-pre-wrap break-all">
                        {JSON.stringify(log.meta, null, 2)}
                      </pre>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {total} log {total === 1 ? "entry" : "entries"}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
