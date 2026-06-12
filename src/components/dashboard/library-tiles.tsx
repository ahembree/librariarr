"use client";

import { useEffect, useId, useState, useRef } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, Film, HardDrive, Music, Tv } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytesNum, formatDurationLarge } from "@/lib/format";

interface SparkPoint {
  /** Month bucket label from the timeline API ("YYYY-MM"). */
  date: string;
  total: number;
}

/** "2026-03" → "Mar 2026" for the hover tooltip. */
function formatMonth(bucket: string): string {
  const [y, m] = bucket.split("-").map(Number);
  if (!y || !m) return bucket;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

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

/** Per-month sparkline (area + line, brand-tinted). Hovering snaps a
 *  cursor line + dot to the nearest month and shows a tooltip with the
 *  month and that point's value (formatted via formatValue). */
function Sparkline({
  points,
  formatValue = (n: number) => `${n.toLocaleString()} added`,
}: {
  points: SparkPoint[];
  formatValue?: (n: number) => string;
}) {
  const gradientId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const W = 100;
  const H = 28;
  const PAD = 2;

  if (points.length < 2) {
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

  // Guard against all-zero months: keep a flat baseline that still hovers.
  const max = Math.max(...points.map((p) => p.total), 1);
  const stepX = W / (points.length - 1);
  const coords = points.map((p, i) => ({
    x: i * stepX,
    y: H - PAD - (p.total / max) * (H - PAD * 2),
  }));
  const line = coords.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  const handlePointerMove = (e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(
      points.length - 1,
      Math.max(0, Math.round(frac * (points.length - 1))),
    );
    setHoverIdx(idx);
  };

  // Guard the index against the points array shrinking while hovered
  // (e.g. a server-filter refetch swapping in shorter history mid-hover).
  const hover =
    hoverIdx !== null && hoverIdx < points.length
      ? { point: points[hoverIdx], coord: coords[hoverIdx] }
      : null;
  const xPct = hover ? (hover.coord.x / W) * 100 : 0;
  const yPct = hover ? (hover.coord.y / H) * 100 : 0;
  // Keep the tooltip inside the tile (which clips overflow) near the edges.
  const tooltipPct = Math.min(80, Math.max(20, xPct));

  return (
    <div
      ref={containerRef}
      className="relative h-9 w-full"
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoverIdx(null)}
      aria-hidden
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-full w-full"
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
      {/* Hover cursor: vertical line + dot on the curve + tooltip. Rendered
          as HTML overlays — the SVG is stretched (preserveAspectRatio none),
          so an SVG circle would distort into an ellipse. */}
      {hover && (
        <>
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-border-strong"
            style={{ left: `${xPct}%` }}
          />
          <div
            className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-bright ring-2 ring-card"
            style={{ left: `${xPct}%`, top: `${yPct}%` }}
          />
          <div
            className="pointer-events-none absolute bottom-full z-10 mb-1.5 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 font-mono text-[10px] leading-tight whitespace-nowrap shadow-[var(--shadow-pop)]"
            style={{ left: `${tooltipPct}%` }}
          >
            <span className="text-faint">{formatMonth(hover.point.date)}</span>
            <span className="mx-1 text-faint">·</span>
            <span className="font-medium text-foreground">
              {formatValue(hover.point.total)}
            </span>
          </div>
        </>
      )}
    </div>
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
  sparkCaption = `Added · last ${SPARK_MONTHS}mo`,
  sparkFormatValue,
}: {
  href?: string;
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  rows: { label: string; value: string }[];
  spark?: SparkPoint[];
  sparkCaption?: string;
  sparkFormatValue?: (n: number) => string;
}) {
  const body = (
    <>
      <div className="mb-3.5 flex items-center justify-between">
        <span className="grid h-[34px] w-[34px] place-items-center rounded-[9px] border border-transparent bg-brand-dim text-brand-bright">
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
      <div className="mt-1 font-mono text-[11.5px] text-faint">{sub ?? "\u00A0"}</div>
      {spark && (
        <div className="mt-3">
          <Sparkline points={spark} formatValue={sparkFormatValue} />
          <div className="mt-1 font-mono text-[10px] tracking-[0.08em] text-faint uppercase">
            {sparkCaption}
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
    "group relative flex h-full flex-col overflow-hidden rounded-[14px] border border-border bg-card px-[18px] pt-[17px] pb-4 shadow-[var(--shadow-card)]",
    href && "transition-colors hover:border-border-strong",
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
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
  const [sparks, setSparks] = useState<Record<string, SparkPoint[]>>({});

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
        if (type) {
          params.set("type", type);
        } else {
          // Totals tile charts library size over time: per-month byte sums,
          // accumulated below so each point is the size at that month.
          params.set("measure", "size");
        }
        if (serverId) params.set("serverId", serverId);
        try {
          const res = await fetch(`/api/media/stats/timeline?${params}`);
          if (!res.ok) return [type ?? "ALL", []] as const;
          const data = await res.json();
          let points = ((data.points ?? []) as SparkPoint[])
            .map((p) => ({ date: p.date, total: p.total }));
          if (!type) {
            // Running sum over the FULL history before slicing, so the
            // window starts from the true size at its first month and the
            // last point matches the tile's headline total.
            let cum = 0;
            points = points.map((p) => ({ date: p.date, total: (cum += p.total) }));
          }
          return [type ?? "ALL", points.slice(-SPARK_MONTHS)] as const;
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

  return (
    <div className={`grid gap-4 ${gridCols}`}>
      {show.movie && (
        <LibraryTile
          href="/library/movies"
          icon={Film}
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
        sparkCaption={`Size · last ${SPARK_MONTHS}mo`}
        sparkFormatValue={formatBytesNum}
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
