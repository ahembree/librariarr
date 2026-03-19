"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Clock, Film, Tv, Music, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { formatRelativeDate } from "@/lib/format";

interface RecentItem {
  id: string;
  title: string;
  year: number | null;
  type: "MOVIE" | "SERIES" | "MUSIC";
  parentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  addedAt: string | null;
  thumbUrl: string | null;
  parentThumbUrl: string | null;
}

interface RecentlyAddedProps {
  filterType?: "MOVIE" | "SERIES" | "MUSIC";
  lockedFilterType?: boolean;
  serverId?: string;
  servers?: { id: string; name: string }[];
  availableTypes?: string[];
  onMovieClick?: (movieId: string) => void;
  onSeriesClick?: (seriesName: string) => void;
}

const PAGE_SIZE = 10;

function formatEpisode(item: RecentItem): string {
  if (item.type === "MOVIE") {
    return item.year ? `${item.title} (${item.year})` : item.title;
  }
  if (item.type === "MUSIC") {
    return `${item.parentTitle ?? "Unknown"} — ${item.title}`;
  }
  const s = item.seasonNumber?.toString().padStart(2, "0") ?? "00";
  const e = item.episodeNumber?.toString().padStart(2, "0") ?? "00";
  return `${item.parentTitle ?? "Unknown"} — S${s}E${e}`;
}

export function RecentlyAdded({
  filterType,
  lockedFilterType,
  serverId,
  servers,
  availableTypes,
  onMovieClick,
  onSeriesClick,
}: RecentlyAddedProps) {
  const [items, setItems] = useState<RecentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(10);
  const [page, setPage] = useState(0);
  const [localType, setLocalType] = useState<"MOVIE" | "SERIES" | "MUSIC" | undefined>(filterType);
  const [localServerId, setLocalServerId] = useState<string | undefined>(undefined);

  useEffect(() => {
    setLocalType(filterType);
  }, [filterType]);

  useEffect(() => {
    setLocalServerId(undefined);
  }, [serverId]);

  const effectiveType = lockedFilterType ? filterType : localType;
  const effectiveServerId = localServerId ?? serverId;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (effectiveType) params.set("type", effectiveType);
      if (effectiveServerId) params.set("serverId", effectiveServerId);
      const res = await fetch(`/api/media/recently-added?${params}`);
      const data = await res.json();
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch (error) {
      console.error("Failed to fetch recently added:", error);
    } finally {
      setLoading(false);
    }
  }, [limit, effectiveType, effectiveServerId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    setPage(0);
  }, [limit, effectiveType, effectiveServerId]);

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" />
            Recently Added
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {!lockedFilterType && (
              <Select
                value={localType ?? "all"}
                onValueChange={(v) => setLocalType(v === "all" ? undefined : v as "MOVIE" | "SERIES" | "MUSIC")}
              >
                <SelectTrigger className="h-7 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {(!availableTypes || availableTypes.length === 0 || availableTypes.includes("MOVIE")) && (
                    <SelectItem value="MOVIE">Movies</SelectItem>
                  )}
                  {(!availableTypes || availableTypes.length === 0 || availableTypes.includes("SERIES")) && (
                    <SelectItem value="SERIES">Series</SelectItem>
                  )}
                  {(!availableTypes || availableTypes.length === 0 || availableTypes.includes("MUSIC")) && (
                    <SelectItem value="MUSIC">Music</SelectItem>
                  )}
                </SelectContent>
              </Select>
            )}
            {servers && servers.length > 1 && (
              <Select
                value={localServerId ?? "default"}
                onValueChange={(v) => setLocalServerId(v === "default" ? undefined : v)}
              >
                <SelectTrigger className="h-7 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{serverId ? "Dashboard" : "All Servers"}</SelectItem>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
              <SelectTrigger className="h-7 w-[70px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recent additions yet.
          </p>
        ) : (
          <>
            <div className="space-y-1">
              {pageItems.map((item) => {
                const handleClick = () => {
                  if (item.type === "MOVIE") {
                    onMovieClick?.(item.id);
                  } else if (item.parentTitle) {
                    onSeriesClick?.(item.parentTitle);
                  }
                };

                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={handleClick}
                  >
                    {item.type === "MOVIE" ? (
                      <Film className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : item.type === "MUSIC" ? (
                      <Music className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Tv className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate text-sm">
                      {formatEpisode(item)}
                    </span>
                    {item.addedAt && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelativeDate(item.addedAt)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-3 border-t">
                <span className="text-xs text-muted-foreground">
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, items.length)} of {items.length}
                  {total > items.length && ` (${total.toLocaleString()} total)`}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  {Array.from({ length: totalPages }, (_, i) => (
                    <Button
                      key={i}
                      variant={i === page ? "default" : "ghost"}
                      size="icon"
                      className="h-7 w-7 text-xs"
                      onClick={() => setPage(i)}
                    >
                      {i + 1}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(page + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
