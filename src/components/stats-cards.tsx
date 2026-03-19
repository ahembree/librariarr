import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Film, Tv, HardDrive, Music, Clock, Database } from "lucide-react";
import { formatBytesNum, formatDurationLarge } from "@/lib/format";

interface StatsProps {
  stats: {
    movieCount: number;
    seriesCount: number;
    seasonCount: number;
    musicCount: number;
    artistCount: number;
    albumCount: number;
    episodeCount: number;
    totalSize: string;
    movieSize: string;
    seriesSize: string;
    musicSize: string;
    movieDuration: number;
    seriesDuration: number;
    musicDuration: number;
  };
  availableTypes?: string[];
}

function StatRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

export function StatsCards({ stats, availableTypes }: StatsProps) {
  const showAll = !availableTypes || availableTypes.length === 0;

  // Count visible cards: media type cards + always-visible Total Size
  const visibleCount =
    (showAll ? 3 : availableTypes!.filter((t) => ["MOVIE", "SERIES", "MUSIC"].includes(t)).length) + 1;

  const gridCols =
    visibleCount === 1
      ? "grid-cols-1"
      : visibleCount === 2
        ? "sm:grid-cols-2"
        : visibleCount === 3
          ? "sm:grid-cols-3"
          : "sm:grid-cols-2 lg:grid-cols-4";

  return (
    <div className={`grid gap-4 h-full ${gridCols}`}>
      {(showAll || availableTypes!.includes("MOVIE")) && (
        <Card className="gap-2 h-full flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between pb-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Movies
            </CardTitle>
            <Film className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2 flex-1 flex flex-col justify-between">
            <div className="text-3xl font-bold">{stats.movieCount.toLocaleString()}</div>
            <p className="text-sm invisible" aria-hidden="true">&nbsp;</p>
            <div className="space-y-1">
              <StatRow icon={<Database className="h-3.5 w-3.5" />} label="Size" value={formatBytesNum(Number(stats.movieSize))} />
              <StatRow icon={<Clock className="h-3.5 w-3.5" />} label="Runtime" value={formatDurationLarge(stats.movieDuration)} />
            </div>
          </CardContent>
        </Card>
      )}

      {(showAll || availableTypes!.includes("SERIES")) && (
        <Card className="gap-2 h-full flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between pb-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Series
            </CardTitle>
            <Tv className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2 flex-1 flex flex-col justify-between">
            <div className="text-3xl font-bold">{stats.seriesCount.toLocaleString()}</div>
            <p className="text-sm text-muted-foreground">
              {stats.seasonCount.toLocaleString()} seasons | {stats.episodeCount.toLocaleString()} episodes
            </p>
            <div className="space-y-1">
              <StatRow icon={<Database className="h-3.5 w-3.5" />} label="Size" value={formatBytesNum(Number(stats.seriesSize))} />
              <StatRow icon={<Clock className="h-3.5 w-3.5" />} label="Runtime" value={formatDurationLarge(stats.seriesDuration)} />
            </div>
          </CardContent>
        </Card>
      )}

      {(showAll || availableTypes!.includes("MUSIC")) && (
        <Card className="gap-2 h-full flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between pb-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Music
            </CardTitle>
            <Music className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2 flex-1 flex flex-col justify-between">
            <div className="text-3xl font-bold">{stats.musicCount.toLocaleString()}</div>
            <p className="text-sm text-muted-foreground">
              {stats.artistCount.toLocaleString()} artists | {stats.albumCount.toLocaleString()} albums
            </p>
            <div className="space-y-1">
              <StatRow icon={<Database className="h-3.5 w-3.5" />} label="Size" value={formatBytesNum(Number(stats.musicSize))} />
              <StatRow icon={<Clock className="h-3.5 w-3.5" />} label="Runtime" value={formatDurationLarge(stats.musicDuration)} />
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="gap-2 h-full flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between pb-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Totals
          </CardTitle>
          <HardDrive className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="space-y-2 flex-1 flex flex-col justify-between">
          <div className="text-3xl font-bold">
            {formatBytesNum(Number(stats.totalSize))}
          </div>
          <p className="text-sm invisible" aria-hidden="true">&nbsp;</p>
          <div className="space-y-1">
            <div className="text-sm invisible" aria-hidden="true">&nbsp;</div>
            <StatRow icon={<Clock className="h-3.5 w-3.5" />} label="Runtime" value={formatDurationLarge(stats.movieDuration + stats.seriesDuration + stats.musicDuration)} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
