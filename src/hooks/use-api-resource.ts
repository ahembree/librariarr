"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppEventType } from "@/lib/events/event-bus";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { fetchShared } from "@/lib/shared-fetch";

export interface ApiResourceOptions<T, B> {
  /** The route's JSON body → the value held; defaults to the body itself. */
  select?: (body: B) => T;
  /** Events that make the value stale: each refetches it (once per event, and on a reconnect's resync). */
  realtime?: readonly AppEventType[];
}

export interface ApiResource<T> {
  /** The latest answer for the current URL; kept while a refetch runs, null before the first. */
  data: T | null;
  /** A request for the current URL is running and nothing has answered it yet, or a refetch runs. */
  loading: boolean;
  /** Why the latest request failed (the route's `error`, else the status); null once one succeeds. */
  error: string | null;
  /** Ask again; the answer replaces the held value only if no later request was started. */
  refetch: () => Promise<void>;
}

interface Held<T> {
  url: string;
  data: T | null;
  error: string | null;
}

function errorOf(status: number, body: unknown): string {
  const message = (body as { error?: unknown } | null)?.error;
  if (typeof message === "string" && message) return message;
  return status === 0 ? "The request failed" : `Request failed (${status})`;
}

/**
 * `GET url` as component state: loaded when the URL is set or changes, and
 * refetched on the given realtime events, with an answer for an older URL (or
 * an older request) never replacing a newer one. `null` loads nothing.
 *
 * Requests go through `fetchShared`, so components reading the same route on
 * the same event share one request.
 */
export function useApiResource<T, B = T>(url: string | null, options: ApiResourceOptions<T, B> = {}): ApiResource<T> {
  const [held, setHeld] = useState<Held<T> | null>(null);
  // A refetch's token while it runs (the first load for a URL shows as
  // `held` naming another URL); an older one finishing does not clear it.
  const [refreshing, setRefreshing] = useState<number | null>(null);
  const latest = useLatestRequest();
  const selectRef = useRef(options.select);
  useEffect(() => {
    selectRef.current = options.select;
  });
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
  });

  // Sets state only once the request has answered, so the effect below can
  // start it.
  const request = useCallback(
    async (target: string, token: number) => {
      try {
        const res = await fetchShared<B>(target);
        if (!latest.isCurrent(token)) return;
        if (res.ok) {
          const select = selectRef.current;
          const data = select ? select(res.body as B) : (res.body as unknown as T);
          setHeld({ url: target, data, error: null });
        } else {
          // A failed refetch keeps the value it had for this URL.
          setHeld((prev) => ({
            url: target,
            data: prev?.url === target ? prev.data : null,
            error: errorOf(res.status, res.body),
          }));
        }
      } finally {
        if (latest.isCurrent(token)) setRefreshing(null);
      }
    },
    [latest],
  );

  useEffect(() => {
    if (url === null) {
      // Nothing to load, and whatever was running is no longer wanted
      // (`loading` reads false for a null URL, whatever `refreshing` holds).
      latest.cancel();
      return;
    }
    void request(url, latest.begin());
  }, [url, request, latest]);

  const refetch = useCallback(async () => {
    const target = urlRef.current;
    if (target === null) return;
    const token = latest.begin();
    setRefreshing(token);
    await request(target, token);
  }, [request, latest]);
  useRealtimeEvents(options.realtime ?? [], () => {
    void refetch();
  });

  const current = held && held.url === url ? held : null;
  return {
    data: current?.data ?? null,
    loading: url !== null && (current === null || refreshing !== null),
    error: current?.error ?? null,
    refetch,
  };
}
