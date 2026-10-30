"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { newRequestScope, runInRequestScope } from "@/lib/shared-fetch";

type RealtimeCallback = (data: Record<string, unknown>) => void;

// Shared singleton EventSource — ref-counted across all hook instances in the same tab
let sharedSource: EventSource | null = null;
let refCount = 0;
let connectedState = false;
const connectedListeners = new Set<(connected: boolean) => void>();

// Reconnection state: the SSE route hard-closes after a ~1h cap (and proxies
// drop idle connections), so we rebuild the shared source after a backoff
// delay rather than leaving realtime updates dead until a page reload.
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Track listeners registered on the active source so we can re-attach them
// to a freshly created source on reconnect.
const eventHandlers = new Map<string, Set<(e: MessageEvent) => void>>();

// Every subscriber's current callback, keyed by nothing — fired once after a
// *re*-open so a page recovers the events that were emitted while the stream
// was down. The SSE protocol gives us no replay (the route sends no event ids,
// so Last-Event-ID can't be honoured either), which means the only way a
// reconnected page can be correct is to refetch. Each entry returns the
// subscriber's callback rather than calling it, so a callback subscribed to
// several event types (a sync card listens to four) runs once, not once per type.
const resyncListeners = new Set<() => RealtimeCallback>();

// Whether the current source has delivered an event — the route's own
// `connected` event or any other. `connected` turns true on the response
// headers alone, which a buffering proxy passes on while it holds every event
// back; the fallback polls gate on this instead, so they keep running exactly
// when pushes are not arriving.
let liveState = false;
const liveListeners = new Set<() => void>();

function setLive(value: boolean) {
  if (liveState === value) return;
  liveState = value;
  for (const listener of liveListeners) listener();
}

// Run before every subscriber's callback for their event types — once per
// event, whichever subscriber's listener the event reaches first. EventSource
// calls listeners in the order they were added, and that order is not stable
// (a child's effect subscribes before its parent's on the first mount, after
// it once the child is replaced on a navigation), so a cache the shell clears
// in its own callback could be read by a page's refetch before the clear ran.
const preHandlers = new Map<string, Set<() => void>>();

// The request scope each event was given when a listener first saw it (see
// `fetchJsonShared`): every subscriber's callback for one event runs in the
// same scope, so the components that refetch one route on it share one
// request. The browser runs microtasks between listeners, so without the scope
// each listener was its own turn and asked separately.
const eventScopes = new WeakMap<Event, number>();

/**
 * The event's request scope, assigned — and the pre-handlers run — the first
 * time any listener sees it.
 */
function firstSight(eventType: string, e: Event): number {
  let scope = eventScopes.get(e);
  if (scope === undefined) {
    scope = newRequestScope();
    eventScopes.set(e, scope);
    setLive(true);
    runPreHandlers(preHandlers.get(eventType) ?? []);
  }
  return scope;
}

// One listener per pre-handled type, kept so the same function can be attached
// to every source and removed again. Whichever listener an event reaches
// first — this one or a subscriber's — runs the pre-handlers, once.
const preDispatchers = new Map<string, (e: MessageEvent) => void>();

function preDispatcherFor(eventType: string): (e: MessageEvent) => void {
  let dispatch = preDispatchers.get(eventType);
  if (!dispatch) {
    dispatch = (e: MessageEvent) => {
      firstSight(eventType, e);
    };
    preDispatchers.set(eventType, dispatch);
  }
  return dispatch;
}

/**
 * Run `fn` before any subscriber's callback whenever one of `eventTypes`
 * arrives, and once before a reconnect's resync. For dropping client-side
 * caches the callbacks then refetch through. It has its own listener on the
 * shared stream, so it runs whether or not anything subscribes to the event
 * type — while the stream is open, which some subscriber keeps it. Returns the
 * unregister function.
 */
