/** `GET /api/sync/status`'s body: the latest jobs, newest first. */
export interface SyncStatusBody {
  jobs?: { id: string; status: string; completedAt: string | null; [key: string]: unknown }[];
}

let shared: Promise<SyncStatusBody | null> | null = null;

/**
 * `GET /api/sync/status`, `null` when it fails, shared by every caller in the
 * same task.
 *
 * The dashboard's sync indicator and its status strip both read it, on mount
 * and on the same sync events, so each load and each event cost two identical
 * requests — on a plain-HTTP install, where the browser opens six connections
 * per host and the event stream holds one, a second request queues the page's
 * own. A request is shared only within the task that started it: a call made
 * after an event must not be answered by a request issued before it.
 */
export function fetchSyncStatus(): Promise<SyncStatusBody | null> {
  if (!shared) {
    shared = fetch("/api/sync/status")
      .then((res) => (res.ok ? (res.json() as Promise<SyncStatusBody>) : null))
      .catch(() => null);
    setTimeout(() => {
      shared = null;
    }, 0);
  }
  return shared;
}
