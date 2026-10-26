/** A response as `fetchShared` hands it over: never a rejection. */
export interface SharedResponse<T = unknown> {
  ok: boolean;
  /** 0 when the request itself failed (offline, aborted). */
  status: number;
  /** The parsed body — an error status's too — or null when it was not JSON. */
  body: T | null;
}

interface InFlight {
  response: Promise<SharedResponse>;
  /** `fetchJsonShared`'s view of the same request, one promise for every caller. */
  json: Promise<unknown>;
}

const inFlight = new Map<string, InFlight>();

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
  return shared(url, init).json as Promise<T | null>;
}

/**
 * `fetchJsonShared` with the status and an error status's body, for a reader
 * that reports why a request failed. Shares the same request with
 * `fetchJsonShared` callers, on the same rules.
 */
export function fetchShared<T>(url: string, init?: RequestInit): Promise<SharedResponse<T>> {
  return shared(url, init).response as Promise<SharedResponse<T>>;
}

async function request(url: string, init?: RequestInit): Promise<SharedResponse> {
  try {
    const res = await (init ? fetch(url, init) : fetch(url));
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

function shared(url: string, init?: RequestInit): InFlight {
  const scope = activeScope;
  const key = scope === null ? `turn ${url}` : `event:${scope} ${url}`;
  let entry = inFlight.get(key);
  if (!entry) {
    const response = request(url, init);
    const current: InFlight = { response, json: response.then((r) => (r.ok ? r.body : null)) };
    entry = current;
    inFlight.set(key, current);
    const drop = () => {
      if (inFlight.get(key) === current) inFlight.delete(key);
    };
    if (scope === null) queueMicrotask(drop);
    else void response.then(drop);
  }
  return entry;
}
