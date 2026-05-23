"use client";

import { useEffect, useState } from "react";
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
import { Inbox, Loader2, Film, Tv, Eye, EyeOff, ChevronDown, ChevronUp } from "lucide-react";

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

export function SeerrRequestStats() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

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

  const header = (
    <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
      <CardTitle className="flex items-center gap-2 text-base">
        <Inbox className="h-4 w-4" />
        Seerr Requests
      </CardTitle>
      {data?.configured && data.users.length > 5 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
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
              View all ({data.users.length})
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
        <CardContent className="flex-1 min-h-0 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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
        <CardContent className="flex-1 min-h-0">
          <p className="text-sm text-muted-foreground">
            Connect a Seerr instance in Settings → Integrations to see request statistics.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (data.users.length === 0) {
    return (
      <Card className="h-full flex flex-col">
        {header}
        <CardContent className="flex-1 min-h-0">
          <p className="text-sm text-muted-foreground">No Seerr requests found yet.</p>
        </CardContent>
      </Card>
    );
  }

  if (showAll) {
    return (
      <Card className="h-full flex flex-col">
        {header}
        <CardContent className="flex-1 min-h-0 overflow-auto p-0">
          <TooltipProvider delayDuration={200}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">
                    <Film className="ml-auto h-3.5 w-3.5" />
                  </TableHead>
                  <TableHead className="text-right">Movie %</TableHead>
                  <TableHead className="text-right">
                    <Tv className="ml-auto h-3.5 w-3.5" />
                  </TableHead>
                  <TableHead className="text-right">Series %</TableHead>
                  <TableHead className="text-right">Overall %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.users.map((u) => {
                  const score = watchedScores(u);
                  return (
                    <TableRow key={u.userKey}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <span className="truncate">{u.seerrUsername}</span>
                          {!u.correlatable && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <EyeOff className="h-3 w-3 text-muted-foreground" />
                              </TooltipTrigger>
                              <TooltipContent>
                                No linked Plex username — watch history can&apos;t be correlated.
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {u.requestCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {u.movieCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
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
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {u.seriesCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
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
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {u.correlatable && score.overallDenom > 0 ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{fmtPct(score.overallPct)}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {score.overallNum} of {score.overallDenom} units watched (movies + episodes)
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          "—"
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
    );
  }

  const topUsers = data.users.slice(0, 5);
  const maxRequests = topUsers[0]?.requestCount ?? 1;

  return (
    <Card className="h-full flex flex-col">
      {header}
      <CardContent className="flex-1 min-h-0 overflow-auto">
        <TooltipProvider delayDuration={200}>
          <div className="space-y-1">
            {topUsers.map((u, i) => {
              const score = watchedScores(u);
              const barPct = maxRequests > 0 ? (u.requestCount / maxRequests) * 100 : 0;
              return (
                <div
                  key={u.userKey}
                  className="group relative flex items-center gap-3 rounded-md px-2 py-1.5"
                >
                  <div
                    className="absolute inset-0 rounded-md bg-primary/5"
                    style={{ width: `${barPct}%` }}
                  />
                  <span className="relative w-5 text-right text-xs font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="relative flex-1 min-w-0 truncate text-sm flex items-center gap-1.5">
                    {u.seerrUsername}
                    {!u.correlatable && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <EyeOff className="h-3 w-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          No linked Plex username — watch history can&apos;t be correlated.
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                  <span className="relative flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center gap-1">
                          <Film className="h-3 w-3" />
                          {u.movieCount}
                          {u.correlatable && u.movieCount > 0 && (
                            <span className="text-muted-foreground/60">·{fmtPct(score.moviePct)}</span>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {u.correlatable && u.movieCount > 0
                          ? `${u.moviesWatched} of ${u.movieCount} movies watched`
                          : "Movies requested"}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center gap-1">
                          <Tv className="h-3 w-3" />
                          {u.seriesCount}
                          {u.correlatable && u.episodesAvailable > 0 && (
                            <span className="text-muted-foreground/60">·{fmtPct(score.seriesPct)}</span>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {u.correlatable && u.episodesAvailable > 0
                          ? `${u.episodesWatched} of ${u.episodesAvailable} requested episodes watched`
                          : "Series requested"}
                      </TooltipContent>
                    </Tooltip>
                    {u.correlatable && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center gap-1">
                            <Eye className="h-3 w-3" />
                            {fmtPct(score.overallPct)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          Overall: {score.overallNum} of {score.overallDenom} units watched (movies + episodes)
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <span className="font-medium text-foreground">
                      {u.requestCount.toLocaleString()}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
