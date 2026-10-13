"use client";

import { useEffect, useRef } from "react";

/** How long a filter or sort change waits for the next one before refetching. */
export const LIST_REFETCH_DEBOUNCE_MS = 300;

/**
 * Run a library list's fetch on mount and again whenever `fetchList` changes
 * (its filters, sort or server).
 *
 * Changes are debounced, so ticking three resolutions in a row fetches once.
 * The FIRST fetch is not: the pages used to debounce it too, so every visit
 * waited 300 ms before asking for anything. It runs in a microtask — outside
 * the effect body, where its loading state is set, but before the browser lays
 * out and paints the skeleton, which a `setTimeout(0)` waited behind (15–40 ms
 * after the page's other requests had gone out, measured).
 */
export function useListFetch(fetchList: () => void, debounceMs = LIST_REFETCH_DEBOUNCE_MS): void {
  // Set when a fetch has started, not when the effect runs: Strict Mode runs
  // the effect twice on mount, and the second run must not read as a change.
  const started = useRef(false);

  useEffect(() => {
    if (!started.current) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        started.current = true;
        fetchList();
      });
      return () => {
        cancelled = true;
      };
    }
    const timeout = setTimeout(fetchList, debounceMs);
    return () => clearTimeout(timeout);
  }, [fetchList, debounceMs]);
}