export function beforeRealtimeEvents(eventTypes: readonly string[], fn: () => void): () => void {
  for (const type of eventTypes) {
    let set = preHandlers.get(type);
    if (!set) {
      set = new Set();
      preHandlers.set(type, set);
      sharedSource?.addEventListener(type, preDispatcherFor(type));
    }
    set.add(fn);
  }
  return () => {
    for (const type of eventTypes) {
      const set = preHandlers.get(type);
      if (!set) continue;
      set.delete(fn);
      if (set.size === 0) {
        preHandlers.delete(type);
        sharedSource?.removeEventListener(type, preDispatcherFor(type));
      }
    }
  };
}

function runPreHandlers(fns: Iterable<() => void>) {
  for (const fn of fns) {
    try {
      fn();
    } catch {
      // A failing pre-handler must not stop the event reaching subscribers.
    }
  }
}

// A page-level subscriber unmounts before the next page's mounts on every
// client-side navigation, so refCount transiently hits 0 on every route
// change. Closing immediately tore the shared connection down and rebuilt it
// each time — measured against the dev instance, 13 connections in 180s with
// lifetimes of 1–17s against a 1h design — and every event emitted in those
// gaps was lost. Hold the connection open briefly instead.
const IDLE_CLOSE_DELAY_MS = 10000;
let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;

// Floor between resyncs. A resync fans out to every mounted subscriber, so on
// a busy page it is a burst of tens of requests. Reopens are supposed to be
// rare, but the exact environment this hook must survive — a proxy that closes
// SSE connections every few seconds — would otherwise turn each reopen into
// that burst, which is worse than the polling the pushes replaced. Suppressing
// a second resync within this window costs nothing: the first one's data is at
// most this stale.
const MIN_RESYNC_INTERVAL_MS = 5000;
let lastResyncAt = 0;

// Whether a stream has been established at least once *while the current set
// of subscribers has been alive*. Gates the resync: a first open must not fire
// it (the page just mounted and did its own initial fetch), but a re-open must.
let everConnected = false;

// How long the auth probe may take before we give up on it and just reconnect.
const AUTH_PROBE_TIMEOUT_MS = 5000;

// Retry floor after an authentication failure. Deliberately slow rather than
// stopped: retrying a 401 every 2-30s is pointless noise, but never retrying
// leaves the tab permanently dead even after the user signs back in — and the
// shell's subscription never unmounts, so nothing would ever re-arm it.
const AUTH_RETRY_MS = 60000;

// Set when the server answers the stream request with an auth failure. The
// browser reports a non-200 as a plain `error` with readyState CLOSED — the
// same shape as a dropped connection — so without this the hook retries a 401
// every 30s forever, silently, and the page never updates or prompts a login.
let authFailed = false;
const authFailedListeners = new Set<(expired: boolean) => void>();

function setAuthFailed(value: boolean) {
  if (authFailed === value) return;
  authFailed = value;
  for (const listener of authFailedListeners) {
    listener(value);
  }
}

function setConnected(value: boolean) {
  if (connectedState === value) return;
  connectedState = value;
  for (const listener of connectedListeners) {
    listener(value);
  }
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearIdleCloseTimer() {
  if (idleCloseTimer !== null) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }
}

/**
 * Fire every subscriber's callback once, as though the event it listens for
 * had just arrived. Called after a re-open, because events emitted while the
 * stream was down are gone for good. A callback subscribed to several event
 * types runs once, and every callback runs in one request scope, so the
 * subscribers that refetch the same route share the request.
 */
function fireResync() {
  // The cache drops run on every reopen, throttled or not: they cost no
  // request, and skipped they left lists loaded before the drop reading as
  // fresh once the stream was live again, past any event missed meanwhile.
  runPreHandlers(new Set([...preHandlers.values()].flatMap((set) => [...set])));
  const now = Date.now();
  if (now - lastResyncAt < MIN_RESYNC_INTERVAL_MS) return;
  lastResyncAt = now;

  const callbacks = new Set<RealtimeCallback>();
  for (const current of resyncListeners) callbacks.add(current());
  const scope = newRequestScope();
  for (const callback of callbacks) {
    try {
      runInRequestScope(scope, () => callback({}));
    } catch {
      // A failing subscriber must not stop the others resyncing.
    }
  }
}

