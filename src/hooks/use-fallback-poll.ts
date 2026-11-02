"use client";

import { useEffect, useRef } from "react";
import { useRealtimeLive } from "@/hooks/use-realtime";

/**
 * Call `callback` every `intervalMs` while realtime pushes are NOT arriving
 * (`isRealtimeLive()` false), and never while they are.
 *
 * Every poll that a push replaced was kept as a fallback, because SSE dies to
 * proxy buffering and idle timeouts — but kept running beside a healthy stream
 * it repeated, on a timer, exactly what the pushes already delivered. Gated on
 * the stream it still covers both failure modes (a drop, and a proxy that holds
 * the events back), and the reconnect's resync covers the gap when the stream
 * comes back. Do not remove a fallback poll; gate it with this.
 */
export function useFallbackPoll(callback: () => void, intervalMs: number, enabled = true): void {
  const live = useRealtimeLive();
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    if (!enabled || live) return;
    const interval = setInterval(() => callbackRef.current(), intervalMs);
    return () => clearInterval(interval);
  }, [enabled, live, intervalMs]);
}
