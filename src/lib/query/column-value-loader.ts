import type { QueryColumnValue } from "./column-fields";
import { MAX_COLUMN_VALUE_ITEMS } from "./constants";

/**
 * Client-side loader behind the Query page's criterion columns (React-free so
 * it can be unit-tested; `useQueryColumnValues` wraps it). Values belong to the
 * result set they were fetched for, each column is fetched once per result set,
 * and large result sets go out in `MAX_COLUMN_VALUE_ITEMS`-row requests.
 */

export interface ColumnRow {
  id: string;
  matchedEpisodes?: number;
}

export interface ColumnValueScope {
  serverIds: string[];
  arrServerIds?: { radarr?: string; sonarr?: string; lidarr?: string };
}

export interface ColumnValuesView {
  values: Record<string, Record<string, QueryColumnValue>>;
  /** Fields answered for this result set (successfully or not). */
  loaded: ReadonlySet<string>;
  warnings: string[];
}

export type ColumnChunkFetcher = (
  items: Array<{ id: string; grouped: boolean }>,
  fields: string[],
  scope: ColumnValueScope,
) => Promise<{ values: ColumnValuesView["values"]; warnings: string[] }>;

const EMPTY_VIEW: ColumnValuesView = { values: {}, loaded: new Set(), warnings: [] };

export class ColumnValueLoader {
  private results: readonly ColumnRow[] | null = null;
  private view: ColumnValuesView = EMPTY_VIEW;
  /** The result set fetches were last started for, and the fields in flight for it. */
  private inflight: { results: readonly ColumnRow[] | null; fields: Set<string> } = {
    results: null,
    fields: new Set(),
  };
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly fetchChunk: ColumnChunkFetcher,
    private readonly chunkSize = MAX_COLUMN_VALUE_ITEMS,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  /** What is known for `results` — empty for any result set but the current one. */
  get(results: readonly ColumnRow[]): ColumnValuesView {
    return this.results === results ? this.view : EMPTY_VIEW;
  }

  /** Fetch the fields not yet loaded or in flight for `results`. */
  load(results: readonly ColumnRow[], fields: readonly string[], scope: ColumnValueScope): void {
    if (this.inflight.results !== results) this.inflight = { results, fields: new Set() };
    if (results.length === 0) return;
    const loaded = this.get(results).loaded;
    const toFetch = fields.filter((f) => !loaded.has(f) && !this.inflight.fields.has(f));
    if (toFetch.length === 0) return;
    for (const f of toFetch) this.inflight.fields.add(f);

    void this.fetchAll(results, toFetch, scope).then(({ values, warnings }) => {
      // A newer result set has started loading: this answer is for rows no
      // longer on screen, and storing it would replace the newer one's values.
      if (this.inflight.results !== results) return;
      this.merge(results, toFetch, values, warnings);
    });
  }

  private async fetchAll(results: readonly ColumnRow[], fields: string[], scope: ColumnValueScope) {
    const items = results.map((r) => ({ id: r.id, grouped: r.matchedEpisodes != null }));
    const values: ColumnValuesView["values"] = {};
    const warnings = new Set<string>();
    for (let i = 0; i < items.length; i += this.chunkSize) {
      try {
        const chunk = await this.fetchChunk(items.slice(i, i + this.chunkSize), fields, scope);
        Object.assign(values, chunk.values);
        for (const w of chunk.warnings) warnings.add(w);
      } catch (error) {
        warnings.add(error instanceof Error && error.message ? error.message : "Column values could not be loaded");
      }
    }
    return { values, warnings: [...warnings] };
  }

  private merge(
    results: readonly ColumnRow[],
    fields: string[],
    values: ColumnValuesView["values"],
    warnings: string[],
  ) {
    const base = this.get(results);
    const nextValues = { ...base.values };
    for (const [id, row] of Object.entries(values)) {
      nextValues[id] = { ...nextValues[id], ...row };
    }
    this.results = results;
    this.view = {
      values: nextValues,
      loaded: new Set([...base.loaded, ...fields]),
      warnings: [...new Set([...base.warnings, ...warnings])],
    };
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

/** The loader's fetcher: one `POST /api/query/column-values` per chunk. */
export const fetchColumnChunk: ColumnChunkFetcher = async (items, fields, scope) => {
  const resp = await fetch("/api/query/column-values", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items,
      fields,
      serverIds: scope.serverIds,
      ...(scope.arrServerIds && { arrServerIds: scope.arrServerIds }),
    }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body?.detail || body?.error || "Column values could not be loaded");
  return {
    values: body.values ?? {},
    warnings: Array.isArray(body.warnings) ? body.warnings : [],
  };
};
