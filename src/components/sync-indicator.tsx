"use client";

import { useState, useEffect, useCallback, useRef, memo } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { useFallbackPoll } from "@/hooks/use-fallback-poll";
import { fetchSyncStatus } from "@/lib/sync/sync-status-client";
import { formatRelativeDate, formatSyncEta } from "@/lib/format";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";
import { ServerTypeChip } from "@/components/server-type-chip";
import { latestSyncOutcome } from "@/lib/sync/latest-outcome";
import { activeSyncPerServer } from "@/lib/sync/active-sync";
import { useCountFormat, useDashboardSeed, useRenderNow } from "@/components/dashboard/dashboard-seed";
import { SYNC_STATUS_URL } from "@/lib/dashboard/seed-urls";

interface SyncJob {
  id: string;
  mediaServerId: string;
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
  /**
   * Called after every check that finds a sync running: on each sync event,
   * and on each fallback poll while the event stream is down. The dashboard
   * throttles its live stats refresh on it.
   */
  onSyncActive?: () => void;
  /**
   * Called when a check sees the last running sync end and no event announced
   * it: the fallback poll, which runs only while the event stream is not
   * delivering. An end seen on an event is the page's own `sync:completed`
   * (or `sync:failed`) subscription's to handle, and calling this beside it
   * fetched the stats twice; with the stream down this poll is the only thing
   * that sees the end.
   */
  onSyncComplete?: () => void;
}

const formatTimeAgo = (date: Date, now?: number) => formatRelativeDate(date, { largestUnit: "day", now });

const isActiveJob = (j: SyncJob) => j.status === "RUNNING" || j.status === "PENDING";

