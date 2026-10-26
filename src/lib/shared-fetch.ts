const inFlight = new Map<string, Promise<unknown>>();

// The realtime event whose subscribers are running right now, if any (see
// `runInRequestScope`). Null outside an event.
let activeScope: number | null = null;
let lastScope = 0;

/** A new request scope: one realtime event, or one reconnect's resync. */
export function newRequestScope(): number {
  lastScope += 1;
  return lastScope;
}

/**
 * Run `fn` with `scope` as the request scope: every `fetchJsonShared` call it
 * makes synchronously shares one request with the other calls made in the same
 * scope. `useRealtime` runs each subscriber's callback in its event's scope.
 */
export function runInRequestScope<T>(scope: number, fn: () => T): T {
  const previous = activeScope;
  activeScope = scope;
  try {
    return fn();
  } finally {
    activeScope = previous;
  }
}

/**
 * `GET url` parsed as JSON, `null` on an error status or a failed request,
 * shared by every caller that asks for the same URL in the same synchronous
 * turn — or, inside a realtime event's callbacks, by every subscriber of that
 * event.
 *
 * A page load mounts the shell and the page in one flush, and several of them
 * read the same route on mount — the sidebar and the dashboard's status strip
 * both ask for the update check and the active sessions — so each load cost a
 * second identical request. On a plain-HTTP install the browser opens six
 * connections per host and the event stream holds one, so that duplicate
 * queued the page's own requests.
 *
 * Outside an event the shared request is dropped in a microtask, not on a
 * timer: a call made after an event must never be answered by a request issued
 * before it, and a timer can run after the browser has already dispatched the
 * next event. The browser runs microtasks between an event's listeners, so the
 * turn alone would have every subscriber of one event ask separately (three
 * `/api/sync/status` requests per sync event on the dashboard); inside an
 * event the request is keyed by the event's scope instead, which no other
 * event and no call outside an event shares, and is dropped once it answers.
 * The first caller's `init` is the one sent.
 *
 * Callers share the parsed body, so none may mutate it.
 */
export function fetchJsonShared<T>(url: string, init?: RequestInit): Promise<T | null> {
  const scope = activeScope;
  const key = scope === null ? `turn ${url}` : `event:${scope} ${url}`;
  let shared = inFlight.get(key) as Promise<T | null> | undefined;
  if (!shared) {
    const request = (init ? fetch(url, init) : fetch(url))
      .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
      .catch(() => null);
    shared = request;
    inFlight.set(key, request);
    const drop = () => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    };
    if (scope === null) queueMicrotask(drop);
    else void request.then(drop);
  }
  return shared;
}
