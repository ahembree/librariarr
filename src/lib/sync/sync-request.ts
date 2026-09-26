/**
 * A manual sync the settings page asked for, tracked until its own run ends.
 *
 * Client-safe: no server imports.
 */
export interface PendingSyncRequest {
  /** Per-page sequence number, so a stale timer or error handler can only
   * ever end the request that armed it. */
  id: number;
  serverId: string;
  /**
   * When the sync route enqueued the job (server clock, ISO). `null` while the
   * POST is still in flight — nothing can be matched to the request yet.
   */
  requestedAt: string | null;
}

interface SyncJobLike {
  status: string;
  startedAt: string;
}

interface ServerLike {
  id: string;
  syncJobs: SyncJobLike[];
}

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * Has the run this request started reached a terminal state?
 *
 * Decided by TIME, not by job identity or status alone. `syncJobs[0]` is the
 * server's newest job, which for every sync after the first is the previous
 * run's COMPLETED row at the moment the button is pressed — reading its status
 * cleared the spinner before this run existed. Comparing ids against the list
 * the page happened to hold was no better: a list that had missed an event
 * named an older job, so the newer finished one read as "ours". A job stamped
 * `startedAt` at or after the server's `requestedAt` was started after the
 * enqueue, on the same clock, so it cannot be the previous run.
 */
export function isSyncRequestSettled(
  request: PendingSyncRequest,
  servers: readonly ServerLike[],
): boolean {
  if (request.requestedAt === null) return false;
  const latest = servers.find((s) => s.id === request.serverId)?.syncJobs[0];
  if (!latest) return false;
  if (Date.parse(latest.startedAt) < Date.parse(request.requestedAt)) return false;
  return TERMINAL_STATUSES.has(latest.status);
}
