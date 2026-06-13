"use client";

import { useState, useCallback } from "react";

/**
 * Persists library filter state to sessionStorage so filters survive
 * navigation to a detail page and back.
 *
 * @param key - A unique sessionStorage key (e.g. "filters-/library/movies")
 * @returns savedFilters to pass as externalFilters, and a persistFilters callback
 */
export function useFilterPersistence(key: string) {
  // Read once on mount — stable reference for externalFilters
  const [savedFilters] = useState<Record<string, string>>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  const persistFilters = useCallback(
    (filters: Record<string, string>) => {
      // Guard against sessionStorage throwing (private mode) — persistence is
      // best-effort and must not break the calling component.
      try {
        if (Object.keys(filters).length > 0) {
          sessionStorage.setItem(key, JSON.stringify(filters));
        } else {
          sessionStorage.removeItem(key);
        }
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );

  return { savedFilters, persistFilters };
}
