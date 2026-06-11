"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Inbox,
  Film,
  Tv,
  EyeOff,
  ChevronDown,
  ChevronUp,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { SeerrUserRequestsDialog } from "@/components/seerr-user-requests-dialog";

interface UserStats {
  userKey: string;
  seerrUsername: string;
  plexUsername: string | null;
  avatar: string | null;
  requestCount: number;
  movieCount: number;
  seriesCount: number;
  moviesWatched: number;
  seriesWithAnyEpisodeWatched: number;
  episodesWatched: number;
  episodesAvailable: number;
  correlatable: boolean;
}

interface Response {
  configured: boolean;
  users: UserStats[];
  totals: {
    requestCount: number;
    movieCount: number;
    seriesCount: number;
    moviesWatched: number;
    episodesWatched: number;
    episodesAvailable: number;
  };
}

type SortColumn = "user" | "total" | "movies" | "moviePct" | "series" | "seriesPct" | "overallPct";
type SortDir = "asc" | "desc";

function pct(num: number, denom: number): number | null {
  return denom > 0 ? Math.round((num / denom) * 100) : null;
}

interface Scores {
  moviePct: number | null;
  seriesPct: number | null;
  overallPct: number | null;
  overallNum: number;
  overallDenom: number;
}

function watchedScores(u: UserStats): Scores {
  const overallNum = u.moviesWatched + u.episodesWatched;
  const overallDenom = u.movieCount + u.episodesAvailable;
  return {
    moviePct: pct(u.moviesWatched, u.movieCount),
    seriesPct: pct(u.episodesWatched, u.episodesAvailable),
    overallPct: pct(overallNum, overallDenom),
    overallNum,
    overallDenom,
  };
}

function fmtPct(p: number | null): string {
  return p == null ? "—" : `${p}%`;
}

const AVATAR_PALETTE = [
  "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  "bg-teal-500/15 text-teal-300 ring-teal-500/30",
  "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30",
  "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30",
  "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function UserAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  const color = AVATAR_PALETTE[hashString(name) % AVATAR_PALETTE.length];
  const dims = size === "sm" ? "h-5 w-5 text-[10px]" : "h-7 w-7 text-xs";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold shrink-0 ring-1",
        dims,
        color
      )}
      aria-hidden
    >
      {initial}
    </span>
  );
}

function pctTone(p: number | null): string {
  if (p == null) return "text-muted-foreground";
  if (p >= 75) return "text-emerald-300";
  if (p >= 40) return "text-foreground";
  if (p > 0) return "text-amber-300";
  return "text-muted-foreground";
}

function ProgressBar({ value, className }: { value: number | null; className?: string }) {
  const v = value ?? 0;
  return (
    <div className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted/40", className)}>
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300",
          v >= 75 ? "bg-emerald-500/70" : v >= 40 ? "bg-primary/70" : v > 0 ? "bg-amber-500/70" : "bg-muted-foreground/30"
        )}
        style={{ width: `${Math.max(0, Math.min(100, v))}%` }}
      />
    </div>
  );
}

function SortIcon({ column, active, dir }: { column: SortColumn; active: SortColumn | null; dir: SortDir }) {
  if (active !== column) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
  return dir === "asc" ? <ArrowUp className="ml-1 inline h-3 w-3" /> : <ArrowDown className="ml-1 inline h-3 w-3" />;
}

function SortableHeader({
  children,
  column,
  sortColumn,
  sortDir,
  align = "left",
  className,
  onClick,
}: {
  children: React.ReactNode;
  column: SortColumn;
  sortColumn: SortColumn | null;
  sortDir: SortDir;
  align?: "left" | "right";
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 select-none hover:text-foreground focus:outline-none focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring rounded-sm px-0.5",
        align === "right" && "justify-end ml-auto",
        className
      )}
    >
      {children}
      <SortIcon column={column} active={sortColumn} dir={sortDir} />
    </button>
  );
}

function sortAria(active: boolean, dir: SortDir): "ascending" | "descending" | "none" {
  if (!active) return "none";
  return dir === "asc" ? "ascending" : "descending";
}

function sortValue(u: UserStats, col: SortColumn): number | string {
  const s = watchedScores(u);
  switch (col) {
    case "user":
      return u.seerrUsername.toLowerCase();
    case "total":
      return u.requestCount;
    case "movies":
      return u.movieCount;
    case "moviePct":
      return s.moviePct ?? -1;
    case "series":
      return u.seriesCount;
    case "seriesPct":
      return s.seriesPct ?? -1;
    case "overallPct":
      return s.overallPct ?? -1;
  }
}

