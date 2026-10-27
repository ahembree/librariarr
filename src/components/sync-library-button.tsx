"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { isRealtimeLive, useRealtime } from "@/hooks/use-realtime";
import { useFallbackPoll } from "@/hooks/use-fallback-poll";
import { fetchSyncStatus } from "@/lib/sync/sync-status-client";
import { clearLibraryListCache } from "@/lib/media/list-cache";
import { dropMediaDerivedPrefetches } from "@/lib/media/detail-prefetch";

const TYPE_LABELS: Record<string, string> = {
  MOVIE: "Movies",
  SERIES: "Series",
  MUSIC: "Music",
};

interface SyncJob {
  status: string;
  itemsProcessed: number;
  totalItems: number;
}

// Only while pushes are not arriving: `sync:progress` (throttled 2s per
// server) drives the bar otherwise.
const FALLBACK_POLL_MS = 5000;

/**
 * Sync every library of one type, with the run's progress on the button.
 *
 * `onSyncComplete` runs when the sync finishes while the event stream is NOT
 * delivering: the pages that pass it also refetch on `sync:completed`, so
 * calling it beside a delivered event fetched the whole list twice. With the
 * stream down, the button's own check is the only thing that sees the end.
 */
export function SyncLibraryButton({ libraryType, onSyncComplete }: { libraryType: "MOVIE" | "SERIES" | "MUSIC"; onSyncComplete?: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const syncingRef = useRef(false);
  // While the sync request is unanswered its rows may not exist yet, so a
  // check run on another server's sync event would read "nothing active" and
  // end this run before it started.
  const requestingRef = useRef(false);
  const mountedRef = useRef(true);
  const onSyncCompleteRef = useRef(onSyncComplete);

  useEffect(() => {
    onSyncCompleteRef.current = onSyncComplete;
  }, [onSyncComplete]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const finish = useCallback(() => {
    syncingRef.current = false;
    setSyncing(false);
    setProgress(null);
  }, []);

  // `announced`: whether the page saw the run's end on the stream. A check
  // run on a sync event (or a reconnect's resync, which calls the same
  // subscribers) shares that event with the page's own `sync:completed`
  // subscription, which refetches. Decided by what triggered the check, not by
  // `isRealtimeLive()` when it answers: the stream can drop between the event
  // and the answer, and the list was then fetched twice.
  const checkStatus = useCallback(async (announced: boolean) => {
    if (!syncingRef.current || requestingRef.current) return;
    // Shared with every other reader of `/api/sync/status` on the same event.
    const data = await fetchSyncStatus();
    if (!data || !mountedRef.current || !syncingRef.current) return;
    const jobs = (data.jobs ?? []) as unknown as SyncJob[];
    const activeJobs = jobs.filter((j) => j.status === "RUNNING" || j.status === "PENDING");
    if (activeJobs.length === 0) {
      finish();
      if (!announced) {
        // No event dropped the tab's cached lists for this sync's end (the
        // shell does that for a delivered one), and the page's refetch would
        // otherwise be answered from them.
        clearLibraryListCache();
        dropMediaDerivedPrefetches();
        onSyncCompleteRef.current?.();
      }
      return;
    }
    const processed = activeJobs.reduce((sum, j) => sum + (j.itemsProcessed || 0), 0);
    const total = activeJobs.reduce((sum, j) => sum + (j.totalItems || 0), 0);
    setProgress(total > 0 ? { processed, total } : null);
  }, [finish]);

  const onEvent = useCallback(() => void checkStatus(true), [checkStatus]);
  // A poll runs only while no pushes arrive, so the page saw nothing.
  const onPoll = useCallback(() => void checkStatus(false), [checkStatus]);

  // Every sync event may move this run's bar or end it.
  useRealtime("sync:started", onEvent);
  useRealtime("sync:progress", onEvent);
  useRealtime("sync:completed", onEvent);
  useRealtime("sync:failed", onEvent);
  useFallbackPoll(onPoll, FALLBACK_POLL_MS, syncing);

  const handleSync = async () => {
    syncingRef.current = true;
    requestingRef.current = true;
    setSyncing(true);
    setProgress(null);
    try {
      const res = await fetch("/api/sync/by-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryType }),
      });
      const data = await res.json();
      requestingRef.current = false;
      if (data.syncedCount > 0) {
        // The route created the PENDING rows before answering, so the first
        // check already sees this run — and a short sync may be over by now.
        // No event triggered this check: a run already over sent its
        // `sync:completed` before it, which the page received if pushes are
        // arriving.
        void checkStatus(isRealtimeLive());
      } else {
        finish();
      }
    } catch {
      requestingRef.current = false;
      finish();
    }
  };

  const label = TYPE_LABELS[libraryType] || libraryType;
  const pct = progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div className="relative inline-flex flex-col items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs"
        onClick={handleSync}
        disabled={syncing}
        title={`Sync ${label}`}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
        {syncing && progress ? `${pct}%` : "Sync"}
      </Button>
      {syncing && (
        <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
            style={{ width: progress ? `${pct}%` : "0%" }}
          />
        </div>
      )}
    </div>
  );
}
