"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProgressPhase, ProgressUpdate } from "@/lib/progress/types";

interface ProgressState {
  phases: ProgressPhase[];
  currentKey: string | null;
  /** 0..1 sub-progress within the current phase. */
  fraction: number;
  /** Whether the current phase reports a measurable fraction (vs. indeterminate). */
  determinate: boolean;
  /** Optional sub-status line for the active phase (e.g. "3 / 12 · Dune — …"). */
  detail: string | null;
}

const EMPTY: ProgressState = { phases: [], currentKey: null, fraction: 0, determinate: false, detail: null };

/**
 * Drives a {@link QueryProgress} bar from an NDJSON progress stream. Feed
 * `handleUpdate` to `consumeProgressStream`; render `<QueryProgress state={state} />`.
 */
export function useStreamProgress() {
  const [state, setState] = useState<ProgressState>(EMPTY);

  const handleUpdate = useCallback((update: ProgressUpdate) => {
    setState((prev) => {
      if (update.type === "plan") {
        return { phases: update.phases, currentKey: null, fraction: 0, determinate: false, detail: null };
      }
      return {
        ...prev,
        currentKey: update.key,
        fraction: update.fraction ?? 0,
        determinate: update.fraction !== undefined,
        // A phase event without a detail clears any prior sub-status (e.g. when
        // advancing from the per-item "execute" phase to "finalize").
        detail: update.detail ?? null,
      };
    });
  }, []);

  const reset = useCallback(() => setState(EMPTY), []);

  return { state, handleUpdate, reset };
}

/**
 * A segmented, animated progress bar showing the active phase and overall
 * position across a streamed multi-phase request (query execution / rule
 * preview). Each phase is its own segment: completed segments are filled,
 * the active segment fills to its reported fraction (with a shimmer sweep) or
 * runs an indeterminate slider when the phase has no measurable progress.
 */
export function QueryProgress({
  state,
  className,
}: {
  state: ProgressState;
  className?: string;
}) {
  const { phases, currentKey, fraction, determinate, detail } = state;
  if (phases.length === 0) return null;

  const rawIdx = currentKey ? phases.findIndex((p) => p.key === currentKey) : -1;
  const activeIdx = rawIdx < 0 ? 0 : rawIdx;
  // Before the first phase event arrives, treat the opening segment as
  // indeterminate so the bar never sits dead-still on entry.
  const determinateNow = rawIdx < 0 ? false : determinate;
  const current = phases[activeIdx];
  const overall = Math.min(1, (activeIdx + (determinateNow ? fraction : 0)) / phases.length);

  return (
    <div
      className={cn("w-full space-y-2", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(overall * 100)}
      aria-label={detail ? `${current?.label ?? "Loading"} — ${detail}` : current?.label ?? "Loading"}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground/90">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          <span className="truncate">{current?.label ?? "Starting…"}</span>
        </span>
        <span className="flex shrink-0 items-baseline gap-1.5 text-muted-foreground">
          <span className="text-sm font-medium tabular-nums text-foreground/80">{Math.round(overall * 100)}%</span>
          <span className="text-xs tabular-nums">
            {rawIdx >= 0 ? activeIdx + 1 : 0}<span className="opacity-50">/{phases.length}</span>
          </span>
        </span>
      </div>

      {/* Optional per-item sub-status (e.g. "3 / 12 · Dune — Change Quality Profile"). */}
      {detail && (
        <p className="truncate pl-[1.375rem] text-xs tabular-nums text-muted-foreground">{detail}</p>
      )}

      <div className="flex items-center gap-1.5">
        {phases.map((phase, i) => {
          const isCurrent = i === activeIdx;
          const fill = i < activeIdx ? 1 : isCurrent && determinateNow ? fraction : 0;
          const showShimmer = isCurrent && determinateNow && fraction > 0;
          const showIndeterminate = isCurrent && !determinateNow;
          return (
            <div
              key={phase.key}
              className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted/70"
            >
              <div
                className="absolute inset-y-0 left-0 overflow-hidden rounded-full bg-primary transition-[width] duration-500 ease-out"
                style={{ width: `${fill * 100}%` }}
              >
                {showShimmer && (
                  <div className="absolute inset-0 animate-progress-shimmer bg-gradient-to-r from-transparent via-white/35 to-transparent" />
                )}
              </div>
              {showIndeterminate && (
                <div className="absolute inset-y-0 w-2/5 animate-progress-indeterminate rounded-full bg-primary/80" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
