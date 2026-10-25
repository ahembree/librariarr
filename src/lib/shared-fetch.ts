const inFlight = new Map<string, Promise<unknown>>();

/**
 * `GET url` parsed as JSON, `null` on an error status or a failed request,
 * shared by every caller that asks for the same URL in the same synchronous
 * turn.
 *
 * A page load mounts the shell and the page in one flush, and several of them
 * read the same route on mount — the sidebar and the dashboard's status strip
 * both ask for the update check and the active sessions — so each load cost a
 * second identical request. On a plain-HTTP install the browser opens six
 * connections per host and the event stream holds one, so that duplicate
 * queued the page's own requests.
 *
 * The shared request is dropped in a microtask, not on a timer: a call made
 * after an event must never be answered by a request issued before it, and a
 * timer can run after the browser has already dispatched the next event (each
 * event listener is its own turn, so two components still ask separately when
 * an event arrives — as they must). The first caller's `init` is the one sent.
 */
export function fetchJsonShared<T>(url: string, init?: RequestInit): Promise<T | null> {
  let shared = inFlight.get(url) as Promise<T | null> | undefined;
  if (!shared) {
    shared = (init ? fetch(url, init) : fetch(url))
      .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
      .catch(() => null);
    inFlight.set(url, shared);
    queueMicrotask(() => {
      inFlight.delete(url);
    });
  }
  return shared;
}
