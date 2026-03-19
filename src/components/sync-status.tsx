"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Database,
} from "lucide-react";
import {
  SERVER_TYPE_STYLES,
  DEFAULT_SERVER_STYLE,
} from "@/lib/server-styles";

interface SyncJob {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  itemsProcessed: number;
  totalItems: number;
  currentLibrary: string | null;
  mediaServer: { name: string; type: string };
}

function ServerTypeChip({ type }: { type: string }) {
  const style = SERVER_TYPE_STYLES[type] ?? DEFAULT_SERVER_STYLE;
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none border ${style.classes}`}>
      {style.label}
    </span>
  );
}

interface SyncStatusProps {
  onSyncComplete?: () => void;
}

export function SyncStatus({ onSyncComplete }: SyncStatusProps) {
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [hasActiveSync, setHasActiveSync] = useState(false);
  const [initialCheckDone, setInitialCheckDone] = useState(false);
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasActiveRef = useRef(false);
  const lastStatsRefreshRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status");
      const data = await res.json();
      const newJobs: SyncJob[] = data.jobs || [];
      setJobs(newJobs);

      const isActive = newJobs.some(
        (j) => j.status === "RUNNING" || j.status === "PENDING"
      );

      if (onSyncComplete) {
        // Detect transition from active to idle
        if (wasActiveRef.current && !isActive) {
          onSyncComplete();
          lastStatsRefreshRef.current = Date.now();
        }
        // Live-refresh stats every 10s during active sync
        else if (isActive && Date.now() - lastStatsRefreshRef.current >= 10000) {
          onSyncComplete();
          lastStatsRefreshRef.current = Date.now();
        }
      }

      wasActiveRef.current = isActive;
      setHasActiveSync(isActive);

      if (!isActive && newJobs.length > 0) {
        // No active sync but there are recent jobs — show briefly then hide
        if (!hideTimerRef.current) {
          hideTimerRef.current = setTimeout(() => {
            setVisible(false);
            hideTimerRef.current = null;
          }, 30000);
        }
      } else if (isActive) {
        // Active sync — stay visible and cancel any hide timer
        setVisible(true);
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
      }
    } catch {
      // Silently fail - this is background polling
    } finally {
      setInitialCheckDone(true);
    }
  }, [onSyncComplete]);

  // Initial fetch on mount
  useEffect(() => {
    fetchStatus();
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll only when there's an active sync
  useEffect(() => {
    if (!initialCheckDone || !hasActiveSync) return;

    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, [fetchStatus, hasActiveSync, initialCheckDone]);

  if (!initialCheckDone) return null;
  if (jobs.length === 0) return null;
  if (!visible) return null;

  const activeJobs = jobs.filter(
    (j) => j.status === "RUNNING" || j.status === "PENDING"
  );
  const recentJobs = jobs.filter(
    (j) => j.status === "COMPLETED" || j.status === "FAILED"
  );

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4" />
          Library Sync
          {activeJobs.length > 0 && (
            <Badge
              variant="secondary"
              className="bg-blue-500/20 text-blue-400"
            >
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Syncing
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-auto space-y-3">
        {activeJobs.map((job) => (
          <ActiveSyncJob key={job.id} job={job} />
        ))}
        {recentJobs.map((job) => (
          <RecentSyncJob key={job.id} job={job} />
        ))}
      </CardContent>
    </Card>
  );
}

function ActiveSyncJob({ job }: { job: SyncJob }) {
  const progress =
    job.totalItems > 0
      ? Math.round((job.itemsProcessed / job.totalItems) * 100)
      : 0;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = Math.round(
    (now - new Date(job.startedAt).getTime()) / 1000
  );
  const elapsedStr =
    elapsed < 60
      ? `${elapsed}s`
      : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-400" />
          <ServerTypeChip type={job.mediaServer.type} />
          <span className="font-medium">{job.mediaServer.name}</span>
        </div>
        <span className="text-xs text-muted-foreground">{elapsedStr}</span>
      </div>

      {/* Progress bar */}
      {job.totalItems > 0 && (
        <div className="mt-2">
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>
              {job.currentLibrary && (
                <span className="text-foreground">{job.currentLibrary}</span>
              )}
            </span>
            <span>
              {job.itemsProcessed.toLocaleString()} /{" "}
              {job.totalItems.toLocaleString()} ({progress}%)
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Still fetching libraries */}
      {job.totalItems === 0 && job.currentLibrary && (
        <p className="mt-1 text-xs text-muted-foreground">
          {job.currentLibrary}
        </p>
      )}
    </div>
  );
}

function RecentSyncJob({ job }: { job: SyncJob }) {
  const completedAt = job.completedAt
    ? new Date(job.completedAt)
    : null;
  const ago = completedAt ? formatTimeAgo(completedAt) : "";

  return (
    <div className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        {job.status === "COMPLETED" ? (
          <CheckCircle className="h-3.5 w-3.5 text-green-400" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-red-400" />
        )}
        <ServerTypeChip type={job.mediaServer.type} />
        <span className="text-muted-foreground">
          {job.mediaServer.name}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {job.status === "COMPLETED" && (
          <span>{job.itemsProcessed.toLocaleString()} items</span>
        )}
        {job.status === "FAILED" && (
          <span className="text-red-400 max-w-[200px] truncate">
            {job.error}
          </span>
        )}
        {ago && <span>{ago}</span>}
      </div>
    </div>
  );
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
