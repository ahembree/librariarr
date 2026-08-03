"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AiEvidence } from "@/lib/ai/types";

const GRID = "rgba(255,255,255,0.07)";
const AXIS = "rgba(255,255,255,0.45)";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card/40 p-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function BarList({ rows }: { rows: { label: string; value: number; sub?: string }[] }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No data.</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3 text-[13px]">
          <div className="w-36 shrink-0 truncate sm:w-44" title={r.label}>
            {r.label}
          </div>
          <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-muted">
            <div
              className="absolute inset-y-0 left-0 rounded"
              style={{ width: `${(r.value / max) * 100}%`, backgroundColor: "var(--primary)" }}
            />
          </div>
          <div className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
            {r.value.toLocaleString()}
            {r.sub ? ` ${r.sub}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatTiles({ tiles }: { tiles: { label: string; value: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((t, i) => (
        <div key={i} className="rounded-md border bg-background/40 px-3 py-2">
          <div className="text-[11px] text-muted-foreground">{t.label}</div>
          <div className="font-display text-lg font-semibold tabular-nums">{t.value}</div>
        </div>
      ))}
    </div>
  );
}

type Row = Record<string, unknown>;

export function EvidenceCard({ evidence }: { evidence: AiEvidence }) {
  const d = evidence.data as Row;

  switch (evidence.kind) {
    case "overview": {
      const counts = (d.counts ?? {}) as Record<string, number>;
      const storage = (d.storageGB ?? {}) as Record<string, number>;
      const genres = (d.topGenres ?? []) as { value: string; count: number }[];
      const res = (d.topResolutions ?? []) as { value: string; count: number }[];
      return (
        <Card title={evidence.title}>
          <div className="space-y-3">
            <StatTiles
              tiles={[
                { label: "Movies", value: (counts.movies ?? 0).toLocaleString() },
                { label: "Series", value: (counts.series ?? 0).toLocaleString() },
                { label: "Tracks", value: (counts.tracks ?? 0).toLocaleString() },
                { label: "Total size", value: `${(storage.total ?? 0).toLocaleString()} GB` },
              ]}
            />
            {res.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] text-muted-foreground">Top resolutions</div>
                <BarList rows={res.slice(0, 6).map((r) => ({ label: r.value ?? "Unknown", value: r.count }))} />
              </div>
            )}
            {genres.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] text-muted-foreground">Top genres</div>
                <BarList rows={genres.slice(0, 8).map((r) => ({ label: r.value ?? "Unknown", value: r.count }))} />
              </div>
            )}
          </div>
        </Card>
      );
    }

    case "breakdown": {
      const rows = (d.rows ?? []) as { value: string; count: number }[];
      return (
        <Card title={evidence.title}>
          <BarList rows={rows.slice(0, 15).map((r) => ({ label: r.value ?? "Unknown", value: r.count }))} />
        </Card>
      );
    }

    case "cross_tab": {
      const rows = (d.rows ?? []) as { dim1: string; dim2: string; count: number }[];
      return (
        <Card title={evidence.title}>
          <BarList
            rows={rows.slice(0, 15).map((r) => ({ label: `${r.dim1} · ${r.dim2}`, value: r.count }))}
          />
        </Card>
      );
    }

    case "watch_trends": {
      const rows = (d.rows ?? []) as { title: string; plays: number; users: number }[];
      return (
        <Card title={evidence.title}>
          <BarList
            rows={rows.slice(0, 15).map((r) => ({
              label: r.title ?? "Unknown",
              value: r.plays,
              sub: `plays · ${r.users}👤`,
            }))}
          />
        </Card>
      );
    }

    case "watch_leaderboard": {
      const rows = (d.rows ?? []) as { key: string; plays: number; items: number }[];
      return (
        <Card title={evidence.title}>
          <BarList
            rows={rows.slice(0, 15).map((r) => ({
              label: r.key ?? "Unknown",
              value: r.plays,
              sub: `plays · ${r.items} items`,
            }))}
          />
        </Card>
      );
    }

    case "timeline": {
      const points = (d.points ?? []) as { date: string; total: number }[];
      if (points.length === 0) {
        return (
          <Card title={evidence.title}>
            <p className="text-xs text-muted-foreground">No data in range.</p>
          </Card>
        );
      }
      return (
        <Card title={evidence.title}>
          <div style={{ color: "var(--primary)" }}>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: AXIS }} minTickGap={28} />
                <YAxis tick={{ fontSize: 10, fill: AXIS }} width={40} />
                <Tooltip
                  contentStyle={{
                    background: "#0c0d10",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#fff" }}
                />
                <Area type="monotone" dataKey="total" stroke="currentColor" fill="currentColor" fillOpacity={0.18} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      );
    }

    case "search": {
      const items = (d.items ?? []) as Row[];
      if (items.length === 0) {
        return (
          <Card title={evidence.title}>
            <p className="text-xs text-muted-foreground">No matching items.</p>
          </Card>
        );
      }
      return (
        <Card title={`${evidence.title}${d.hasMore ? " (showing first results)" : ""}`}>
          <div className="max-h-72 overflow-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 bg-card">
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Title</th>
                  <th className="px-2 py-1 font-medium">Type</th>
                  <th className="px-2 py-1 font-medium">Year</th>
                  <th className="px-2 py-1 font-medium">Res</th>
                  <th className="px-2 py-1 text-right font-medium">GB</th>
                  <th className="px-2 py-1 text-right font-medium">Plays</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, 30).map((it, i) => (
                  <tr key={i} className="border-t border-border/50">
                    <td className="max-w-[220px] truncate px-2 py-1" title={String(it.title ?? "")}>
                      {String(it.parentTitle ? `${it.parentTitle} — ` : "")}
                      {String(it.title ?? "")}
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{String(it.type ?? "")}</td>
                    <td className="px-2 py-1 text-muted-foreground">{it.year != null ? String(it.year) : ""}</td>
                    <td className="px-2 py-1 text-muted-foreground">{it.resolution != null ? String(it.resolution) : ""}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                      {it.sizeGB != null ? String(it.sizeGB) : ""}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                      {it.playCount != null ? String(it.playCount) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      );
    }

    default:
      return null;
  }
}
