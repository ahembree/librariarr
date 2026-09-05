import { eventBus } from "@/lib/events/event-bus";

/**
 * Minimum gap between `sync:progress` events for one server.
 *
 * A sync commits a batch roughly every second over a run of 90–240s, and each
 * event costs every open tab one `/api/sync/status` query (three uncached DB
 * reads). 2s matches the floor the Tracearr import progress already uses, and
 * is well inside the cadence a progress bar needs to look live.
 */
const SYNC_PROGRESS_THROTTLE_MS = 2_000;

/**
 * Last emit per server. Module-level rather than per-run so a sync that starts
 * immediately after another finishes cannot let its first batch through
 * unthrottled — the same reason the Tracearr importer keeps its map at module
 * scope.
 */
const lastEmit = new Map<string, number>();

/**
 * Announce that a running sync made progress.
 *
 * Carries no figures on purpose. Three surfaces render sync progress
 * (`sync-indicator`, `sync-status`, and the Settings servers tab) and each
 * derives it differently; putting counts on the event would mean computing them
 * a second time here, where they could silently disagree with
 * `/api/sync/status`. The receiver refetches that route, which stays the single
 * place progress is computed.
 *
 * This event is what lets those surfaces stop polling every 2 seconds for the
 * whole duration of a sync.
 */
export function emitSyncProgress(userId: string, serverId: string): void {
  const now = Date.now();
  const last = lastEmit.get(serverId) ?? 0;
  if (now - last < SYNC_PROGRESS_THROTTLE_MS) return;
  lastEmit.set(serverId, now);

  eventBus.emit({ type: "sync:progress", userId, meta: { serverId } });
}

/**
 * Drop a server's throttle state when its sync ends, so the next run's first
 * batch is reported immediately instead of being swallowed by the tail of the
 * previous run's window.
 */
export function clearSyncProgressThrottle(serverId: string): void {
  lastEmit.delete(serverId);
}
