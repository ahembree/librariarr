"use client";

import { useCallback, useState } from "react";

export interface FilterPanelReset {
  /** `MediaFilters`' `resetKey`: a clear empties the panel. */
  resetKey: number;
  /** `MediaFilters`' `externalFilters`: the restored ones until the first clear. */
  externalFilters: Record<string, string> | undefined;
  /** The empty state's Clear Filters. */
  clear: () => void;
}

/**
 * "Clear Filters" for a library page whose filter panel keeps its own state.
 *
 * `MediaFilters` only ever merges filters handed to it, so clearing the page's
 * copy refetched an unfiltered list while the panel went on showing every chip
 * — and its next change re-sent them all. A clear now empties the panel too
 * (`resetKey`), and no longer hands it the restored filters (it would
 * re-apply them).
 */
export function useFilterPanelReset(
  externalFilters: Record<string, string> | undefined,
  clearFilters: () => void,
): FilterPanelReset {
  const [resetKey, setResetKey] = useState(0);
  const clear = useCallback(() => {
    clearFilters();
    setResetKey((key) => key + 1);
  }, [clearFilters]);
  return { resetKey, externalFilters: resetKey === 0 ? externalFilters : undefined, clear };
}
