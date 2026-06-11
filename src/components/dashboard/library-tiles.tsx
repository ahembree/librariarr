"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, Film, HardDrive, Music, Tv } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytesNum, formatDurationLarge } from "@/lib/format";

interface LibraryStats {
  movieCount: number;
  seriesCount: number;
  seasonCount: number;
  episodeCount: number;
  musicCount: number;
  artistCount: number;
  albumCount: number;
  totalSize: string;
  movieSize: string;
  seriesSize: string;
  musicSize: string;
  movieDuration: number;
  seriesDuration: number;
  musicDuration: number;
}

/** Months of addedAt history shown in each tile's growth sparkline. */
const SPARK_MONTHS = 12;

/** Decorative additions-per-month sparkline (area + line, brand-tinted). */
function Sparkline({ values }: { values: number[] }) {
  const gradientId = useId();
  const W = 100;
  const H = 28;
  const PAD = 2;

  if (values.length < 2 || values.every((v) => v === 0)) {
    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-9 w-full"
        aria-hidden
      >
        <line
          x1={0}
          y1={H - PAD}
          x2={W}
          y2={H - PAD}
          stroke="var(--border-strong)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  const max = Math.max(...values);
  const stepX = W / (values.length - 1);
  const points = values.map((v, i) => ({
    x: i * stepX,
    y: H - PAD - (v / max) * (H - PAD * 2),
  }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-9 w-full"
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.3} />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke="var(--brand-bright)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LibraryTile({
  href,
  icon: Icon,
  label,
  value,
  sub,
  rows,
  spark,
  accent = false,
}: {
  href?: string;
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  rows: { label: string; value: string }[];
  spark?: number[];
  accent?: boolean;
}) {
  const body = (
    <>
      <div className="mb-3.5 flex items-center justify-between">
        <span
          className={cn(
            "grid h-[34px] w-[34px] place-items-center rounded-[9px] border",
            accent
              ? "border-transparent bg-brand-dim text-brand-bright"
              : "border-border bg-surface-2 text-muted-foreground",
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        {href && (
          <ArrowUpRight className="h-4 w-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </div>
      <div className="font-display text-[30px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
        {value}
      </div>
      <div className="mt-2 text-[13px] font-semibold">{label}</div>
      <div className="mt-1 font-mono text-[11.5px] text-faint">{sub ?? " "}</div>
      {spark && (
        <div className="mt-3">
          <Sparkline values={spark} />
          <div className="mt-1 font-mono text-[10px] tracking-[0.08em] text-faint uppercase">
            Added · last {SPARK_MONTHS}mo
          </div>
        </div>
      )}
      <div className="mt-auto space-y-1 pt-3 font-mono text-[11.5px]">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between">
            <span className="text-faint">{r.label}</span>
            <span className="text-foreground">{r.value}</span>
          </div>
        ))}
      </div>
    </>
  );

  const className = cn(
    "group relative flex h-full flex-col overflow-hidden rounded-[14px] border bg-card px-[18px] pt-[17px] pb-4 shadow-[var(--shadow-card)]",
    accent ? "border-brand-dim" : "border-border",
    href && "transition-colors hover:border-border-strong",
  );
  const style = accent
    ? {
        background:
          "radial-gradient(120% 120% at 0% 0%, var(--brand-faint), transparent 60%), var(--card)",
      }
    : undefined;

  if (href) {
    return (
      <Link href={href} className={className} style={style}>
        {body}
      </Link>
    );
  }
  return (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

/**
 * Library overview: one navigable tile per media type — headline count,
 * a 12-month additions sparkline, and size/runtime data rows — plus a
 * totals tile. Replaces both the old stats card and the per-type
 * dashboard tabs.
 */
export function LibraryTiles({
  stats,
  availableTypes,
  serverId,
}: {
  stats: LibraryStats;
  availableTypes: string[];
  serverId?: string;
}) {
  const [sparks, setSparks] = useState<Record<string, number[]>>({});

  const showAll = availableTypes.length === 0;
  const show = {
    movie: showAll || availableTypes.includes("MOVIE"),
    series: showAll || availableTypes.includes("SERIES"),
    music: showAll || availableTypes.includes("MUSIC"),
  };

  useEffect(() => {
    const types: (string | null)[] = [
      ...(show.movie ? ["MOVIE"] : []),
      ...(show.series ? ["SERIES"] : []),
      ...(show.music ? ["MUSIC"] : []),
      null, // totals tile
    ];
    let cancelled = false;

    Promise.all(
      types.map(async (type) => {
        const params = new URLSearchParams({ dateField: "addedAt", bin: "month" });
        if (type) params.set("type", type);
        if (serverId) params.set("serverId", serverId);
        try {
          const res = await fetch(`/api/media/stats/timeline?${params}`);
          if (!res.ok) return [type ?? "ALL", []] as const;
          const data = await res.json();
          const values = ((data.points ?? []) as { total: number }[])
            .slice(-SPARK_MONTHS)
            .map((p) => p.total);
          return [type ?? "ALL", values] as const;
        } catch {
          return [type ?? "ALL", []] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setSparks(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, show.movie, show.series, show.music]);

  const visibleCount = Number(show.movie) + Number(show.series) + Number(show.music) + 1;
  const gridCols =
    visibleCount === 2
      ? "sm:grid-cols-2"
      : visibleCount === 3
        ? "sm:grid-cols-3"
        : "sm:grid-cols-2 lg:grid-cols-4";
  const firstAccent = show.movie ? "movie" : show.series ? "series" : "music";

  return (
    <div className={`grid gap-4 ${gridCols}`}>
      {show.movie && (
        <LibraryTile
          href="/library/movies"
          icon={Film}
          accent={firstAccent === "movie"}
          label="Movies"
          value={stats.movieCount.toLocaleString()}
          spark={sparks.MOVIE}
          rows={[
            { label: "Size", value: formatBytesNum(Number(stats.movieSize)) },
            { label: "Runtime", value: formatDurationLarge(stats.movieDuration) },
          ]}
        />
      )}
      {show.series && (
        <LibraryTile
          href="/library/series"
          icon={Tv}
          accent={firstAccent === "series"}
          label="Series"
          value={stats.seriesCount.toLocaleString()}
          sub={`${stats.seasonCount.toLocaleString()} seasons · ${stats.episodeCount.toLocaleString()} episodes`}
          spark={sparks.SERIES}
          rows={[
            { label: "Size", value: formatBytesNum(Number(stats.seriesSize)) },
            { label: "Runtime", value: formatDurationLarge(stats.seriesDuration) },
          ]}
        />
      )}
      {show.music && (
        <LibraryTile
          href="/library/music"
          icon={Music}
          accent={firstAccent === "music"}
          label="Music"
          value={stats.musicCount.toLocaleString()}
          sub={`${stats.artistCount.toLocaleString()} artists · ${stats.albumCount.toLocaleString()} albums`}
          spark={sparks.MUSIC}
          rows={[
            { label: "Size", value: formatBytesNum(Number(stats.musicSize)) },
            { label: "Runtime", value: formatDurationLarge(stats.musicDuration) },
          ]}
        />
      )}
      <LibraryTile
        icon={HardDrive}
        label="Library size"
        value={formatBytesNum(Number(stats.totalSize))}
        spark={sparks.ALL}
        rows={[
          {
            label: "Runtime",
            value: formatDurationLarge(
              stats.movieDuration + stats.seriesDuration + stats.musicDuration,
            ),
          },
        ]}
      />
    </div>
  );
}
