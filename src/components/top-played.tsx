"use client";

import { useState, type ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { Film, Tv, Music, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { FadeImage } from "@/components/ui/fade-image";
import { InsightCard, InsightEmpty } from "@/components/dashboard/insight-card";
import { LazyMediaHoverPopover } from "@/components/lazy-media-hover-popover";
import type { MediaHoverData } from "@/components/media-hover-popover";

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
  onMovieClick?: (movieId: string) => void;
  onSeriesClick?: (seriesName: string, mediaItemId?: string) => void;
  onArtistClick?: (mediaItemId: string) => void;
}

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
          src={src}
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

export function TopPlayed({
  topMovies,
  topSeries,
  topMusic,
  filterType,
  onMovieClick,
  onSeriesClick,
  onArtistClick,
}: TopPlayedProps) {
  const showMovies = !filterType || filterType === "MOVIE";
  const showSeries = !filterType || filterType === "SERIES";
  const showMusic = !filterType || filterType === "MUSIC";

  if (topMovies.length === 0 && topSeries.length === 0 && topMusic.length === 0) {
    return null;
  }

  const movieCard = (
    <InsightCard
      icon={Film}
      title="Most Played Movies"
      sub={topMovies.length > 0 ? `top ${topMovies.length} · by play count` : undefined}
    >
      {topMovies.length === 0 ? (
        <InsightEmpty icon={Film} message="No movie play data yet." />
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
                extractData={(json) => (json as { item: MediaHoverData }).item}
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
      sub={topSeries.length > 0 ? `top ${topSeries.length} · by play count` : undefined}
    >
      {topSeries.length === 0 ? (
        <InsightEmpty icon={Tv} message="No series play data yet." />
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
              return <div key={series.parentTitle}>{row}</div>;
            }
            return (
              <LazyMediaHoverPopover
                key={series.parentTitle}
                fetchUrl={`/api/media/${series.mediaItemId}/group-summary?type=SERIES`}
                extractData={(json) => json as MediaHoverData}
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
      sub={topMusic.length > 0 ? `top ${topMusic.length} · by play count` : undefined}
    >
      {topMusic.length === 0 ? (
        <InsightEmpty icon={Music} message="No music play data yet." />
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
                extractData={(json) => json as MediaHoverData}
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
    <div className={`grid gap-6 h-full ${visibleCount >= 2 ? "lg:grid-cols-2" : ""}`}>
      {showMovies && movieCard}
      {showSeries && seriesCard}
      {showMusic && musicCard}
    </div>
  );
}
