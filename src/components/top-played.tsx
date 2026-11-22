"use client";

import { useEffect, useState, type ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { Film, Tv, Music, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { FadeImage } from "@/components/fade-image";
import { CACHE_WIDTH_GRID, withImageWidth } from "@/lib/image-url";
import { InsightCard, InsightEmpty } from "@/components/dashboard/insight-card";
import { LazyMediaHoverPopover } from "@/components/lazy-media-hover-popover";
import { hoverDataFromRecord, type MediaHoverData } from "@/components/media-hover-popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDashboardCardDisplay } from "@/hooks/use-dashboard-card-display";
import type { CardDisplay } from "@/lib/dashboard/card-display";
import { PLAY_RANGE_OPTIONS, isPlayRange, playRangeLabel, type PlayRange } from "@/lib/dashboard/play-range";

interface TopMovie {
  id: string;
  title: string;
  year: number | null;
  playCount: number;
}

interface TopSeries {
  parentTitle: string;
  totalPlays: number;
  mediaItemId: string | null;
}

interface TopMusic {
  parentTitle: string;
  totalPlays: number;
  mediaItemId: string | null;
}

interface TopPlayedProps {
  topMovies: TopMovie[];
  topSeries: TopSeries[];
  topMusic: TopMusic[];
  filterType?: "MOVIE" | "SERIES" | "MUSIC";
  /** The dashboard's server pick, for the windowed lists' request. */
  serverId?: string;
  /** The card's saved display choices (its time range) and their setter. */
  display?: CardDisplay;
  onDisplayChange?: (next: CardDisplay | undefined) => void;
  onMovieClick?: (movieId: string) => void;
  onSeriesClick?: (seriesName: string, mediaItemId?: string) => void;
  onArtistClick?: (mediaItemId: string) => void;
}

// The popovers' readers, module-level so each row hands its popover the same
// function on every render.
/** A movie's `/api/media/[id]` record, through the one record mapping. */
const movieHoverData = (json: unknown) => hoverDataFromRecord((json as { item: MediaHoverData }).item);
/** `group-summary` already answers in the popover's shape. */
const groupSummaryHoverData = (json: unknown) => json as MediaHoverData;

/** Artwork thumbnail with icon fallback; 2:3 for video, square for music. */
function Thumb({
  src,
  square = false,
  fallback: Icon,
}: {
  src: string | null;
  square?: boolean;
  fallback: LucideIcon;
}) {
  const [err, setErr] = useState(false);

  // Reset the failure flag when the source changes (rows are keyed by
  // title for series/music, so a re-sync can swap the image URL without
  // remounting — a once-failed thumb must get a fresh chance).
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    setPrevSrc(src);
    setErr(false);
  }

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-[5px] border border-white/5 bg-muted",
        square ? "h-9 w-9" : "h-[42px] w-7",
      )}
    >
      {src && !err ? (
        <FadeImage
          src={withImageWidth(src, CACHE_WIDTH_GRID)}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setErr(true)}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

/** One ranked entry: rank, poster thumb, title, play count, with a
 *  share-of-max background fill. Spreads rest props (and ref, via React 19
 *  props) onto the root div so it works as a HoverCardTrigger asChild
 *  target — without this the lazy popovers never open. */
function RankedRow({
  rank,
  fillPct,
  thumb,
  title,
  plays,
  className,
  ...rest
}: {
  rank: number;
  fillPct: number;
  thumb: React.ReactNode;
  title: React.ReactNode;
  plays: number;
} & Omit<ComponentProps<"div">, "title">) {
  return (
    <div
      {...rest}
      className={cn(
        "group relative flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50",
        className,
      )}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-md bg-brand-faint"
        style={{ width: `${fillPct}%` }}
      />
      <span className="relative w-5 shrink-0 text-right font-mono text-[11px] text-faint">
        {rank}
      </span>
      <span className="relative">{thumb}</span>
      <span className="relative min-w-0 flex-1 truncate text-[13px] font-medium">
        {title}
      </span>
      <span className="relative flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
        <Play className="h-3 w-3 fill-current" />
        {plays.toLocaleString()}
      </span>
    </div>
  );
}

interface WindowLists {
  topMovies: TopMovie[];
  topSeries: TopSeries[];
  topMusic: TopMusic[];
}

const ALL_TIME = "all";

/**
 * How often a windowed list is asked again on its own. The window rolls with
 * the clock, so on a page with no sync or watch-history event to refetch the
 * stats, plays that aged out would otherwise stay listed. With the route's
 * 5-minute cache, a list on screen is at most about ten minutes behind.
 */
export const WINDOW_REFRESH_MS = 5 * 60_000;

/**
 * The lists over a time-range preset, from `GET /api/media/stats/top-played`.
 * Asked again whenever the all-time lists change identity (the page refetches
 * its stats on every sync and watch-history event) and every
 * `WINDOW_REFRESH_MS`, so the window rolls forward on a quiet page too.
 * `null` while the first answer for the current range is outstanding.
 */
function useWindowLists(
  range: PlayRange | undefined,
  serverId: string | undefined,
  refreshToken: unknown,
): { lists: WindowLists | null; failed: boolean } {
  const [state, setState] = useState<{ key: string; lists: WindowLists | null; failed: boolean }>({
    key: "",
    lists: null,
    failed: false,
  });
  const key = range ? `${range}:${serverId ?? ""}` : "";
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!range) return;
    const interval = setInterval(() => setTick((t) => t + 1), WINDOW_REFRESH_MS);
    return () => clearInterval(interval);
  }, [range]);

  useEffect(() => {
    if (!range) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ range });
    if (serverId) params.set("serverId", serverId);
    fetch(`/api/media/stats/top-played?${params}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<WindowLists>) : Promise.reject(new Error(String(res.status)))))
      .then((lists) => setState({ key, lists, failed: false }))
      .catch(() => {
        if (controller.signal.aborted) return;
        // Keep a range's previous answer on a failed refresh.
        setState((prev) => (prev.key === key && prev.lists ? prev : { key, lists: null, failed: true }));
      });
    return () => controller.abort();
  }, [range, serverId, key, refreshToken, tick]);

  if (!range || state.key !== key) return { lists: null, failed: false };
  return { lists: state.lists, failed: state.failed };
}

export function TopPlayed({
  topMovies: allTimeMovies,
  topSeries: allTimeSeries,
  topMusic: allTimeMusic,
  filterType,
  serverId,
  display,
  onDisplayChange,
  onMovieClick,
  onSeriesClick,
  onArtistClick,
}: TopPlayedProps) {
  const [choices, updateChoices] = useDashboardCardDisplay(display, onDisplayChange, filterType);
  const range = choices.range;
  const { lists: windowLists, failed } = useWindowLists(range, serverId, allTimeMovies);

  const showMovies = !filterType || filterType === "MOVIE";
  const showSeries = !filterType || filterType === "SERIES";
  const showMusic = !filterType || filterType === "MUSIC";

  const lists = range ? windowLists : { topMovies: allTimeMovies, topSeries: allTimeSeries, topMusic: allTimeMusic };
  const topMovies = lists?.topMovies ?? [];
  const topSeries = lists?.topSeries ?? [];
  const topMusic = lists?.topMusic ?? [];

  // All time with no plays at all: nothing to show (as before). A window keeps
  // the card, so its range can be changed back.
  if (!range && topMovies.length === 0 && topSeries.length === 0 && topMusic.length === 0) {
    return null;
  }

  const rangeLabel = playRangeLabel(range).toLowerCase();
  const loading = range !== undefined && lists === null && !failed;
  const emptyMessage = (kind: string) =>
    failed
      ? "Failed to load play data."
      : loading
        ? "Loading…"
        : range
          ? `No ${kind} plays in the ${rangeLabel}.`
          : `No ${kind} play data yet.`;
  const subLine = (count: number) =>
    count > 0 ? `top ${count} · ${range ? rangeLabel : "by play count"}` : range ? rangeLabel : undefined;

  const rangeSelect = (
    <Select
      value={range ?? ALL_TIME}
      onValueChange={(v) => updateChoices({ range: isPlayRange(v) ? v : undefined })}
    >
      <SelectTrigger size="sm" className="w-32 min-w-0 max-w-full text-xs" aria-label="Time range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_TIME}>All Time</SelectItem>
        {PLAY_RANGE_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  // One picker for the three lists, on the first one shown.
  const firstShown = showMovies ? "movies" : showSeries ? "series" : "music";
  const controlsFor = (list: "movies" | "series" | "music") => (list === firstShown ? rangeSelect : undefined);

  const movieCard = (
    <InsightCard
      icon={Film}
      title="Most Played Movies"
      sub={subLine(topMovies.length)}
      controls={controlsFor("movies")}
    >
      {topMovies.length === 0 ? (
        <InsightEmpty icon={Film} message={emptyMessage("movie")} />
      ) : (
        <div className="space-y-0.5">
          {topMovies.map((movie, i) => {
            const maxPlays = topMovies[0].playCount;
            const placeholder: MediaHoverData = {
              title: movie.title,
              year: movie.year,
              playCount: movie.playCount,
            };
            return (
              <LazyMediaHoverPopover
                key={movie.id}
                fetchUrl={`/api/media/${movie.id}`}
                extractData={movieHoverData}
                placeholder={placeholder}
                imageUrl={`/api/media/${movie.id}/image`}
                imageAspect="poster"
              >
                <RankedRow
                  rank={i + 1}
                  fillPct={maxPlays > 0 ? (movie.playCount / maxPlays) * 100 : 0}
                  thumb={<Thumb src={`/api/media/${movie.id}/image`} fallback={Film} />}
                  title={
                    <>
                      {movie.title}
                      {movie.year && (
                        <span className="ml-1 font-normal text-muted-foreground">
                          ({movie.year})
                        </span>
                      )}
                    </>
                  }
                  plays={movie.playCount}
                  onClick={() => onMovieClick?.(movie.id)}
                />
              </LazyMediaHoverPopover>
            );
          })}
        </div>
      )}
    </InsightCard>
  );

  const seriesCard = (
    <InsightCard
      icon={Tv}
      title="Most Played Series"
      sub={subLine(topSeries.length)}
      controls={controlsFor("series")}
    >
      {topSeries.length === 0 ? (
        <InsightEmpty icon={Tv} message={emptyMessage("series")} />
      ) : (
        <div className="space-y-0.5">
          {topSeries.map((series, i) => {
            const maxPlays = topSeries[0].totalPlays;
            const placeholder: MediaHoverData = {
              title: series.parentTitle,
              playCount: series.totalPlays,
            };
            const row = (
              <RankedRow
                rank={i + 1}
                fillPct={maxPlays > 0 ? (series.totalPlays / maxPlays) * 100 : 0}
                thumb={
                  <Thumb
                    src={
                      series.mediaItemId
                        ? `/api/media/${series.mediaItemId}/image?type=parent`
                        : null
                    }
                    fallback={Tv}
                  />
                }
                title={series.parentTitle}
                plays={series.totalPlays}
                onClick={() =>
                  onSeriesClick?.(series.parentTitle, series.mediaItemId ?? undefined)
                }
              />
            );
            if (!series.mediaItemId) {
              return <div key={`${i}:${series.parentTitle}`}>{row}</div>;
            }
            return (
              // Two shows can share a title (rows are grouped by seriesKey),
              // so the title alone is not a unique key.
              <LazyMediaHoverPopover
                key={series.mediaItemId}
                fetchUrl={`/api/media/${series.mediaItemId}/group-summary?type=SERIES`}
                extractData={groupSummaryHoverData}
                placeholder={placeholder}
                imageUrl={`/api/media/${series.mediaItemId}/image?type=parent`}
                imageAspect="poster"
              >
                {row}
              </LazyMediaHoverPopover>
            );
          })}
        </div>
      )}
    </InsightCard>
  );

  const musicCard = (
    <InsightCard
      icon={Music}
      title="Most Played Artists"
      sub={subLine(topMusic.length)}
      controls={controlsFor("music")}
    >
      {topMusic.length === 0 ? (
        <InsightEmpty icon={Music} message={emptyMessage("music")} />
      ) : (
        <div className="space-y-0.5">
          {topMusic.map((artist, i) => {
            const maxPlays = topMusic[0].totalPlays;
            const placeholder: MediaHoverData = {
              title: artist.parentTitle,
              playCount: artist.totalPlays,
            };
            const row = (
              <RankedRow
                rank={i + 1}
                fillPct={maxPlays > 0 ? (artist.totalPlays / maxPlays) * 100 : 0}
                thumb={
                  <Thumb
                    src={
                      artist.mediaItemId
                        ? `/api/media/${artist.mediaItemId}/image?type=parent`
                        : null
                    }
                    square
                    fallback={Music}
                  />
                }
                title={artist.parentTitle}
                plays={artist.totalPlays}
                onClick={() => artist.mediaItemId && onArtistClick?.(artist.mediaItemId)}
              />
            );
            if (!artist.mediaItemId) {
              return <div key={artist.parentTitle}>{row}</div>;
            }
            return (
              <LazyMediaHoverPopover
                key={artist.parentTitle}
                fetchUrl={`/api/media/${artist.mediaItemId}/group-summary?type=MUSIC`}
                extractData={groupSummaryHoverData}
                placeholder={placeholder}
                imageUrl={`/api/media/${artist.mediaItemId}/image?type=parent`}
                imageAspect="square"
              >
                {row}
              </LazyMediaHoverPopover>
            );
          })}
        </div>
      )}
    </InsightCard>
  );

  const visibleCount = [showMovies, showSeries, showMusic].filter(Boolean).length;

  return (
    // Columns by the card's width (the dashboard cell is a size container),
    // not the window's. A height set shorter than the lists scrolls them as
    // one, instead of running them out of the cell over the cards below.
    <div className={`grid h-full gap-6 overflow-auto ${visibleCount >= 2 ? "@2xl:grid-cols-2" : ""}`}>
      {showMovies && movieCard}
      {showSeries && seriesCard}
      {showMusic && musicCard}
    </div>
  );
}