/**
 * Distinguish "the session is no longer valid" from "the connection dropped".
 * EventSource exposes no status code, so ask the same route over fetch.
 */
async function checkAuthFailure(): Promise<boolean> {
  try {
    const res = await fetch("/api/events/stream", {
      method: "HEAD",
      cache: "no-store",
      // Bounded: this probe sits in front of every reconnect, so a wedged
      // network or a proxy that holds the request open must not be able to
      // stall reconnection indefinitely. On timeout we fall through to the
      // catch and reconnect as normal.
      signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
    });
    return res.status === 401 || res.status === 403;
  } catch {
    // Network error or timeout — indistinguishable from an ordinary drop, so
    // keep retrying rather than declaring the session dead.
    return false;
  }
}

// The server time a page's server-rendered data was read at, until the
// stream's first `connected` event says whether anything was emitted since
// (see `resyncIfEventsSince`).
let pendingSnapshotAt: number | null = null;

/**
 * For a page whose server render carried its data (the dashboard): that data
 * was read at `serverTime`, before this tab's stream existed, so an event
 * emitted between the two reached nobody. The stream's first `connected` event
 * names the server's last event; if it is that late or later, every subscriber
 * refetches once, as on a reconnect. A page that fetched its own data on mount
 * never needs this — the stream opens before its answers arrive.
 */
export function resyncIfEventsSince(serverTime: number): void {
  if (liveState) {
    // Already delivering: the `connected` event that would have answered has
    // gone by, so the gap cannot be checked.
    fireResync();
    return;
  }
  pendingSnapshotAt = pendingSnapshotAt === null ? serverTime : Math.min(pendingSnapshotAt, serverTime);
}

/** Whether a `connected` event's `lastEventAt` reports an event at or after `since`. */
function eventsSince(e: Event, since: number): boolean {
  try {
    const { lastEventAt } = JSON.parse((e as MessageEvent).data) as { lastEventAt?: unknown };
    // null: the server has emitted nothing since it started.
    if (lastEventAt === null) return false;
    return typeof lastEventAt !== "number" || lastEventAt >= since;
  } catch {
    // Unreadable: refetch rather than trust data that may be stale.
    return true;
  }
}

function createSource(): EventSource | null {
  try {
    const source = new EventSource("/api/events/stream");
    source.addEventListener("connected", (e) => {
      setConnected(true);
      setLive(true);
      if (pendingSnapshotAt !== null) {
        const since = pendingSnapshotAt;
        pendingSnapshotAt = null;
        if (eventsSince(e, since)) fireResync();
      }
    });
    source.onopen = () => {
      // Successful (re)open — reset backoff.
      reconnectDelay = RECONNECT_BASE_MS;
      setAuthFailed(false);
      setConnected(true);
      // A re-open means we were down; anything emitted in the gap was never
      // delivered, so tell subscribers to refetch. A first open must not fire
      // this — the page has just mounted and already loaded its own data.
      if (everConnected) {
        fireResync();
      } else {
        everConnected = true;
      }
    };
    source.onerror = () => {
      setConnected(false);
      setLive(false);
      // Only the browser's native auto-reconnect runs while the source is
      // still CONNECTING/OPEN. When the server hard-closes the stream the
      // source transitions to CLOSED and stays dead — rebuild it ourselves.
      if (source.readyState !== EventSource.CLOSED) return;

      // Retire this source NOW, before the async probe below. Two things go
      // wrong if a dead source stays installed across an await:
      //   - `acquireSource()` short-circuits on a non-null `sharedSource`, so
      //     the next subscriber would be handed a closed stream (and would
      //     never reset `authFailed`, leaving the tab dead even after a
      //     re-login).
      //   - a late probe belonging to THIS source would call
      //     `scheduleReconnect()`, which closes whatever `sharedSource` happens
      //     to be by then — potentially a healthy replacement.
      if (sharedSource === source) sharedSource = null;
      source.close();

      void checkAuthFailure().then((isAuth) => {
        // A healthy source was built while the probe was in flight (a new
        // subscriber, or an earlier reconnect timer firing). Leave it alone.
        if (sharedSource) return;

        if (isAuth) {
          // Retrying an expired session on the ordinary 2–30s backoff is
          // pointless noise, but stopping outright leaves the tab dead until a
          // full reload — the shell's subscription never unmounts, so nothing
          // would re-arm it. Retry, slowly, so a re-login recovers on its own.
          setAuthFailed(true);
          setConnected(false);
          scheduleReconnect(AUTH_RETRY_MS);
          return;
        }
        scheduleReconnect();
      });
    };
    // The pre-handlers' own listeners first, then every subscriber's.
    for (const eventType of preHandlers.keys()) {
      source.addEventListener(eventType, preDispatcherFor(eventType));
    }
    // Re-attach any subscriber handlers to the new source.
    for (const [eventType, handlers] of eventHandlers) {
      for (const handler of handlers) {
        source.addEventListener(eventType, handler);
      }
    }
    sharedSource = source;
    return source;
  } catch {
    // EventSource not available (e.g., SSR).
    return null;
  }
}

