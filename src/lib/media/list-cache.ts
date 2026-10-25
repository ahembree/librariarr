/**
 * The library pages' last-loaded lists, kept for the rest of the tab's life so
 * coming back to a page — from an item's detail page, or another library page
 * — paints the list at once instead of re-downloading the whole library.
 *
 * Before it every visit fetched everything again (a 40k-track library, a
 * 28k-episode one) and scroll restoration waited for all of it to arrive, so
 * "back" from a detail page showed a skeleton for as long as a cold load.
 *
 * - An entry younger than `LIST_FRESH_MS` is shown and nothing is fetched.
 * - An older one, up to `LIST_MAX_AGE_MS`, is shown at once and then
 *   refreshed behind it; past that it is dropped and the page loads as before.
 * - Anything that can change a list clears every entry: the pages' own
 *   `sync:completed` refetch, and the shell's subscription to the events that
 *   change the media set while no library page is mounted.
 * - At most `MAX_ENTRIES` lists are kept (the least recently used goes), so a
 *   filter typed letter by letter cannot keep a library per keystroke.
 */

import { sortedQueryString } from "@/lib/sorted-query";

export const LIST_FRESH_MS = 60_000;
export const LIST_MAX_AGE_MS = 15 * 60_000;
const MAX_ENTRIES = 6;

interface Entry {
  value: unknown;
  storedAt: number;
}

export interface CachedList<T> {
  value: T;
  /** Young enough to show without asking the server again. */
  fresh: boolean;
}

export interface ListCache {
  get<T>(key: string): CachedList<T> | undefined;
  /**
   * Store `value` — unless the cache was cleared since `generation` was read.
   * A request started before a clear answers with the list as it was before
   * whatever the clear was for; stored, it would read as fresh.
   */
  set(key: string, value: unknown, generation?: number): void;
  clear(): void;
  /** Bumped by every `clear`; read it when a request starts and pass it to `set`. */
  generation(): number;
}

export function createListCache(
  { freshMs = LIST_FRESH_MS, maxAgeMs = LIST_MAX_AGE_MS, maxEntries = MAX_ENTRIES } = {},
  now: () => number = Date.now,
): ListCache {
  const entries = new Map<string, Entry>();
  let currentGeneration = 0;
  return {
    get<T>(key: string) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      const age = now() - entry.storedAt;
      if (age > maxAgeMs) {
        entries.delete(key);
        return undefined;
      }
      // Most recently used moves to the end, so eviction takes the oldest use.
      entries.delete(key);
      entries.set(key, entry);
      return { value: entry.value as T, fresh: age <= freshMs };
    },
    set(key, value, generation) {
      if (generation !== undefined && generation !== currentGeneration) return;
      entries.delete(key);
      entries.set(key, { value, storedAt: now() });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear() {
      entries.clear();
      currentGeneration++;
    },
    generation() {
      return currentGeneration;
    },
  };
}

export const libraryListCache = createListCache();

export function clearLibraryListCache(): void {
  libraryListCache.clear();
}

/** `url?params` with the parameters sorted, so their order never splits an entry. */
export function listCacheKeyFor(url: string, params: URLSearchParams): string {
  return `${url}?${sortedQueryString(params)}`;
}

/**
 * GET `url?params` as JSON through the cache: `onData` runs with the cached
 * answer when there is one, and again with the server's when the entry was
 * missing or past fresh. Rejects on a failed request (an error status
 * included), after any cached answer was already handed over.
 */
export async function loadCachedList<T>(
  url: string,
  params: URLSearchParams,
  onData: (data: T) => void,
  cache: ListCache = libraryListCache,
): Promise<void> {
  const key = listCacheKeyFor(url, params);
  const generation = cache.generation();
  const cached = cache.get<T>(key);
  if (cached) {
    onData(cached.value);
    if (cached.fresh) return;
  }
  const response = await fetch(`${url}?${params}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as T;
  cache.set(key, data, generation);
  onData(data);
}
