"use client";

import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import type { ProgressPhase, ProgressUpdate } from "@/lib/progress/types";

interface ProgressState {
  phases: ProgressPhase[];
  currentKey: string | null;
  /** 0..1 sub-progress within the current phase. */
  fraction: number;
}

const EMPTY: ProgressState = { phases: [], currentKey: null, fraction: 0 };

/**
 * Drives a {@link QueryProgress} bar from an NDJSON progress stream. Feed
 * `handleUpdate` to `consumeProgressStream`; render `<QueryProgress state={state} />`.
 */
export function useStreamProgress() {
  const [state, setState] = useState<ProgressState>(EMPTY);

  const handleUpdate = useCallback((update: ProgressUpdate) => {
    setState((prev) => {
      if (update.type === "plan") {
        return { phases: update.phases, currentKey: null, fraction: 0 };
      }
      return { ...prev, currentKey: update.key, fraction: update.fraction ?? 0 };
    });
  }, []);

  const reset = useCallback(() => setState(EMPTY), []);

  return { state, handleUpdate, reset };
}

function overallFraction({ phases, currentKey, fraction }: ProgressState): number {
  if (phases.length === 0) return 0;
  const idx = currentKey ? phases.findIndex((p) => p.key === currentKey) : 0;
  const safeIdx = idx < 0 ? 0 : idx;
  return Math.min(1, (safeIdx + Math.max(0, Math.min(1, fraction))) / phases.length);
}

/**
 * A thin labeled progress bar showing the active phase and overall completion
 * across a streamed multi-phase request (query execution / rule preview).
 */
export function QueryProgress({
  state,
  className,
}: {
  state: ProgressState;
  className?: string;
}) {
  const { phases, currentKey } = state;
  if (phases.length === 0) return null;

  const idx = currentKey ? phases.findIndex((p) => p.key === currentKey) : -1;
  const current = idx >= 0 ? phases[idx] : null;
  const pct = Math.round(overallFraction(state) * 100);
  const stepLabel = current ? `${idx + 1}/${phases.length}` : `0/${phases.length}`;

  return (
    <div className={cn("w-full max-w-md space-y-1.5", className)} aria-live="polite">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="truncate">{current?.label ?? "Starting…"}</span>
        <span className="tabular-nums">{stepLabel}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
