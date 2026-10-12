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
 * waited 300 ms before asking for anything. A timer of 0 still runs it outside
 * the effect body, where its loading state is set.
 */
export function useListFetch(fetchList: () => void, debounceMs = LIST_REFETCH_DEBOUNCE_MS): void {
  // Set when a fetch has started, not when the effect runs: Strict Mode runs
  // the effect twice on mount, and the second run must not read as a change.
  const started = useRef(false);

  useEffect(() => {
    const timeout = setTimeout(
      () => {
        started.current = true;
        fetchList();
      },
      started.current ? debounceMs : 0,
    );
    return () => clearTimeout(timeout);
  }, [fetchList, debounceMs]);
}
