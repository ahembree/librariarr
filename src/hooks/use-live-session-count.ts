"use client";

import { useSyncExternalStore } from "react";

/**
 * How many playback sessions are active, as a page that receives the session
 * list over its own stream knows it — the Stream Manager reads
 * `/api/tools/sessions/stream`, which pushes the list as it changes.
 *
 * The sidebar's stream badge otherwise re-reads `/api/tools/sessions` on every
 * `session-changed` event, and that route asks every media server for its
 * sessions; while the Stream Manager is open the badge takes its count from
 * here instead. Null while nothing publishes, which sends the sidebar back to
 * its own reads.
 */
let liveCount: number | null = null;
const listeners = new Set<() => void>();

export function publishLiveSessionCount(count: number | null): void {
  if (liveCount === count) return;
  liveCount = count;
  for (const listener of listeners) listener();
}

export function getLiveSessionCount(): number | null {
  return liveCount;
}

export function subscribeLiveSessionCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const serverSnapshot = () => null;

/** The published count, re-rendering when it changes; null while nothing publishes. */
export function useLiveSessionCount(): number | null {
  return useSyncExternalStore(subscribeLiveSessionCount, getLiveSessionCount, serverSnapshot);
}