function ActiveSyncBar({ job, now }: { job: SyncJob; now?: number }) {
  const progress =
    job.totalItems > 0
      ? Math.round((job.itemsProcessed / job.totalItems) * 100)
      : 0;
  const eta = formatSyncEta(job.startedAt, job.itemsProcessed, job.totalItems, now);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="relative h-9 overflow-hidden rounded-md border border-sky/30 bg-sky/10 text-sm">
            <div className="flex h-full items-center gap-1.5 px-3">
              <Loader2 className="h-4 w-4 animate-spin text-sky" />
              <ServerTypeChip type={job.mediaServer.type} />
              <span className="text-sky">
                {job.status === "PENDING" ? "Queued" : "Syncing"} {job.mediaServer.name}
                {job.totalItems > 0 && ` \u00b7 ${progress}%`}
                {eta && ` \u00b7 ${eta}`}
              </span>
            </div>
            {job.totalItems > 0 && (
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-sky/20">
                <div
                  className="h-full bg-sky transition-all duration-500"
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

export const SyncIndicator = memo(function SyncIndicator({ onSyncActive, onSyncComplete }: SyncIndicatorProps) {
  // On the dashboard's page load the server render read the jobs: the first
  // check is that answer, and is not asked for again.
  const seeded = useDashboardSeed<{ jobs?: SyncJob[] }>(SYNC_STATUS_URL);
  const [seedJobs] = useState(() => (seeded === undefined ? null : (seeded.jobs ?? [])));
  const [jobs, setJobs] = useState<SyncJob[]>(seedJobs ?? []);
  const [hasActiveSync, setHasActiveSync] = useState(() => seedJobs?.some(isActiveJob) ?? false);
  const [initialCheckDone, setInitialCheckDone] = useState(seedJobs !== null);
  const [, setTick] = useState(0);
  const wasActiveRef = useRef(seedJobs?.some(isActiveJob) ?? false);
  const isFirstFetchRef = useRef(seedJobs === null);
  const now = useRenderNow();
  const formatCount = useCountFormat();
  // Read through refs so `fetchStatus` stays stable: it is the realtime
  // subscriptions' callback.
  const onSyncActiveRef = useRef(onSyncActive);
  const onSyncCompleteRef = useRef(onSyncComplete);
  useEffect(() => {
    onSyncActiveRef.current = onSyncActive;
    onSyncCompleteRef.current = onSyncComplete;
  }, [onSyncActive, onSyncComplete]);
  // IDs of jobs seen RUNNING/PENDING on the previous poll. Used to attribute
  // completion/failure toasts to the job that actually just finished — the
  // jobs list also carries historical COMPLETED/FAILED rows (for the idle
  // indicator), so we must not scan the whole list or a stale failure would
  // be re-announced on every successful sync.
  const prevActiveIdsRef = useRef<Set<string>>(
    new Set((seedJobs ?? []).filter(isActiveJob).map((j) => j.id)),
  );

  // `announced`: the check runs on a delivered event (or a reconnect's
  // resync), so the page's own subscriptions saw the same event. Decided by
  // what triggered the check, not by `isRealtimeLive()` when it answers: the
  // stream can drop between the event and the answer.
  const fetchStatus = useCallback(async (announced: boolean) => {
    try {
      const data = await fetchSyncStatus();
      // A failed check keeps what is on screen (background polling).
      if (!data) return;
      const newJobs = (data.jobs ?? []) as unknown as SyncJob[];
      setJobs(newJobs);

      const isActive = newJobs.some(
        (j) => j.status === "RUNNING" || j.status === "PENDING"
      );
      const activeIds = new Set(
        newJobs
          .filter((j) => j.status === "RUNNING" || j.status === "PENDING")
          .map((j) => j.id)
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

      // Announce jobs that were active last poll and have now reached a
      // terminal state. Per-job so multi-server syncs each get attributed,
      // and independent of onSyncComplete so the toast always fires.
      if (!isFirstFetchRef.current) {
        for (const job of newJobs) {
          if (!prevActiveIdsRef.current.has(job.id)) continue;
          if (job.status === "FAILED") {
            toast.error(`Sync failed: ${job.mediaServer.name}`, {
              description: job.error || "Unknown error",
            });
          } else if (job.status === "COMPLETED") {
            toast.success(`Sync complete: ${job.mediaServer.name}`, {
              description: `${job.itemsProcessed.toLocaleString()} items synced`,
            });
          }
        }
      }

      if (wasActiveRef.current && !isActive) {
        if (!announced) onSyncCompleteRef.current?.();
      } else if (isActive) {
        onSyncActiveRef.current?.();
      }

      prevActiveIdsRef.current = activeIds;
      wasActiveRef.current = isActive;
      setHasActiveSync(isActive);
      isFirstFetchRef.current = false;
    } catch {
      // Silently fail — background polling
    } finally {
      setInitialCheckDone(true);
    }
  }, []);

  const onEvent = useCallback(() => void fetchStatus(true), [fetchStatus]);
  const onPoll = useCallback(() => void fetchStatus(false), [fetchStatus]);

  // Instant updates via SSE (supplements polling — if SSE is unavailable, polling still works)
  useRealtime("sync:started", onEvent);
  useRealtime("sync:completed", onEvent);
  useRealtime("sync:failed", onEvent);
  // Progress within a run, so the bar advances on a push instead of a 2s poll.
  useRealtime("sync:progress", onEvent);

  useEffect(() => {
    if (seedJobs !== null) return;
    void (async () => { await fetchStatus(false); })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback poll only — `sync:progress` above is the primary path, and the
  // poll runs only while pushes are not arriving. The active-sync case no
  // longer needs 2s (that existed solely because there was no progress event),
  // but stays quicker than idle so an SSE-down environment still shows a
  // moving bar.
  useFallbackPoll(onPoll, hasActiveSync ? 15000 : 60000, initialCheckDone);

  // Update relative times every minute
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  if (!initialCheckDone) return null;

  const activeJobs = jobs.filter(
    (j) => j.status === "RUNNING" || j.status === "PENDING"
  );
  const outcome = latestSyncOutcome(jobs);
  const recentCompleted = outcome?.status === "COMPLETED" ? outcome.job : undefined;
  const recentFailed = outcome?.status === "FAILED" ? outcome.job : undefined;

  if (activeJobs.length > 0) {
    return (
      <>
        {activeSyncPerServer(activeJobs).map((job) => (
          <ActiveSyncBar key={job.id} job={job} now={now} />
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
              <CheckCircle className="h-4 w-4 text-green" />
              <ServerTypeChip type={recentCompleted.mediaServer.type} />
              <span>
                {formatCount(recentCompleted.itemsProcessed)} items
                {" \u00b7 "}
                {formatTimeAgo(completedAt, now)}
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
            <div className="flex h-9 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 text-sm text-muted-foreground">
              <XCircle className="h-4 w-4 text-destructive" />
              <ServerTypeChip type={recentFailed.mediaServer.type} />
              <span>
                Sync failed
                {failedAt && ` \u00b7 ${formatTimeAgo(failedAt, now)}`}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">{recentFailed.mediaServer.name}</p>
            <p className="text-xs text-destructive">
              {recentFailed.error || "Unknown error"}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return null;
});