export function SeerrRequestStats() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [sortColumn, setSortColumn] = useState<SortColumn>("total");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [openUserKey, setOpenUserKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/seerr/request-stats");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as Response;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedUsers = useMemo(() => {
    if (!data) return [];
    const arr = [...data.users];
    arr.sort((a, b) => {
      const av = sortValue(a, sortColumn);
      const bv = sortValue(b, sortColumn);
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = av as number;
      const bn = bv as number;
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return arr;
  }, [data, sortColumn, sortDir]);

  const overallAvgPct = useMemo(() => {
    if (!data) return null;
    const denom = data.totals.movieCount + data.totals.episodesAvailable;
    return pct(data.totals.moviesWatched + data.totals.episodesWatched, denom);
  }, [data]);

  function toggleSort(col: SortColumn) {
    if (sortColumn === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(col);
      setSortDir(col === "user" ? "asc" : "desc");
    }
  }

  const headerSubtitle = data?.configured ? (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10.5px] text-faint">
      <span>
        <span className="text-foreground">{data.totals.requestCount.toLocaleString()}</span> requests
      </span>
      <span aria-hidden>·</span>
      <span>
        <span className="text-foreground">{data.users.length}</span>{" "}
        {data.users.length === 1 ? "user" : "users"}
      </span>
      {overallAvgPct != null && (
        <>
          <span aria-hidden>·</span>
          <span>
            <span className={cn(pctTone(overallAvgPct))}>{overallAvgPct}%</span> watched
          </span>
        </>
      )}
    </div>
  ) : null;

  const header = (
    <CardHeader className="pb-3 flex flex-row items-start justify-between gap-2 space-y-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] border border-border bg-surface-2 text-muted-foreground">
          <Inbox className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <CardTitle className="truncate text-sm font-semibold leading-tight">
            Seerr Requests
          </CardTitle>
          {headerSubtitle}
        </div>
      </div>
      {data?.configured && data.users.length > 5 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-xs"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? (
            <>
              <ChevronUp className="mr-1 h-3 w-3" />
              Top 5
            </>
          ) : (
            <>
              <ChevronDown className="mr-1 h-3 w-3" />
              All {data.users.length}
            </>
          )}
        </Button>
      )}
    </CardHeader>
  );

  if (loading) {
    return (
      <Card className="h-full flex flex-col">
        {header}
        <CardContent className="flex-1 min-h-0 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-1.5">
              <Skeleton className="h-7 w-7 rounded-full" />
              <Skeleton className="h-3.5 flex-1" />
              <Skeleton className="h-3.5 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="h-full flex flex-col">
        {header}
        <CardContent className="flex-1 min-h-0">
          <p className="text-sm text-muted-foreground">Could not load Seerr stats: {error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!data?.configured) {
    return (
      <Card className="h-full flex flex-col">
        {header}
        <CardContent className="flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-2 py-8">
          <div className="rounded-full bg-muted/40 p-3">
            <Inbox className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground max-w-xs">
            Connect a Seerr instance in{" "}
            <span className="font-medium text-foreground">Settings → Integrations</span> to see request statistics.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (data.users.length === 0) {
    return (
      <Card className="h-full flex flex-col">
        {header}
        <CardContent className="flex-1 min-h-0 flex items-center justify-center py-8">
          <p className="text-sm text-muted-foreground">No Seerr requests found yet.</p>
        </CardContent>
      </Card>
    );
  }

  const dialog = (
    <SeerrUserRequestsDialog
      userKey={openUserKey}
      open={openUserKey !== null}
      onClose={() => setOpenUserKey(null)}
    />
  );

  if (showAll) {
    return (
      <>
      <Card className="h-full flex flex-col">
        {header}
        <CardContent className="flex-1 min-h-0 overflow-auto p-0">
          <TooltipProvider delayDuration={200}>
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead aria-sort={sortAria(sortColumn === "user", sortDir)}>
                    <SortableHeader column="user" sortColumn={sortColumn} sortDir={sortDir} onClick={() => toggleSort("user")}>
                      User
                    </SortableHeader>
                  </TableHead>
                  <TableHead className="text-right" aria-sort={sortAria(sortColumn === "total", sortDir)}>
                    <SortableHeader column="total" sortColumn={sortColumn} sortDir={sortDir} align="right" onClick={() => toggleSort("total")}>
                      Total
                    </SortableHeader>
                  </TableHead>
                  <TableHead className="text-right" aria-sort={sortAria(sortColumn === "movies", sortDir)}>
                    <SortableHeader column="movies" sortColumn={sortColumn} sortDir={sortDir} align="right" onClick={() => toggleSort("movies")}>
                      <Film className="h-3.5 w-3.5" />
                    </SortableHeader>
                  </TableHead>
                  <TableHead className="text-right" aria-sort={sortAria(sortColumn === "moviePct", sortDir)}>
                    <SortableHeader column="moviePct" sortColumn={sortColumn} sortDir={sortDir} align="right" onClick={() => toggleSort("moviePct")}>
                      Movie %
                    </SortableHeader>
                  </TableHead>
                  <TableHead className="text-right" aria-sort={sortAria(sortColumn === "series", sortDir)}>
                    <SortableHeader column="series" sortColumn={sortColumn} sortDir={sortDir} align="right" onClick={() => toggleSort("series")}>
                      <Tv className="h-3.5 w-3.5" />
                    </SortableHeader>
                  </TableHead>
                  <TableHead className="text-right" aria-sort={sortAria(sortColumn === "seriesPct", sortDir)}>
                    <SortableHeader column="seriesPct" sortColumn={sortColumn} sortDir={sortDir} align="right" onClick={() => toggleSort("seriesPct")}>
                      Series %
                    </SortableHeader>
                  </TableHead>
                  <TableHead className="text-right min-w-[120px]" aria-sort={sortAria(sortColumn === "overallPct", sortDir)}>
                    <SortableHeader column="overallPct" sortColumn={sortColumn} sortDir={sortDir} align="right" onClick={() => toggleSort("overallPct")}>
                      Overall
                    </SortableHeader>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedUsers.map((u) => {
                  const score = watchedScores(u);
                  return (
                    <TableRow
                      key={u.userKey}
                      role="button"
                      tabIndex={0}
                      onClick={() => setOpenUserKey(u.userKey)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenUserKey(u.userKey);
                        }
                      }}
                      className="cursor-pointer hover:bg-muted/30 focus:outline-none focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2 min-w-0">
                          <UserAvatar name={u.seerrUsername} size="sm" />
                          <span className="truncate">{u.seerrUsername}</span>
                          {!u.correlatable && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <EyeOff className="h-3 w-3 text-muted-foreground shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>
                                No linked Plex username — watch history can&apos;t be correlated.
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {u.requestCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {u.movieCount.toLocaleString()}
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", pctTone(score.moviePct))}>
                        {u.correlatable && u.movieCount > 0 ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{fmtPct(score.moviePct)}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {u.moviesWatched} of {u.movieCount} movies watched
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {u.seriesCount.toLocaleString()}
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", pctTone(score.seriesPct))}>
                        {u.correlatable && u.episodesAvailable > 0 ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{fmtPct(score.seriesPct)}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {u.episodesWatched} of {u.episodesAvailable} requested episodes watched
                              {u.seriesWithAnyEpisodeWatched > 0 &&
                                ` · ${u.seriesWithAnyEpisodeWatched} of ${u.seriesCount} series started`}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {u.correlatable && score.overallDenom > 0 ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center justify-end gap-2 min-w-[110px]">
                                <ProgressBar value={score.overallPct} className="w-16" />
                                <span className={cn("tabular-nums text-sm w-9 text-right", pctTone(score.overallPct))}>
                                  {fmtPct(score.overallPct)}
                                </span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              {score.overallNum} of {score.overallDenom} units watched (movies + episodes)
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TooltipProvider>
        </CardContent>
      </Card>
      {dialog}
      </>
    );
  }

  const topUsers = data.users.slice(0, 5);

  return (
    <>
    <Card className="h-full flex flex-col">
      {header}
      <CardContent className="flex-1 min-h-0 overflow-auto">
        <TooltipProvider delayDuration={200}>
          <ul className="space-y-2">
            {topUsers.map((u) => {
              const score = watchedScores(u);
              return (
                <li
                  key={u.userKey}
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpenUserKey(u.userKey)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenUserKey(u.userKey);
                    }
                  }}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/30 transition-colors focus:outline-none focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <UserAvatar name={u.seerrUsername} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{u.seerrUsername}</span>
                      {!u.correlatable && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <EyeOff className="h-3 w-3 text-muted-foreground shrink-0" />
                          </TooltipTrigger>
                          <TooltipContent>
                            No linked Plex username — watch history can&apos;t be correlated.
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        <span className="font-medium text-foreground">{u.requestCount.toLocaleString()}</span>{" "}
                        {u.requestCount === 1 ? "request" : "requests"}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Film className="h-3 w-3" />
                            <span className="tabular-nums">{u.movieCount}</span>
                            {u.correlatable && u.movieCount > 0 && (
                              <span className={cn("tabular-nums", pctTone(score.moviePct))}>
                                {fmtPct(score.moviePct)}
                              </span>
                            )}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {u.correlatable && u.movieCount > 0
                            ? `${u.moviesWatched} of ${u.movieCount} movies watched`
                            : `${u.movieCount} ${u.movieCount === 1 ? "movie" : "movies"} requested`}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Tv className="h-3 w-3" />
                            <span className="tabular-nums">{u.seriesCount}</span>
                            {u.correlatable && u.episodesAvailable > 0 && (
                              <span className={cn("tabular-nums", pctTone(score.seriesPct))}>
                                {fmtPct(score.seriesPct)}
                              </span>
                            )}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {u.correlatable && u.episodesAvailable > 0
                            ? `${u.episodesWatched} of ${u.episodesAvailable} requested episodes watched`
                            : `${u.seriesCount} ${u.seriesCount === 1 ? "series" : "series"} requested`}
                        </TooltipContent>
                      </Tooltip>
                      {u.correlatable && score.overallDenom > 0 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="ml-auto inline-flex items-center gap-2">
                              <ProgressBar value={score.overallPct} className="w-20" />
                              <span className={cn("tabular-nums w-9 text-right", pctTone(score.overallPct))}>
                                {fmtPct(score.overallPct)}
                              </span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            Overall: {score.overallNum} of {score.overallDenom} units watched (movies + episodes)
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </TooltipProvider>
      </CardContent>
    </Card>
    {dialog}
    </>
  );
}
