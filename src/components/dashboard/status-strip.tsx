"use client";

import { useEffect, useRef, useState, useCallback, memo } from "react";
import { DeferredPrefetchLink } from "@/components/deferred-prefetch-link";
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
import { fetchSyncStatus } from "@/lib/sync/sync-status-client";
import { fetchJsonShared } from "@/lib/shared-fetch";
import type { ScheduleInfo } from "@/components/dashboard/types";
import { useDashboardSeed, useRenderNow } from "@/components/dashboard/dashboard-seed";
import { SYNC_STATUS_URL } from "@/lib/dashboard/seed-urls";

type Tone = "ok" | "warn" | "err" | "idle";

/** How often the Integrations tile re-checks instance health. */
const HEALTH_POLL_MS = 60_000;

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
    <DeferredPrefetchLink
      href={href}
      className="group flex items-center gap-3 rounded-[14px] border bg-card px-3 py-3 shadow-[var(--shadow-card)] transition-colors hover:border-border-strong hover:bg-surface-2/40 sm:px-4"
    >
      {/* Two tiles share a phone's width; the icon gives its room to the
          text there, and the lines wrap instead of ending in "…". */}
      <span className="hidden h-9 w-9 shrink-0 place-items-center sm:grid rounded-[9px] border border-border bg-surface-2 text-muted-foreground transition-colors group-hover:text-foreground">
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
          <span className="mt-0.5 line-clamp-2 text-[15px] font-semibold tabular-nums break-words sm:block sm:truncate">
            {value}
          </span>
        )}
        {sub && !loading && (
          // title carries the full text when the line truncates
          <span title={sub} className="line-clamp-2 font-mono text-[11px] break-words text-faint sm:block sm:truncate">
            {sub}
          </span>
        )}
      </span>
    </DeferredPrefetchLink>
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

/** The sync tile's state from `GET /api/sync/status`'s jobs. */
function syncStateFrom(data: { jobs?: { status: string; completedAt: string | null }[] } | null): SyncState {
  const jobs = data?.jobs ?? [];
  const active = jobs.some((j) => j.status === "RUNNING" || j.status === "PENDING");
  const lastRun = jobs
    .filter((j) => j.status === "COMPLETED" && j.completedAt)
    .map((j) => j.completedAt!)
    .sort()
    .pop() ?? null;
  return { active, lastRun };
}

/**
 * Operational at-a-glance strip: active streams, sync state, integration
 * health, next scheduled lifecycle runs, and (when present) an available
 * update. Slow data sources (sessions hit the media servers; health hits
 * the Arr instances) load non-blocking behind per-tile skeletons.
 */
export const StatusStrip = memo(function StatusStrip({ scheduleInfo }: { scheduleInfo: ScheduleInfo | null }) {
  // null = loading, "error" = the check itself failed (distinct from clean
  // zero states, which would misreport an outage as "all idle").
  const [sessions, setSessions] = useState<SessionsState | null | "error">(null);
  const [health, setHealth] = useState<HealthState | null | "error">(null);
  // The sync tile's figures come with the server render on a page load.
  const seededSync = useDashboardSeed<Parameters<typeof syncStateFrom>[0]>(SYNC_STATUS_URL);
  const [sync, setSync] = useState<SyncState | null>(() =>
    seededSync === undefined ? null : syncStateFrom(seededSync),
  );
  const syncSeeded = useRef(seededSync !== undefined);
  const now = useRenderNow();
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  const fetchSessions = useCallback(() => {
    // Shared with the sidebar's stream badge, which reads it on the same mount.
    fetchJsonShared<{ sessions?: unknown[]; unreachableServers?: unknown[] }>("/api/tools/sessions")
      .then((data) => {
        if (!data) return setSessions("error");
        setSessions({
          count: (data.sessions ?? []).length,
          unreachable: (data.unreachableServers ?? []).length,
        });
      })
      .catch(() => setSessions("error"));
  }, []);

  const fetchHealth = useCallback(() => {
    // No fresh=1: ride the server-side 30s cache instead of re-probing
    // every Arr instance on each dashboard visit.
    fetch("/api/integrations/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return setHealth("error");
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
      .catch(() => setHealth("error"));
  }, []);

  useEffect(() => {
    fetchSessions();
    fetchHealth();

    // Shared with the sidebar's update dot, which reads it on the same mount.
    fetchJsonShared<{ updateAvailable?: boolean; latestVersion?: string }>("/api/system/update-check", { priority: "low" })
      .then((data) => {
        if (data?.updateAvailable && data.latestVersion) {
          setUpdateVersion(data.latestVersion);
        }
      })
      .catch(() => {});
  }, [fetchSessions, fetchHealth]);

  // The sync tile was wired to all three sync events while the two tiles beside
  // it were one-shot mount fetches — so a stream starting never showed on the
  // dashboard.
  useRealtime("session-changed", fetchSessions);
  useRealtime("server-status", fetchSessions);
  useRealtime("server:changed", fetchHealth);
  // No event announces an Arr/Seerr instance going down, being added or being
  // disabled (`server:changed` covers media servers only), so the tile polls.
  // The route caches for 30s, so this costs at most one probe round a minute.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fetchHealth();
    }, HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [fetchHealth]);

  const fetchSync = () => {
    fetchSyncStatus()
      .then((data) => setSync(syncStateFrom(data)))
      .catch(() => setSync({ active: false, lastRun: null }));
  };

  useEffect(() => {
    if (!syncSeeded.current) fetchSync();
  }, []);
  // All three sync transitions matter: without started/failed the tile
  // can't show "Syncing now" for syncs that begin after mount, and a
  // failed sync would leave it stale.
  useRealtime("sync:started", fetchSync);
  useRealtime("sync:completed", fetchSync);
  useRealtime("sync:failed", fetchSync);

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
          sessions === "error"
            ? "Unavailable"
            : sessions
              ? `${sessions.count} active`
              : "—"
        }
        sub={
          sessions === "error"
            ? "couldn't check sessions"
            : sessions && sessions.unreachable > 0
              ? `${sessions.unreachable} server${sessions.unreachable > 1 ? "s" : ""} unreachable`
              : "watching now"
        }
        tone={
          sessions === "error"
            ? "warn"
            : sessions
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
              ? formatRelativeDate(lastSync, { now })
              : "Never run"
        }
        sub={
          scheduleInfo?.sync.nextRun
            ? `next ${formatUntil(scheduleInfo.sync.nextRun, now)}`
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
          health === "error"
            ? "Unavailable"
            : health
              ? health.configured === 0
                ? "None"
                : `${health.reachable}/${health.configured} reachable`
              : "—"
        }
        sub={
          health === "error"
            ? "couldn't check health"
            : health && health.configured === 0
              ? "connect Sonarr or Radarr"
              : health && health.down.length > 0
                ? `down: ${health.down.join(" · ")}`
                : "Sonarr · Radarr · Seerr"
        }
        tone={
          health === "error"
            ? "warn"
            : health && health.configured > 0
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
        value={`Detection ${formatUntil(nextDetection, now)}`}
        sub={`execution ${formatUntil(nextExecution, now)}`}
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
});
