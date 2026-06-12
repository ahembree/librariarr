import { Film, Tv, HardDrive, Music } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
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

/** A single KPI tile matching the design handoff's stat-card. */
function StatCard({
  icon: Icon,
  value,
  label,
  sub,
  rows,
  accent = false,
}: {
  icon: LucideIcon;
  value: string;
  label: string;
  sub?: string;
  rows?: { label: string; value: string }[];
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex h-full flex-col overflow-hidden rounded-[14px] border bg-card px-[18px] pt-[17px] pb-4 shadow-[var(--shadow-card)]",
        accent ? "border-brand-dim" : "border-border"
      )}
      style={
        accent
          ? {
              background:
                "radial-gradient(120% 120% at 0% 0%, var(--brand-faint), transparent 60%), var(--card)",
            }
          : undefined
      }
    >
      <div className="mb-3.5 flex items-center justify-between">
        <span
          className={cn(
            "grid h-[34px] w-[34px] place-items-center rounded-[9px] border",
            accent
              ? "border-transparent bg-brand-dim text-brand-bright"
              : "border-border bg-surface-2 text-muted-foreground"
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
      </div>
      <div className="font-display text-[30px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
        {value}
      </div>
      <div className="mt-2 text-[13px] font-semibold">{label}</div>
      {sub && <div className="mt-1 font-mono text-[11.5px] text-faint">{sub}</div>}
      {rows && rows.length > 0 && (
        <div className="mt-auto space-y-1 pt-3 font-mono text-[11.5px]">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between">
              <span className="text-faint">{r.label}</span>
              <span className="text-foreground">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function StatsCards({ stats, availableTypes }: StatsProps) {
  const showAll = !availableTypes || availableTypes.length === 0;

  const show = {
    movie: showAll || availableTypes!.includes("MOVIE"),
    series: showAll || availableTypes!.includes("SERIES"),
    music: showAll || availableTypes!.includes("MUSIC"),
  };

  const visibleCount = (Number(show.movie) + Number(show.series) + Number(show.music)) + 1;

  const gridCols =
    visibleCount === 1
      ? "grid-cols-1"
      : visibleCount === 2
        ? "sm:grid-cols-2"
        : visibleCount === 3
          ? "sm:grid-cols-3"
          : "sm:grid-cols-2 lg:grid-cols-4";

  // The first visible tile carries the accent wash, like the handoff KPI band.
  const firstAccent = show.movie ? "movie" : show.series ? "series" : show.music ? "music" : "totals";

  return (
    <div className={`grid h-full gap-4 ${gridCols}`}>
      {show.movie && (
        <StatCard
          icon={Film}
          accent={firstAccent === "movie"}
          value={stats.movieCount.toLocaleString()}
          label="Movies"
          rows={[
            { label: "Size", value: formatBytesNum(Number(stats.movieSize)) },
            { label: "Runtime", value: formatDurationLarge(stats.movieDuration) },
          ]}
        />
      )}

      {show.series && (
        <StatCard
          icon={Tv}
          accent={firstAccent === "series"}
          value={stats.seriesCount.toLocaleString()}
          label="Series"
          sub={`${stats.seasonCount.toLocaleString()} seasons · ${stats.episodeCount.toLocaleString()} episodes`}
          rows={[
            { label: "Size", value: formatBytesNum(Number(stats.seriesSize)) },
            { label: "Runtime", value: formatDurationLarge(stats.seriesDuration) },
          ]}
        />
      )}

      {show.music && (
        <StatCard
          icon={Music}
          accent={firstAccent === "music"}
          value={stats.musicCount.toLocaleString()}
          label="Music"
          sub={`${stats.artistCount.toLocaleString()} artists · ${stats.albumCount.toLocaleString()} albums`}
          rows={[
            { label: "Size", value: formatBytesNum(Number(stats.musicSize)) },
            { label: "Runtime", value: formatDurationLarge(stats.musicDuration) },
          ]}
        />
      )}

      <StatCard
        icon={HardDrive}
        accent={firstAccent === "totals"}
        value={formatBytesNum(Number(stats.totalSize))}
        label="Library size"
        rows={[
          {
            label: "Runtime",
            value: formatDurationLarge(
              stats.movieDuration + stats.seriesDuration + stats.musicDuration
            ),
          },
        ]}
      />
    </div>
  );
}
