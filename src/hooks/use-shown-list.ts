"use client";

import { useMemo, useRef } from "react";

export interface ShownList {
  /**
   * Start loading the list for `key`. True when that list is the one on
   * screen — the fetch is a refresh (a sync added or removed items) and
   * updates it in place, with no skeleton. Otherwise the page is about to
   * show its skeleton, so the list on screen is forgotten.
   */
  begin(key: string): boolean;
  /** The list for `key` is now on screen. */
  markShown(key: string): void;
}

/**
 * Which list a library page has on screen, so a refetch of that same list
 * swaps the new answer in where the old one stands instead of replacing the
 * page with its skeleton and then a first screenful — the whole page flashed
 * every time a sync added an item.
 */
export function useShownList(): ShownList {
  const shown = useRef<string | null>(null);
  return useMemo(
    () => ({
      begin(key: string) {
        if (shown.current === key) return true;
        shown.current = null;
        return false;
      },
      markShown(key: string) {
        shown.current = key;
      },
    }),
    [],
  );
}
