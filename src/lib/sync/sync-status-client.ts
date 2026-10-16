/** `GET /api/sync/status`'s body: the latest jobs, newest first. */
interface SyncStatusBody {
  jobs?: { id: string; status: string; completedAt: string | null; [key: string]: unknown }[];
}

let shared: Promise<SyncStatusBody | null> | null = null;

/**
 * `GET /api/sync/status`, `null` when it fails, shared by every caller in the
 * same synchronous turn.
 *
 * The dashboard's sync indicator and its status strip both read it on mount,
 * and their mount effects run in one synchronous flush, so a load cost two
 * identical requests — on a plain-HTTP install, where the browser opens six
 * connections per host and the event stream holds one, a second request
 * queues the page's own. The shared request is dropped in a microtask, not a
 * timer: a call made after an event must never be answered by a request
 * issued before it, and a timer can run after the browser has already
 * dispatched the next event (each event listener is its own turn, so the two
 * components still ask separately when an event arrives — as they must).
 */
export function fetchSyncStatus(): Promise<SyncStatusBody | null> {
  if (!shared) {
    shared = fetch("/api/sync/status")
      .then((res) => (res.ok ? (res.json() as Promise<SyncStatusBody>) : null))
      .catch(() => null);
    queueMicrotask(() => {
      shared = null;
    });
  }
  return shared;
}
