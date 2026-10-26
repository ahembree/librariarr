"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { isRealtimeLive, useRealtime } from "@/hooks/use-realtime";
import { useFallbackPoll } from "@/hooks/use-fallback-poll";
import { fetchSyncStatus } from "@/lib/sync/sync-status-client";

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

  const checkStatus = useCallback(async () => {
    if (!syncingRef.current) return;
    // Shared with every other reader of `/api/sync/status` on the same event.
    const data = await fetchSyncStatus();
    if (!data || !mountedRef.current || !syncingRef.current) return;
    const jobs = (data.jobs ?? []) as unknown as SyncJob[];
    const activeJobs = jobs.filter((j) => j.status === "RUNNING" || j.status === "PENDING");
    if (activeJobs.length === 0) {
      finish();
      if (!isRealtimeLive()) onSyncCompleteRef.current?.();
      return;
    }
    const processed = activeJobs.reduce((sum, j) => sum + (j.itemsProcessed || 0), 0);
    const total = activeJobs.reduce((sum, j) => sum + (j.totalItems || 0), 0);
    setProgress(total > 0 ? { processed, total } : null);
  }, [finish]);

  // Every sync event may move this run's bar or end it.
  useRealtime("sync:started", checkStatus);
  useRealtime("sync:progress", checkStatus);
  useRealtime("sync:completed", checkStatus);
  useRealtime("sync:failed", checkStatus);
  useFallbackPoll(checkStatus, FALLBACK_POLL_MS, syncing);

  const handleSync = async () => {
    syncingRef.current = true;
    setSyncing(true);
    setProgress(null);
    try {
      const res = await fetch("/api/sync/by-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryType }),
      });
      const data = await res.json();
      if (data.syncedCount > 0) {
        // The route created the PENDING rows before answering, so the first
        // check already sees this run — and a short sync may be over by now.
        void checkStatus();
      } else {
        finish();
      }
    } catch {
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
