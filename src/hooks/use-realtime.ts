"use client";

import { useEffect, useRef, useState } from "react";

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

function createSource(): EventSource | null {
  try {
    const source = new EventSource("/api/events/stream");
    source.addEventListener("connected", () => setConnected(true));
    source.onopen = () => {
      // Successful (re)open — reset backoff.
      reconnectDelay = RECONNECT_BASE_MS;
      setConnected(true);
    };
    source.onerror = () => {
      setConnected(false);
      // Only the browser's native auto-reconnect runs while the source is
      // still CONNECTING/OPEN. When the server hard-closes the stream the
      // source transitions to CLOSED and stays dead — rebuild it ourselves.
      if (source.readyState === EventSource.CLOSED) {
        scheduleReconnect();
      }
    };
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

function scheduleReconnect() {
  // Don't reconnect if nobody is subscribed anymore.
  if (refCount <= 0 || reconnectTimer !== null) return;

  if (sharedSource) {
    sharedSource.close();
    sharedSource = null;
  }

  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
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
  if (sharedSource) return sharedSource;

  // sharedSource may be null because a reconnect is scheduled (timer armed).
  // Cancel it and reset backoff before creating, so the timer doesn't later
  // fire a second createSource() and leak a duplicate connection.
  clearReconnectTimer();
  reconnectDelay = RECONNECT_BASE_MS;

  const source = createSource();
  if (!source) {
    refCount--;
    throw new Error("EventSource unavailable");
  }
  return source;
}

function releaseSource() {
  refCount--;
  if (refCount <= 0) {
    refCount = 0;
    clearReconnectTimer();
    reconnectDelay = RECONNECT_BASE_MS;
    if (sharedSource) {
      sharedSource.close();
      sharedSource = null;
    }
    setConnected(false);
  }
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
  callback: (data: Record<string, unknown>) => void,
): { connected: boolean } {
  const [connected, setLocalConnected] = useState(connectedState);
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    // Track connected state
    const onConnectedChange = (value: boolean) => setLocalConnected(value);
    connectedListeners.add(onConnectedChange);

    let source: EventSource;
    try {
      source = acquireSource();
    } catch {
      connectedListeners.delete(onConnectedChange);
      return;
    }

    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        callbackRef.current(data);
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

    return () => {
      // The shared source may have been replaced during reconnection;
      // removeEventListener on a stale/closed source is safe (no-op).
      handlers.delete(handler);
      if (handlers.size === 0) eventHandlers.delete(eventType);
      sharedSource?.removeEventListener(eventType, handler);
      connectedListeners.delete(onConnectedChange);
      releaseSource();
    };
  }, [eventType]);

  return { connected };
}
