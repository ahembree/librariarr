"use client";

import { useCallback, useState } from "react";

export interface FilterPanelReset {
  /** `MediaFilters`' `key`: a clear remounts the panel with nothing set. */
  panelKey: number;
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
 * — and its next change re-sent them all. A clear now remounts the panel too,
 * no longer handing it the restored filters (it would re-apply them).
 */
export function useFilterPanelReset(
  externalFilters: Record<string, string> | undefined,
  clearFilters: () => void,
): FilterPanelReset {
  const [panelKey, setPanelKey] = useState(0);
  const clear = useCallback(() => {
    clearFilters();
    setPanelKey((key) => key + 1);
  }, [clearFilters]);
  return { panelKey, externalFilters: panelKey === 0 ? externalFilters : undefined, clear };
}
