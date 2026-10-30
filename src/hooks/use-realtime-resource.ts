"use client";

import { useEffect, useSyncExternalStore } from "react";
import { beforeRealtimeEvents, isRealtimeLive } from "@/hooks/use-realtime";
import { fetchJsonShared } from "@/lib/shared-fetch";

/**
 * How long a value is trusted while the event stream is not delivering: long
 * enough for the readers mounting in one page load to share the value the
 * first of them loaded (or the server layout seeded), short enough that a page
 * opened later, with pushes down, reads again as it did before the store.
 */
export const TRUST_WITHOUT_STREAM_MS = 10_000;

/**
 * One route's answer held for the whole tab, read by every component that
 * needs it instead of each fetching on mount.
 *
 * Kept current by events: `events` mark it stale (through
 * `beforeRealtimeEvents`, so even with no reader mounted — a server added on
 * Settings is not missed by the Movies page opened next), and mounted readers
 * refetch on them. A reader mounting re-reads when the value is missing, was
 * marked stale, or is older than `TRUST_WITHOUT_STREAM_MS` while the stream is
 * not delivering events (it cannot vouch that nothing changed).
 */
export interface RealtimeResource<T> {
  readonly url: string;
  readonly events: readonly string[];
  getSnapshot(): T | null;
  subscribe(listener: () => void): () => void;
  /**
   * Re-read the route. Stable, so subscribing it to several events still runs
   * it once per reconnect resync; a failed read keeps the current value.
   */
  refresh(): Promise<void>;
  /** Take a value read elsewhere (the server layout's), unless one is already held. */
  seed(value: T): void;
  /** Whether a reader mounting now should re-read (see above). */
  needsRefresh(): boolean;
}

export interface RealtimeResourceOptions<T> {
  url: string;
  /** Events after which the held value may be out of date. */
  events: readonly string[];
  /** The route's JSON body → the held value; `null` rejects the body (kept as a failed read). */
  parse: (body: unknown) => T | null;
}

export function createRealtimeResource<T>({ url, events, parse }: RealtimeResourceOptions<T>): RealtimeResource<T> {
  let value: T | null = null;
  let loadedAt = 0;
  let stale = false;
  // Bumped by every event: a read that started before the latest one cannot
  // clear `stale`, and an older read answering after a newer one is dropped.
  let staleGeneration = 0;
  let lastStarted = 0;
  let lastApplied = 0;
  const listeners = new Set<() => void>();

  beforeRealtimeEvents(events, () => {
    staleGeneration += 1;
    stale = true;
  });

  function set(next: T) {
    value = next;
    loadedAt = Date.now();
    for (const listener of listeners) listener();
  }

  const resource: RealtimeResource<T> = {
    url,
    events,
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refresh() {
      lastStarted += 1;
      const ticket = lastStarted;
      const generation = staleGeneration;
      // Called synchronously, so inside an event the request is shared with
      // every other reader of this route refetching on the same event.
      const body = await fetchJsonShared<unknown>(url);
      const next = body === null ? null : parse(body);
      if (next === null || ticket < lastApplied) return;
      lastApplied = ticket;
      if (generation === staleGeneration) stale = false;
      set(next);
    },
    seed(next) {
      if (value === null) set(next);
    },
    needsRefresh() {
      if (value === null || stale) return true;
      return !isRealtimeLive() && Date.now() - loadedAt > TRUST_WITHOUT_STREAM_MS;
    },
  };
  return resource;
}

const noValue = () => null;

/**
 * The resource's value, re-rendering when it changes, re-read on mount when
 * `needsRefresh()` says so. The caller subscribes `resource.refresh` to the
 * resource's events with `useRealtime` (hooks cannot be called in a loop).
 * Null on the server render and until the first read answers.
 *
 * `seed` is a value the server render read (the dashboard's): it is the
 * answer on the server render and the render hydrating it, and the store
 * takes it on mount unless it already holds one. Taken once.
 */
export function useRealtimeResource<T>(resource: RealtimeResource<T>, seed?: T | null): T | null {
  const value = useSyncExternalStore(resource.subscribe, resource.getSnapshot, noValue);
  useEffect(() => {
    if (seed != null) resource.seed(seed);
    if (resource.needsRefresh()) void resource.refresh();
    // The seed is taken once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource]);
  return value ?? seed ?? null;
}
