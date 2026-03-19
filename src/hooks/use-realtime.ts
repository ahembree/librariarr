"use client";

import { useEffect, useRef, useState } from "react";

// Shared singleton EventSource — ref-counted across all hook instances in the same tab
let sharedSource: EventSource | null = null;
let refCount = 0;
let connectedState = false;
const connectedListeners = new Set<(connected: boolean) => void>();

function setConnected(value: boolean) {
  if (connectedState === value) return;
  connectedState = value;
  for (const listener of connectedListeners) {
    listener(value);
  }
}

function acquireSource(): EventSource {
  refCount++;
  if (sharedSource) return sharedSource;

  try {
    const source = new EventSource("/api/events/stream");
    source.addEventListener("connected", () => setConnected(true));
    source.onerror = () => setConnected(false);
    source.onopen = () => setConnected(true);
    sharedSource = source;
    return source;
  } catch {
    // EventSource not available (e.g., SSR) — return a no-op
    refCount--;
    throw new Error("EventSource unavailable");
  }
}

function releaseSource() {
  refCount--;
  if (refCount <= 0 && sharedSource) {
    sharedSource.close();
    sharedSource = null;
    refCount = 0;
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

    source.addEventListener(eventType, handler);

    return () => {
      // The shared source may have been replaced during reconnection,
      // but removeEventListener on a closed source is safe (no-op).
      source.removeEventListener(eventType, handler);
      connectedListeners.delete(onConnectedChange);
      releaseSource();
    };
  }, [eventType]);

  return { connected };
}
