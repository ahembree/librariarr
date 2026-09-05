/**
 * The progress contract for a watch-history sync.
 *
 * A watch-history sync is the one sync a user deliberately waits on: the
 * History page's **Refresh** button runs it in the foreground, and a first
 * Tracearr import pulls a server's entire history, which on a busy instance
 * takes minutes. Without progress that button is an indefinite spinner.
 *
 * Both provenances report through this one shape so the History page renders a
 * single coherent bar for a mixed set of servers.
 *
 * **Determinacy is deliberate, not incidental.** `fraction` is optional and
 * must be omitted unless a real total is known:
 *
 *  - The native path learns its total the moment `getDetailedWatchHistory()`
 *    returns, so its write loop reports a true `i / total`.
 *  - The Tracearr path never learns one. `/api/v2/public/history` is keyset-
 *    paginated and its `CursorMeta` carries only `nextCursor` and `pageSize` —
 *    there is no count endpoint and no total in the response. A percentage
 *    there would have to be invented, so the import reports an honest
 *    indeterminate bar plus a live count instead. `useStreamProgress` already
 *    distinguishes the two (`determinate: update.fraction !== undefined`).
 */
export interface WatchHistoryProgress {
  /** Rows written so far for this server. */
  imported: number;
  /** Pages fetched so far. Tracearr only — the native path fetches once. */
  pages?: number;
  /**
   * 0..1 sub-progress. Omit entirely when no genuine total exists; never
   * synthesise one from a guess at how much history a server holds.
   */
  fraction?: number;
  /** Human-readable sub-status, shown under the phase label. */
  detail: string;
}

/**
 * Optional progress sink. Every sync entry point takes one and every caller may
 * omit it — the scheduled and realtime job paths have no client to report to,
 * so progress reporting must never be load-bearing for correctness.
 */
export type WatchHistoryProgressReporter = (
  progress: WatchHistoryProgress,
) => void;

/** Locale-aware count for progress detail strings ("1,240 plays"). */
export function formatPlayCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "play" : "plays"}`;
}
