"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";
import { ServerTypeChip } from "@/components/server-type-chip";

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

interface SyncIndicatorProps {
  onSyncComplete?: () => void;
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

function formatEta(startedAt: string, processed: number, total: number): string | null {
  if (processed <= 0 || total <= 0) return null;
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
  if (elapsed < 5) return null; // too early to estimate
  const rate = processed / elapsed;
  const remaining = Math.ceil((total - processed) / rate);
  if (remaining < 60) return `~${remaining}s left`;
  const mins = Math.ceil(remaining / 60);
  if (mins < 60) return `~${mins}m left`;
  const hrs = Math.floor(mins / 60);
  return `~${hrs}h ${mins % 60}m left`;
}

function ActiveSyncBar({ job }: { job: SyncJob }) {
  const progress =
    job.totalItems > 0
      ? Math.round((job.itemsProcessed / job.totalItems) * 100)
      : 0;
  const eta = formatEta(job.startedAt, job.itemsProcessed, job.totalItems);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="relative h-9 overflow-hidden rounded-md border border-blue-500/30 bg-blue-500/10 text-sm">
            <div className="flex h-full items-center gap-1.5 px-3">
              <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
              <ServerTypeChip type={job.mediaServer.type} />
              <span className="text-blue-300">
                Syncing {job.mediaServer.name}
                {job.totalItems > 0 && ` \u00b7 ${progress}%`}
                {eta && ` \u00b7 ${eta}`}
              </span>
            </div>
            {job.totalItems > 0 && (
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-500/20">
                <div
                  className="h-full bg-blue-400 transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-medium">{job.mediaServer.name}</p>
          {job.currentLibrary && (
            <p className="text-xs">{job.currentLibrary}</p>
          )}
          {job.totalItems > 0 && (
            <p className="text-xs">
              {job.itemsProcessed.toLocaleString()} /{" "}
              {job.totalItems.toLocaleString()} items
            </p>
          )}
          {eta && <p className="text-xs">{eta}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function SyncIndicator({ onSyncComplete }: SyncIndicatorProps) {
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [hasActiveSync, setHasActiveSync] = useState(false);
  const [initialCheckDone, setInitialCheckDone] = useState(false);
  const [, setTick] = useState(0);
  const wasActiveRef = useRef(false);
  const lastStatsRefreshRef = useRef(0);
  const isFirstFetchRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status");
      const data = await res.json();
      const newJobs: SyncJob[] = data.jobs || [];
      setJobs(newJobs);

      const isActive = newJobs.some(
        (j) => j.status === "RUNNING" || j.status === "PENDING"
      );

      // Show toast when sync starts (skip initial load)
      if (!isFirstFetchRef.current && !wasActiveRef.current && isActive) {
        const activeJobsList = newJobs.filter(
          (j) => j.status === "RUNNING" || j.status === "PENDING"
        );
        if (activeJobsList.length > 0) {
          toast("Library sync started", {
            description: `Syncing ${activeJobsList.map((j) => j.mediaServer.name).join(", ")}...`,
          });
        }
      }

      if (onSyncComplete) {
        // Detect transition from active to idle
        if (wasActiveRef.current && !isActive) {
          onSyncComplete();
          lastStatsRefreshRef.current = Date.now();
        }
        // Live-refresh stats every 10s during active sync
        else if (
          isActive &&
          Date.now() - lastStatsRefreshRef.current >= 10000
        ) {
          onSyncComplete();
          lastStatsRefreshRef.current = Date.now();
        }
      }

      wasActiveRef.current = isActive;
      setHasActiveSync(isActive);
      isFirstFetchRef.current = false;
    } catch {
      // Silently fail — background polling
    } finally {
      setInitialCheckDone(true);
    }
  }, [onSyncComplete]);

  // Instant updates via SSE (supplements polling — if SSE is unavailable, polling still works)
  useRealtime("sync:started", fetchStatus);
  useRealtime("sync:completed", fetchStatus);
  useRealtime("sync:failed", fetchStatus);

  useEffect(() => {
    fetchStatus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll: fast when active, slow when idle
  useEffect(() => {
    if (!initialCheckDone) return;
    const interval = setInterval(fetchStatus, hasActiveSync ? 2000 : 30000);
    return () => clearInterval(interval);
  }, [fetchStatus, hasActiveSync, initialCheckDone]);

  // Update relative times every minute
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  if (!initialCheckDone) return null;

  const activeJobs = jobs.filter(
    (j) => j.status === "RUNNING" || j.status === "PENDING"
  );
  const recentCompleted = jobs.find((j) => j.status === "COMPLETED");
  const recentFailed = jobs.find((j) => j.status === "FAILED");

  if (activeJobs.length > 0) {
    return (
      <>
        {activeJobs.map((job) => (
          <ActiveSyncBar key={job.id} job={job} />
        ))}
      </>
    );
  }

  if (recentCompleted) {
    const completedAt = new Date(recentCompleted.completedAt!);
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm text-muted-foreground">
              <CheckCircle className="h-4 w-4 text-green-400" />
              <ServerTypeChip type={recentCompleted.mediaServer.type} />
              <span>
                {recentCompleted.itemsProcessed.toLocaleString()} items
                {" \u00b7 "}
                {formatTimeAgo(completedAt)}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">{recentCompleted.mediaServer.name}</p>
            <p className="text-xs">
              {recentCompleted.itemsProcessed.toLocaleString()} items synced
            </p>
            <p className="text-xs">{formatTimeAgo(completedAt)}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (recentFailed) {
    const failedAt = recentFailed.completedAt
      ? new Date(recentFailed.completedAt)
      : null;
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex h-9 items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 text-sm text-muted-foreground">
              <XCircle className="h-4 w-4 text-red-400" />
              <ServerTypeChip type={recentFailed.mediaServer.type} />
              <span>
                Sync failed
                {failedAt && ` \u00b7 ${formatTimeAgo(failedAt)}`}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">{recentFailed.mediaServer.name}</p>
            <p className="text-xs text-red-400">
              {recentFailed.error || "Unknown error"}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return null;
}