function scheduleReconnect(fixedDelayMs?: number) {
  // Don't reconnect if nobody is subscribed anymore.
  if (refCount <= 0 || reconnectTimer !== null) return;

  if (sharedSource) {
    sharedSource.close();
    sharedSource = null;
  }

  // A fixed delay (the post-401 floor) must not consume or advance the
  // exponential backoff used for ordinary drops.
  const delay = fixedDelayMs ?? reconnectDelay;
  if (fixedDelayMs === undefined) {
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (refCount <= 0) return;
    // A new subscriber may have already rebuilt the source via acquireSource
    // while this timer was pending — don't create a duplicate (the first would
    // be leaked and every event delivered twice).
    if (sharedSource) return;
    createSource();
  }, delay);
}

function acquireSource(): EventSource {
  refCount++;
  // A pending idle close is now obsolete — this subscriber wants the stream.
  // This is what makes a navigation reuse the live connection instead of
  // rebuilding it.
  clearIdleCloseTimer();

  if (sharedSource) return sharedSource;

  // sharedSource may be null because a reconnect is scheduled (timer armed).
  // Cancel it and reset backoff before creating, so the timer doesn't later
  // fire a second createSource() and leak a duplicate connection.
  clearReconnectTimer();
  reconnectDelay = RECONNECT_BASE_MS;
  // A previous auth failure must not veto a fresh attempt: the user may have
  // signed back in since.
  setAuthFailed(false);

  const source = createSource();
  if (!source) {
    refCount--;
    throw new Error("EventSource unavailable");
  }
  return source;
}

function releaseSource() {
  refCount--;
  if (refCount > 0) return;

  refCount = 0;
  // Don't close yet. On a client-side navigation React unmounts the outgoing
  // page's subscribers before mounting the incoming page's, so refCount hits
  // zero on every route change even though the user never left the app.
  // Closing here is what produced the observed 1–17s connection lifetimes.
  clearIdleCloseTimer();
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    // A subscriber arrived while we waited — the connection is in use again.
    if (refCount > 0) return;

    clearReconnectTimer();
    reconnectDelay = RECONNECT_BASE_MS;
    if (sharedSource) {
      sharedSource.close();
      sharedSource = null;
    }
    // Nobody is listening, so nobody can miss an event: the next subscriber
    // does its own initial fetch and must not also be told to resync.
    everConnected = false;
    lastResyncAt = 0;
    setConnected(false);
    setLive(false);
  }, IDLE_CLOSE_DELAY_MS);
}

/**
 * Connection machinery, exposed for unit tests only.
 *
 * The reconnect path's failure modes (a dead source being handed to the next
 * subscriber, a stale auth probe closing a healthy replacement, the navigation
 * grace period) live in these module-level functions rather than in the React
 * hook, so testing them through a rendered component would only add noise.
 * Nothing in the app imports this.
 */
export const __testing = {
  acquireSource,
  releaseSource,
  registerResync: (fn: () => void) => resyncListeners.add(() => fn),
};

