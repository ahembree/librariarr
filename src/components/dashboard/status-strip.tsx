"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpCircle,
  CalendarClock,
  PlugZap,
  Play,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeDate, formatUntil } from "@/lib/format";
import { useRealtime } from "@/hooks/use-realtime";
import type { ScheduleInfo } from "@/components/dashboard/types";

type Tone = "ok" | "warn" | "err" | "idle";

const DOT_CLASS: Record<Tone, string> = {
  ok: "bg-green shadow-[0_0_8px_var(--green)]",
  warn: "bg-amber shadow-[0_0_8px_var(--amber)]",
  err: "bg-red shadow-[0_0_8px_var(--red)]",
  idle: "bg-faint",
};

function StatusTile({
  href,
  icon: Icon,
  label,
  value,
  sub,
  tone,
  loading = false,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  loading?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-[14px] border bg-card px-4 py-3 shadow-[var(--shadow-card)] transition-colors hover:border-border-strong hover:bg-surface-2/40"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-border bg-surface-2 text-muted-foreground transition-colors group-hover:text-foreground">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="eyebrow">{label}</span>
          {tone && !loading && (
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[tone])} />
          )}
        </span>
        {loading ? (
          <Skeleton className="mt-1.5 h-4 w-20" />
        ) : (
          <span className="mt-0.5 block truncate text-[15px] font-semibold tabular-nums">
            {value}
          </span>
        )}
        {sub && !loading && (
          // title carries the full text when the line truncates
          <span title={sub} className="block truncate font-mono text-[11px] text-faint">
            {sub}
          </span>
        )}
      </span>
    </Link>
  );
}

interface SessionsState {
  count: number;
  unreachable: number;
}

interface HealthState {
  configured: number;
  reachable: number;
  /** Names of unreachable instances, for the tile sub-line. */
  down: string[];
}

interface SyncState {
  active: boolean;
  lastRun: string | null;
}

/**
 * Operational at-a-glance strip: active streams, sync state, integration
 * health, next scheduled lifecycle runs, and (when present) an available
 * update. Slow data sources (sessions hit the media servers; health hits
 * the Arr instances) load non-blocking behind per-tile skeletons.
 */
export function StatusStrip({ scheduleInfo }: { scheduleInfo: ScheduleInfo | null }) {
  const [sessions, setSessions] = useState<SessionsState | null>(null);
  const [health, setHealth] = useState<HealthState | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tools/sessions")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return setSessions({ count: 0, unreachable: 0 });
        setSessions({
          count: (data.sessions ?? []).length,
          unreachable: (data.unreachableServers ?? []).length,
        });
      })
      .catch(() => setSessions({ count: 0, unreachable: 0 }));

    // No fresh=1: ride the server-side 30s cache instead of re-probing
    // every Arr instance on each dashboard visit.
    fetch("/api/integrations/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return setHealth({ configured: 0, reachable: 0, down: [] });
        const types = [data.sonarr, data.radarr, data.lidarr, data.seerr];
        setHealth({
          configured: types.reduce((a, t) => a + (t?.configured ?? 0), 0),
          reachable: types.reduce((a, t) => a + (t?.reachable ?? 0), 0),
          down: types.flatMap(
            (t) =>
              (t?.instances ?? [])
                .filter((i: { reachable: boolean }) => !i.reachable)
                .map((i: { name: string }) => i.name) as string[],
          ),
        });
      })
      .catch(() => setHealth({ configured: 0, reachable: 0, down: [] }));

    fetch("/api/system/update-check")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.updateAvailable && data.latestVersion) {
          setUpdateVersion(data.latestVersion);
        }
      })
      .catch(() => {});
  }, []);

  const fetchSync = () => {
    fetch("/api/sync/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const jobs: { status: string; completedAt: string | null }[] = data?.jobs ?? [];
        const active = jobs.some((j) => j.status === "RUNNING" || j.status === "PENDING");
        const lastRun = jobs
          .filter((j) => j.status === "COMPLETED" && j.completedAt)
          .map((j) => j.completedAt!)
          .sort()
          .pop() ?? null;
        setSync({ active, lastRun });
      })
      .catch(() => setSync({ active: false, lastRun: null }));
  };

  useEffect(fetchSync, []);
  useRealtime("sync:completed", fetchSync);

  const lastSync = sync?.lastRun ?? scheduleInfo?.sync.lastRun ?? null;
  const nextDetection = scheduleInfo?.detection.nextRun ?? null;
  const nextExecution = scheduleInfo?.execution.nextRun ?? null;

  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2 sm:gap-3",
        updateVersion ? "lg:grid-cols-5" : "lg:grid-cols-4",
      )}
    >
      <StatusTile
        href="/tools/streams"
        icon={Play}
        label="Streams"
        loading={sessions === null}
        value={
          sessions
            ? `${sessions.count} active`
            : "—"
        }
        sub={
          sessions && sessions.unreachable > 0
            ? `${sessions.unreachable} server${sessions.unreachable > 1 ? "s" : ""} unreachable`
            : "watching now"
        }
        tone={
          sessions
            ? sessions.unreachable > 0
              ? "err"
              : sessions.count > 0
                ? "ok"
                : "idle"
            : undefined
        }
      />
      <StatusTile
        href="/settings#scheduling"
        icon={RefreshCw}
        label="Sync"
        loading={sync === null}
        value={
          sync?.active
            ? "Syncing now"
            : lastSync
              ? formatRelativeDate(lastSync)
              : "Never run"
        }
        sub={
          scheduleInfo?.sync.nextRun
            ? `next ${formatUntil(scheduleInfo.sync.nextRun)}`
            : "manual only"
        }
        tone={sync?.active ? "ok" : "idle"}
      />
      <StatusTile
        href="/settings#integrations"
        icon={PlugZap}
        label="Integrations"
        loading={health === null}
        value={
          health
            ? health.configured === 0
              ? "None"
              : `${health.reachable}/${health.configured} reachable`
            : "—"
        }
        sub={
          health?.configured === 0
            ? "connect Sonarr or Radarr"
            : health && health.down.length > 0
              ? `down: ${health.down.join(" · ")}`
              : "Sonarr · Radarr · Seerr"
        }
        tone={
          health && health.configured > 0
            ? health.reachable === health.configured
              ? "ok"
              : health.reachable === 0
                ? "err"
                : "warn"
            : "idle"
        }
      />
      <StatusTile
        href="/settings#scheduling"
        icon={CalendarClock}
        label="Next runs"
        loading={scheduleInfo === null}
        value={`Detection ${formatUntil(nextDetection)}`}
        sub={`execution ${formatUntil(nextExecution)}`}
        tone="idle"
      />
      {updateVersion && (
        <StatusTile
          href="/settings#system"
          icon={ArrowUpCircle}
          label="Update"
          value={`v${updateVersion}`}
          sub="ready to install"
          tone="warn"
        />
      )}
    </div>
  );
}
