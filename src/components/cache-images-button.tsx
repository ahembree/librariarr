"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ImageDown } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface CacheJob {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  totalItems: number;
  processedItems: number;
  cachedImages: number;
  skippedImages: number;
  failedImages: number;
}

export function CacheImagesButton({
  libraryType,
}: {
  libraryType: "MOVIE" | "SERIES" | "MUSIC";
}) {
  const [running, setRunning] = useState(false);
  const [job, setJob] = useState<CacheJob | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const pollRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;

    pollRef.current = async () => {
      try {
        const res = await fetch(
          `/api/media/cache-images?libraryType=${libraryType}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        const j = data.job as CacheJob | null;

        if (!mountedRef.current) return;

        if (!j || j.status !== "RUNNING") {
          setRunning(false);
          setJob(j);
          return;
        }

        setJob(j);
      } catch {
        // ignore poll errors
      }
      if (mountedRef.current) {
        pollTimer.current = setTimeout(() => pollRef.current?.(), 1500);
      }
    };

    return () => {
      mountedRef.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [libraryType]);

  const startPolling = () => {
    pollTimer.current = setTimeout(() => pollRef.current?.(), 1500);
  };

  const handleCache = async () => {
    setRunning(true);
    setJob(null);
    try {
      const res = await fetch("/api/media/cache-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryType }),
      });
      if (res.ok) {
        startPolling();
      } else {
        setRunning(false);
      }
    } catch {
      setRunning(false);
    }
  };

  const pct =
    job && job.totalItems > 0
      ? Math.round((job.processedItems / job.totalItems) * 100)
      : 0;

  const label =
    libraryType === "MOVIE"
      ? "Movies"
      : libraryType === "SERIES"
        ? "Series"
        : "Music";

  return (
    <div className="relative inline-flex flex-col items-center gap-1">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={handleCache}
              disabled={running}
              title={`Cache all ${label} images`}
            >
              <ImageDown
                className={`h-3.5 w-3.5 ${running ? "animate-pulse" : ""}`}
              />
              {running && job ? `${pct}%` : "Cache Images"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Download and cache all images for {label.toLowerCase()}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {running && (
        <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
            style={{ width: job ? `${pct}%` : "0%" }}
          />
        </div>
      )}
    </div>
  );
}
