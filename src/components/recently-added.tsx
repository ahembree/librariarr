"use client";

import { useState, useEffect, useCallback, useRef, type ComponentProps } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { FadeImage } from "@/components/ui/fade-image";
import { Clock, Film, Tv, Music, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format";
import { getDuplicateServerNames } from "@/lib/server-styles";
import { ServerTypeChip } from "@/components/server-type-chip";
import { LazyMediaHoverPopover } from "@/components/lazy-media-hover-popover";
import type { MediaHoverData } from "@/components/media-hover-popover";

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
  servers?: { id: string; name: string; type?: string }[];
  availableTypes?: string[];
  onMovieClick?: (movieId: string) => void;
  onEpisodeClick?: (episodeId: string) => void;
  onTrackClick?: (trackId: string) => void;
}

/** How many items the shelf fetches (scrolled horizontally, no paging). */
const SHELF_LIMIT = 24;

const TYPE_ICONS = { MOVIE: Film, SERIES: Tv, MUSIC: Music } as const;

function pad2(n: number | null): string {
  return (n ?? 0).toString().padStart(2, "0");
}

/** Full display name, used for popover placeholders and aria labels. */
function formatEpisode(item: RecentItem): string {
  if (item.type === "MOVIE") {
    return item.year ? `${item.title} (${item.year})` : item.title;
  }
  if (item.type === "MUSIC") {
    return `${item.parentTitle ?? "Unknown"} — ${item.title}`;
  }
  return `${item.parentTitle ?? "Unknown"} — S${pad2(item.seasonNumber)}E${pad2(item.episodeNumber)}`;
}

/** One poster tile on the shelf. Video uses 2:3 posters (episodes show the
 *  series poster); music uses square album art — same height, Plex-style
 *  mixed row. Spreads rest props (and ref, via React 19 props) onto the
 *  button so it can serve as a HoverCardTrigger asChild target. */
function ShelfTile({
  item,
  className,
  ...rest
}: { item: RecentItem } & ComponentProps<"button">) {
  const [imgError, setImgError] = useState(false);
  const isMusic = item.type === "MUSIC";
  const Icon = TYPE_ICONS[item.type];

  const primary = item.type === "SERIES" ? (item.parentTitle ?? item.title) : item.title;
  const secondary =
    item.type === "MOVIE"
      ? item.year?.toString() ?? ""
      : item.type === "SERIES"
        ? `S${pad2(item.seasonNumber)} · E${pad2(item.episodeNumber)}`
        : item.parentTitle ?? "";

  return (
    <button
      {...rest}
      type="button"
      aria-label={formatEpisode(item)}
      className={cn(
        "group shrink-0 snap-start rounded-lg text-left transition-transform duration-300 ease-out hover:-translate-y-1",
        isMusic ? "w-42" : "w-28",
        className,
      )}
    >
      <div className="relative h-42 overflow-hidden rounded-lg border bg-muted transition-shadow duration-300 group-hover:shadow-[0_12px_28px_-10px_oklch(0_0_0/0.65)] group-hover:ring-1 group-hover:ring-white/10">
        {imgError ? (
          <div className="flex h-full items-center justify-center">
            <Icon className="h-7 w-7 text-muted-foreground" />
          </div>
        ) : (
          <FadeImage
            src={`/api/media/${item.id}/image${item.type === "SERIES" ? "?type=parent" : ""}`}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
            onError={() => setImgError(true)}
          />
        )}
        {item.addedAt && (
          <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/60 px-1.5 py-[3px] font-mono text-[10px] leading-none text-white/90 backdrop-blur-sm">
            {formatRelativeDate(item.addedAt)}
          </span>
        )}
      </div>
      <p className="mt-1.5 truncate text-xs font-medium">{primary}</p>
      <p className="truncate font-mono text-[10.5px] text-faint">{secondary || "\u00A0"}</p>
    </button>
  );
}

