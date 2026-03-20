"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Film, Tv, Music, Play } from "lucide-react";

interface TopMovie {
  id: string;
  title: string;
  year: number | null;
  playCount: number;
}

interface TopSeries {
  parentTitle: string;
  totalPlays: number;
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
  onSeriesClick?: (seriesName: string) => void;
  onArtistClick?: (mediaItemId: string) => void;
}

export function TopPlayed({ topMovies, topSeries, topMusic, filterType, onMovieClick, onSeriesClick, onArtistClick }: TopPlayedProps) {
  const showMovies = !filterType || filterType === "MOVIE";
  const showSeries = !filterType || filterType === "SERIES";
  const showMusic = !filterType || filterType === "MUSIC";

  if (topMovies.length === 0 && topSeries.length === 0 && topMusic.length === 0) {
    return null;
  }

  const movieCard = (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Film className="h-4 w-4" />
          Most Played Movies
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-auto">
        {topMovies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No movie play data yet.
          </p>
        ) : (
          <div className="space-y-1">
            {topMovies.map((movie, i) => {
              const maxPlays = topMovies[0].playCount;
              const pct = maxPlays > 0 ? (movie.playCount / maxPlays) * 100 : 0;
              return (
                <div
                  key={movie.id}
                  className="group relative flex items-center gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => onMovieClick?.(movie.id)}
                >
                  <div
                    className="absolute inset-0 rounded-md bg-primary/5"
                    style={{ width: `${pct}%` }}
                  />
                  <span className="relative w-5 text-right text-xs font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="relative flex-1 truncate text-sm">
                    {movie.title}
                    {movie.year && (
                      <span className="ml-1 text-muted-foreground">
                        ({movie.year})
                      </span>
                    )}
                  </span>
                  <span className="relative flex items-center gap-1 text-xs text-muted-foreground">
                    <Play className="h-3 w-3 fill-current" />
                    {movie.playCount.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );

  const seriesCard = (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Tv className="h-4 w-4" />
          Most Played Series
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-auto">
        {topSeries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No series play data yet.
          </p>
        ) : (
          <div className="space-y-1">
            {topSeries.map((series, i) => {
              const maxPlays = topSeries[0].totalPlays;
              const pct =
                maxPlays > 0 ? (series.totalPlays / maxPlays) * 100 : 0;
              return (
                <div
                  key={series.parentTitle}
                  className="group relative flex items-center gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => onSeriesClick?.(series.parentTitle)}
                >
                  <div
                    className="absolute inset-0 rounded-md bg-primary/5"
                    style={{ width: `${pct}%` }}
                  />
                  <span className="relative w-5 text-right text-xs font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="relative flex-1 truncate text-sm">
                    {series.parentTitle}
                  </span>
                  <span className="relative flex items-center gap-1 text-xs text-muted-foreground">
                    <Play className="h-3 w-3 fill-current" />
                    {series.totalPlays.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );

  const musicCard = (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Music className="h-4 w-4" />
          Most Played Artists
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-auto">
        {topMusic.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No music play data yet.
          </p>
        ) : (
          <div className="space-y-1">
            {topMusic.map((artist, i) => {
              const maxPlays = topMusic[0].totalPlays;
              const pct =
                maxPlays > 0 ? (artist.totalPlays / maxPlays) * 100 : 0;
              return (
                <div
                  key={artist.parentTitle}
                  className="group relative flex items-center gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => artist.mediaItemId && onArtistClick?.(artist.mediaItemId)}
                >
                  <div
                    className="absolute inset-0 rounded-md bg-primary/5"
                    style={{ width: `${pct}%` }}
                  />
                  <span className="relative w-5 text-right text-xs font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="relative flex-1 truncate text-sm">
                    {artist.parentTitle}
                  </span>
                  <span className="relative flex items-center gap-1 text-xs text-muted-foreground">
                    <Play className="h-3 w-3 fill-current" />
                    {artist.totalPlays.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
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
