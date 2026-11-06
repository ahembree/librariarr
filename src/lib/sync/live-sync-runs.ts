/**
 * The `SyncJob` rows whose run is in progress in this process.
 *
 * A RUNNING row says a run started; only this registry says it is still going.
 * `syncMediaServer` adds its row before flipping it RUNNING and removes it in
 * its outermost `finally`, after its last write — so a RUNNING row missing
 * from here belongs to a run that ended without recording how (its terminal
 * update threw), and `closeDeadSyncJobs` may close it. Graphile Worker runs in
 * this process, and `cleanupOrphanedSyncJobs` already treats every RUNNING row
 * at boot as orphaned, so no other process holds a live run.
 *
 * Pinned to globalThis: the sync runs in the worker's copy of this module, and
 * the sync and cancel routes read it from theirs.
 */
const globalForLiveSyncRuns = globalThis as unknown as {
  liveSyncRuns: Set<string> | undefined;
};
const liveRuns = (globalForLiveSyncRuns.liveSyncRuns ??= new Set<string>());

/** Register a run's row as live. Call before the row is flipped RUNNING. */
export function beginSyncRun(syncJobId: string): void {
  liveRuns.add(syncJobId);
}

/** The run is over — whether or not its terminal write landed. */
export function endSyncRun(syncJobId: string): void {
  liveRuns.delete(syncJobId);
}

export function isSyncRunLive(syncJobId: string): boolean {
  return liveRuns.has(syncJobId);
}