export function RecentlyAdded({
  filterType,
  lockedFilterType,
  serverId,
  servers,
  availableTypes,
  onMovieClick,
  onEpisodeClick,
  onTrackClick,
}: RecentlyAddedProps) {
  const [items, setItems] = useState<RecentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [localType, setLocalType] = useState<"MOVIE" | "SERIES" | "MUSIC" | undefined>(filterType);
  const [localServerId, setLocalServerId] = useState<string | undefined>(undefined);
  const shelfRef = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  // Sync local overrides to prop changes (React 19 idiom: store prev render).
  const [prevFilterType, setPrevFilterType] = useState(filterType);
  if (prevFilterType !== filterType) {
    setPrevFilterType(filterType);
    setLocalType(filterType);
  }
  const [prevServerId, setPrevServerId] = useState(serverId);
  if (prevServerId !== serverId) {
    setPrevServerId(serverId);
    setLocalServerId(undefined);
  }

  const effectiveType = lockedFilterType ? filterType : localType;
  const effectiveServerId = localServerId ?? serverId;

  // Token guards against a stale slow response landing after a quick
  // filter/server flip and showing the wrong items for the selection.
  const reqToken = useRef(0);

  const fetchData = useCallback(async () => {
    const token = ++reqToken.current;
    try {
      const params = new URLSearchParams({ limit: String(SHELF_LIMIT) });
      if (effectiveType) params.set("type", effectiveType);
      if (effectiveServerId) params.set("serverId", effectiveServerId);
      const res = await fetch(`/api/media/recently-added?${params}`);
      if (!res.ok || token !== reqToken.current) return;
      const data = await res.json();
      if (token !== reqToken.current) return;
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch (error) {
      console.error("Failed to fetch recently added:", error);
    } finally {
      if (token === reqToken.current) setLoading(false);
    }
  }, [effectiveType, effectiveServerId]);

  useEffect(() => {
    void (async () => { await fetchData(); })();
  }, [fetchData]);

  const updateScroll = useCallback(() => {
    const el = shelfRef.current;
    if (!el) return;
    setCanScroll({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);

  // Recompute chevron state when content or container size changes (the
  // shelf can resize without a window resize — e.g. sidebar collapse);
  // reset the shelf to the start when the filtered item set is replaced.
  useEffect(() => {
    shelfRef.current?.scrollTo({ left: 0 });
    updateScroll();
    const observer = new ResizeObserver(updateScroll);
    if (shelfRef.current) observer.observe(shelfRef.current);
    return () => observer.disconnect();
  }, [items, updateScroll]);

  const scrollShelf = (dir: 1 | -1) => {
    const el = shelfRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  const handleClick = (item: RecentItem) => {
    if (item.type === "MOVIE") {
      onMovieClick?.(item.id);
    } else if (item.type === "SERIES") {
      onEpisodeClick?.(item.id);
    } else if (item.type === "MUSIC") {
      onTrackClick?.(item.id);
    }
  };

  return (
    <Card className="h-full flex flex-col gap-3">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <CardTitle className="flex items-baseline gap-2 text-base">
            <span className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Recently Added
            </span>
            {total > 0 && (
              <span className="font-mono text-[11px] font-normal text-faint">
                {Math.min(items.length, SHELF_LIMIT)} of {total.toLocaleString()}
              </span>
            )}
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
                  {(() => {
                    const dupeNames = getDuplicateServerNames(servers);
                    return servers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="inline-flex items-center gap-1.5">
                          {s.name}
                          {dupeNames.has(s.name) && s.type && <ServerTypeChip type={s.type} />}
                        </span>
                      </SelectItem>
                    ));
                  })()}
                </SelectContent>
              </Select>
            )}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Scroll back"
                disabled={!canScroll.left}
                onClick={() => scrollShelf(-1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Scroll forward"
                disabled={!canScroll.right}
                onClick={() => scrollShelf(1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        {loading ? (
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="w-28 shrink-0">
                <Skeleton className="h-42 w-28 rounded-lg" />
                <Skeleton className="mt-1.5 h-3.5 w-24" />
                <Skeleton className="mt-1 h-3 w-14" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-42 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Clock className="h-6 w-6" />
            <p className="text-sm">No recent additions yet.</p>
          </div>
        ) : (
          <div
            ref={shelfRef}
            onScroll={updateScroll}
            className="flex snap-x gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {items.map((item) => (
              <LazyMediaHoverPopover
                key={item.id}
                fetchUrl={`/api/media/${item.id}`}
                extractData={(json) => {
                  const data = (json as { item: MediaHoverData }).item;
                  return item.type === "MOVIE"
                    ? data
                    : { ...data, title: formatEpisode(item) };
                }}
                placeholder={{
                  title: formatEpisode(item),
                  year: item.year,
                  addedAt: item.addedAt,
                }}
                imageUrl={`/api/media/${item.id}/image${item.type === "SERIES" ? "?type=parent" : ""}`}
                imageAspect={item.type === "MUSIC" ? "square" : "poster"}
              >
                <ShelfTile item={item} onClick={() => handleClick(item)} />
              </LazyMediaHoverPopover>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
