"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  ColumnValueLoader,
  fetchColumnChunk,
  type ColumnRow,
  type ColumnValueScope,
} from "@/lib/query/column-value-loader";

export type { ColumnValueScope } from "@/lib/query/column-value-loader";

/**
 * Loads the Query page's criterion-column values for the rows on screen, only
 * for the visible columns, once per result set — turning a column on fetches
 * that column alone. `scope` is null while there is nothing to load against
 * (no run yet, or a run in progress).
 */
export function useQueryColumnValues(
  results: readonly ColumnRow[],
  fields: readonly string[],
  scope: ColumnValueScope | null,
) {
  const [loader] = useState(() => new ColumnValueLoader(fetchColumnChunk));
  useSyncExternalStore(loader.subscribe, loader.getVersion, loader.getVersion);

  const fieldsKey = fields.join(",");
  useEffect(() => {
    if (scope) loader.load(results, fieldsKey ? fieldsKey.split(",") : [], scope);
  }, [loader, results, fieldsKey, scope]);

  const view = loader.get(results);
  const active = !!scope && results.length > 0;
  /** A visible column whose values are still on their way. */
  const isPending = useCallback((field: string) => active && !view.loaded.has(field), [active, view]);

  return { values: view.values, isPending, warnings: view.warnings };
}
