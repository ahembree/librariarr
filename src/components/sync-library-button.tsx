"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

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

export function SyncLibraryButton({ libraryType, onSyncComplete }: { libraryType: "MOVIE" | "SERIES" | "MUSIC"; onSyncComplete?: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onSyncCompleteRef = useRef(onSyncComplete);
  const pollRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    onSyncCompleteRef.current = onSyncComplete;
  }, [onSyncComplete]);

  useEffect(() => {
    mountedRef.current = true;

    pollRef.current = async () => {
      try {
        const res = await fetch("/api/sync/status");
        if (!res.ok) return;
        const data = await res.json();
        const activeJobs = (data.jobs ?? []).filter((j: SyncJob) => j.status === "RUNNING" || j.status === "PENDING");
        if (activeJobs.length === 0) {
          if (mountedRef.current) {
            setSyncing(false);
            setProgress(null);
            onSyncCompleteRef.current?.();
          }
          return;
        }
        if (mountedRef.current) {
          const processed = activeJobs.reduce((sum: number, j: SyncJob) => sum + (j.itemsProcessed || 0), 0);
          const total = activeJobs.reduce((sum: number, j: SyncJob) => sum + (j.totalItems || 0), 0);
          setProgress(total > 0 ? { processed, total } : null);
        }
      } catch {
        // ignore poll errors
      }
      if (mountedRef.current) {
        pollTimer.current = setTimeout(() => pollRef.current?.(), 2000);
      }
    };

    return () => {
      mountedRef.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const startPolling = () => {
    pollTimer.current = setTimeout(() => pollRef.current?.(), 2000);
  };

  const handleSync = async () => {
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
        startPolling();
      } else {
        setSyncing(false);
      }
    } catch {
      setSyncing(false);
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
