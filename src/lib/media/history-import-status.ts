/** How the History page reads the Tracearr import status for its import note. Client-safe. */

/** The slice of a status row the History page reads. */
export interface TracearrImportStatus {
  backfillComplete: boolean;
  backfillFraction: number | null;
  /**
   * Whether an import is still owed: `backfillComplete` stays false forever for a
   * disabled server or a mapping with no plays. Absent from an older response.
   */
  pending?: boolean;
}

/** `pending` when the route reports it, else the older `!backfillComplete`. */
export function isImportPending(status: TracearrImportStatus): boolean {
  return typeof status.pending === "boolean" ? status.pending : !status.backfillComplete;
}

/**
 * A backfill fraction as the percentage every import readout shows: floored and
 * capped at 99 until `complete`, so an import never reads "100%" while still running.
 * The epsilon keeps an exact percentage from flooring one short (0.29 × 100 is 28.999…).
 */
export function backfillPercent(fraction: number, complete: boolean): number {
  if (complete) return 100;
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(99, Math.max(0, Math.floor(fraction * 100 + 1e-9)));
}

/**
 * The note's percentage: the least-advanced pending server's, or null when one is
 * unmeasured (unknown, never 0%) or nothing is pending.
 */
export function importBackfillPercent(statuses: readonly TracearrImportStatus[]): number | null {
  const pending = statuses.filter(isImportPending);
  if (pending.length === 0) return null;
  const known = pending
    .map((s) => s.backfillFraction)
    .filter((fraction): fraction is number => fraction !== null && Number.isFinite(fraction));
  if (known.length !== pending.length) return null;
  return backfillPercent(Math.min(...known), false);
}

/**
 * Servers a `POST /api/media/history/sync` result reports as failed (`-1`). An
 * unknown id is shown as-is, so a failure is never hidden.
 */
export function failedSyncServerNames(
  counts: Readonly<Record<string, number>> | undefined,
  servers: readonly { id: string; name: string }[],
): string[] {
  return Object.entries(counts ?? {})
    .filter(([, count]) => count < 0)
    .map(([serverId]) => servers.find((s) => s.id === serverId)?.name ?? serverId);
}
