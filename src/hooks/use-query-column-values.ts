"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryColumnValue } from "@/lib/query/column-fields";

interface ColumnRow {
  id: string;
  matchedEpisodes?: number;
}

export interface ColumnValueScope {
  serverIds: string[];
  arrServerIds?: { radarr?: string; sonarr?: string; lidarr?: string };
}

interface State {
  results: readonly ColumnRow[] | null;
  values: Record<string, Record<string, QueryColumnValue>>;
  loaded: ReadonlySet<string>;
  warnings: string[];
}

const EMPTY: State = { results: null, values: {}, loaded: new Set(), warnings: [] };

/**
 * Loads the Query page's criterion-column values for the rows on screen, only
 * for the columns that are visible, and only once per result set — turning a
 * column on fetches that column alone. Values belong to the result set they
 * were fetched for, so a new run starts empty without a reset effect.
 */
export function useQueryColumnValues(
  results: readonly ColumnRow[],
  fields: readonly string[],
  scope: ColumnValueScope | null,
) {
  const [state, setState] = useState<State>(EMPTY);
  const inflight = useRef<{ results: readonly ColumnRow[] | null; fields: Set<string> }>({
    results: null,
    fields: new Set(),
  });

  const current = state.results === results ? state : EMPTY;
  const missingKey = scope && results.length > 0
    ? fields.filter((f) => !current.loaded.has(f)).sort().join(",")
    : "";

  useEffect(() => {
    if (!missingKey || !scope) return;
    if (inflight.current.results !== results) inflight.current = { results, fields: new Set() };
    const toFetch = missingKey.split(",").filter((f) => !inflight.current.fields.has(f));
    if (toFetch.length === 0) return;
    for (const f of toFetch) inflight.current.fields.add(f);

    const merge = (values: State["values"], warnings: string[]) => {
      setState((prev) => {
        const base = prev.results === results ? prev : { ...EMPTY, results };
        const nextValues = { ...base.values };
        for (const [id, row] of Object.entries(values)) {
          nextValues[id] = { ...nextValues[id], ...row };
        }
        return {
          results,
          values: nextValues,
          loaded: new Set([...base.loaded, ...toFetch]),
          warnings: [...new Set([...base.warnings, ...warnings])],
        };
      });
    };

    fetch("/api/query/column-values", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: results.map((r) => ({ id: r.id, grouped: r.matchedEpisodes != null })),
        fields: toFetch,
        serverIds: scope.serverIds,
        ...(scope.arrServerIds && { arrServerIds: scope.arrServerIds }),
      }),
    })
      .then(async (resp) => {
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          merge({}, [body?.detail || body?.error || "Column values could not be loaded"]);
          return;
        }
        merge(body.values ?? {}, Array.isArray(body.warnings) ? body.warnings : []);
      })
      .catch(() => merge({}, ["Column values could not be loaded"]));
  }, [missingKey, results, scope]);

  const loaded = current.loaded;
  const active = !!scope && results.length > 0;
  /** A visible column whose values are still on their way. */
  const isPending = useCallback((field: string) => active && !loaded.has(field), [active, loaded]);

  return { values: current.values, isPending, warnings: current.warnings };
}
