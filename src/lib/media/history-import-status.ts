/**
 * How the History page reads `GET /api/integrations/tracearr/status` to decide
 * whether to show "Still importing older history" and keep polling. Client-safe
 * and pure so it is unit-tested.
 */

/** The slice of a status row the History page reads. */
export interface TracearrImportStatus {
  backfillComplete: boolean;
  backfillFraction: number | null;
  /**
   * Whether an import is actually still owed. `backfillComplete` alone stays
   * false for a disabled server or a mapping Tracearr holds no plays for, so
   * the note never cleared and the 30s poll ran for the life of the page.
   * Optional: an older response does not carry it.
   */
  pending?: boolean;
}

/** `pending` when the route reports it, else the older `!backfillComplete`. */
export function isImportPending(status: TracearrImportStatus): boolean {
  return typeof status.pending === "boolean" ? status.pending : !status.backfillComplete;
}

/**
 * The note's percentage: the least-advanced pending server's share of its
 * archive's time span, or null when any pending server is unmeasured (null is
 * "unknown", never 0%) or nothing is pending.
 */
export function importBackfillPercent(statuses: readonly TracearrImportStatus[]): number | null {
  const pending = statuses.filter(isImportPending);
  if (pending.length === 0) return null;
  const known = pending
    .map((s) => s.backfillFraction)
    .filter((fraction): fraction is number => fraction !== null);
  return known.length === pending.length ? Math.round(Math.min(...known) * 100) : null;
}

/**
 * Names of the servers a `POST /api/media/history/sync` result reports as
 * failed: the route records `-1` against a server whose sync threw (and leaves
 * a cancelled one out entirely). An unknown id is shown as-is rather than
 * dropped, so a failure is never silently hidden.
 */
export function failedSyncServerNames(
  counts: Readonly<Record<string, number>> | undefined,
  servers: readonly { id: string; name: string }[],
): string[] {
  return Object.entries(counts ?? {})
    .filter(([, count]) => count < 0)
    .map(([serverId]) => servers.find((s) => s.id === serverId)?.name ?? serverId);
}