/**
 * Whether pushes are arriving right now: the current stream has delivered an
 * event since it opened. False while it connects, after a drop, and behind a
 * proxy that passes the headers but holds the events back.
 */
export function isRealtimeLive(): boolean {
  return liveState;
}

function subscribeLive(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}

const notLive = () => false;

/**
 * `isRealtimeLive()`, re-rendering when it changes. Reads only — it does not
 * keep the stream open (the shell's subscription does).
 */
export function useRealtimeLive(): boolean {
  return useSyncExternalStore(subscribeLive, isRealtimeLive, notLive);
}

/**
 * Subscribe to real-time server events via SSE.
 *
 * All hook instances in the same tab share a single EventSource connection.
 * The callback fires whenever the server emits an event matching `eventType`.
 * If SSE is unavailable or disconnects, pages continue working — this is a
 * progressive enhancement, not a requirement.
 */
export function useRealtime(
  eventType: string,
  callback: RealtimeCallback,
): { connected: boolean; authExpired: boolean } {
  return useRealtimeSubscription(eventType, callback);
}

/**
 * `useRealtime` for several event types at once — for a hook that takes its
 * event list as an argument (hooks cannot be called in a loop). One
 * subscription: the callback runs once per event, and once per reconnect's
 * resync. An empty list subscribes to nothing.
 */
export function useRealtimeEvents(
  eventTypes: readonly string[],
  callback: RealtimeCallback,
): { connected: boolean; authExpired: boolean } {
  return useRealtimeSubscription(eventTypes.join("\n"), callback);
}

/** `typesKey`: the event types, newline-joined (no event type contains one). */
function useRealtimeSubscription(
  typesKey: string,
  callback: RealtimeCallback,
): { connected: boolean; authExpired: boolean } {
  const [connected, setLocalConnected] = useState(connectedState);
  const [authExpired, setLocalAuthExpired] = useState(authFailed);
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    const eventTypes = typesKey.split("\n").filter(Boolean);
    if (eventTypes.length === 0) return;

    // Track connected state
    const onConnectedChange = (value: boolean) => setLocalConnected(value);
    connectedListeners.add(onConnectedChange);
    const onAuthChange = (value: boolean) => setLocalAuthExpired(value);
    authFailedListeners.add(onAuthChange);

    let source: EventSource;
    try {
      source = acquireSource();
    } catch {
      connectedListeners.delete(onConnectedChange);
      authFailedListeners.delete(onAuthChange);
      return;
    }

    const attached = eventTypes.map((eventType) => {
      const handler = (e: MessageEvent) => {
        const scope = firstSight(eventType, e);
        try {
          const data = JSON.parse(e.data);
          runInRequestScope(scope, () => callbackRef.current(data));
        } catch {
          // Ignore malformed events
        }
      };

      // Track the handler in the shared registry so it can be re-attached to a
      // fresh source on reconnect, then attach it to the current source.
      let handlers = eventHandlers.get(eventType);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(eventType, handlers);
      }
      handlers.add(handler);
      source.addEventListener(eventType, handler);
      return { eventType, handler, handlers };
    });

    // Recover from a gap: after a reconnect the same callback runs as though
    // the event had arrived, because whatever was emitted while the stream was
    // down is unrecoverable. Callbacks here are refetches, so re-running one is
    // exactly the right recovery.
    const resync = () => callbackRef.current;
    resyncListeners.add(resync);

    return () => {
      for (const { eventType, handler, handlers } of attached) {
        // The shared source may have been replaced during reconnection;
        // removeEventListener on a stale/closed source is safe (no-op).
        handlers.delete(handler);
        if (handlers.size === 0) eventHandlers.delete(eventType);
        sharedSource?.removeEventListener(eventType, handler);
      }
      resyncListeners.delete(resync);
      connectedListeners.delete(onConnectedChange);
      authFailedListeners.delete(onAuthChange);
      releaseSource();
    };
  }, [typesKey]);

  return { connected, authExpired };
}
