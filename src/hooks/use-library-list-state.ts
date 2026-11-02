"use client";

import { useCallback, useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useFilterPersistence } from "@/hooks/use-filter-persistence";
import { sameFilters } from "@/lib/filters/same-filters";

export type LibraryViewMode = "cards" | "table";
export type SortOrder = "asc" | "desc";

export interface LibraryListStateOptions {
  defaultSortOrder?: SortOrder;
  defaultViewMode?: LibraryViewMode;
  /**
   * The sessionStorage key the filters survive a detail-page round trip under
   * (`"filters-/library/movies"`); none keeps them for this visit only.
   */
  filtersKey?: string;
}

export interface LibraryListState {
  viewMode: LibraryViewMode;
  setViewMode: (mode: LibraryViewMode) => void;
  sortBy: string;
  sortOrder: SortOrder;
  /** A sort header or picker: the same field flips the order, another starts ascending. */
  toggleSort: (field: string) => void;
  toggleOrder: () => void;
  filters: Record<string, string>;
  /** The restored filters, for `MediaFilters`' `externalFilters` (undefined when none). */
  externalFilters: Record<string, string> | undefined;
  /** For `MediaFilters`' `onFilterChange`: a re-broadcast of the held filters changes nothing. */
  onFilterChange: (filters: Record<string, string>) => void;
  clearFilters: () => void;
  hasFilters: boolean;
}

const NO_FILTERS: Record<string, string> = {};

/**
 * A library page's list state: the card/table toggle, the sort, and the
 * filters — written out the same way on every library page.
 *
 * The view mode is read through `useLocalStorage` (`<prefix>-view-mode`, the
 * key each page already used), so a page opened by a client-side navigation
 * after the table was chosen renders the table at once; the pages read it in
 * an effect after mounting, so the cards painted first and the table replaced
 * them. (A full page load still hydrates with the cards the server rendered.)
 * Filters start from the saved ones, so the first fetch is already filtered,
 * and a re-broadcast of the filters the page holds (`sameFilters`) keeps the
 * same object, so it never refetches the list for nothing.
 */
export function useLibraryListState(
  storageKeyPrefix: string,
  defaultSortBy: string = "title",
  options: LibraryListStateOptions = {},
): LibraryListState {
  const { defaultSortOrder = "asc", defaultViewMode = "cards", filtersKey } = options;
  const [storedViewMode, setViewMode] = useLocalStorage<LibraryViewMode>(`${storageKeyPrefix}-view-mode`, defaultViewMode);
  // Anything else stored there (an older value, a hand edit) is the default.
  const viewMode: LibraryViewMode = storedViewMode === "table" || storedViewMode === "cards" ? storedViewMode : defaultViewMode;

  const [sortBy, setSortBy] = useState(defaultSortBy);
  const [sortOrder, setSortOrder] = useState<SortOrder>(defaultSortOrder);

  // Without a key nothing is stored; the hook still runs (hooks cannot be skipped).
  const { savedFilters, persistFilters } = useFilterPersistence(filtersKey ?? `${storageKeyPrefix}-unsaved-filters`);
  const restored = filtersKey ? savedFilters : NO_FILTERS;
  const [filters, setFilters] = useState<Record<string, string>>(restored);

  const toggleSort = useCallback(
    (field: string) => {
      if (field === sortBy) {
        setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
      } else {
        setSortBy(field);
        setSortOrder("asc");
      }
    },
    [sortBy],
  );
  const toggleOrder = useCallback(() => setSortOrder((o) => (o === "asc" ? "desc" : "asc")), []);

  const onFilterChange = useCallback(
    (next: Record<string, string>) => {
      setFilters((prev) => (sameFilters(prev, next) ? prev : next));
      if (filtersKey) persistFilters(next);
    },
    [filtersKey, persistFilters],
  );
  const clearFilters = useCallback(() => onFilterChange({}), [onFilterChange]);

  return {
    viewMode,
    setViewMode,
    sortBy,
    sortOrder,
    toggleSort,
    toggleOrder,
    filters,
    externalFilters: Object.keys(restored).length > 0 ? restored : undefined,
    onFilterChange,
    clearFilters,
    hasFilters: Object.keys(filters).length > 0,
  };
}
