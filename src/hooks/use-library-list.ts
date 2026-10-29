"use client";

import { startTransition, useCallback, useRef, useState } from "react";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { useListFetch } from "@/hooks/use-list-fetch";
import { useLibrarySyncRefetch } from "@/hooks/use-library-sync-refetch";
import { listCacheKeyFor, loadCachedList } from "@/lib/media/list-cache";
import { fetchListProgressively } from "@/lib/media/progressive-load";
import type { SyncViewScope } from "@/lib/media/sync-scope";

interface LibraryListCommonOptions {
  /** The listing route, e.g. `/api/media/movies`. */
  url: string;
  /**
   * Sort, filters and server for the request. Compared by value: a new object
   * with the same parameters does not refetch, so pages build it inline.
   */
  params: URLSearchParams;
  /** Which `sync:completed` events can change this list (`useLibrarySyncRefetch`). */
  syncScope: SyncViewScope;
  /** How long a filter or sort change waits for the next one (`useListFetch`). */
  debounceMs?: number;
}

export type LibraryListOptions<T, B> = LibraryListCommonOptions &
  (
    | {
        /**
         * The flat, DB-paginated listings (movies, episodes, tracks): a first
         * screenful, then the rest (`fetchListProgressively`).
         */
        mode: "progressive";
      }
    | {
        /**
         * The grouped listings (shows, seasons, artists, albums): one request,
         * aggregated server-side (`loadCachedList`).
         */
        mode: "grouped";
        /** The list in the response body. Must be stable — a module-level function. */
        select: (body: B) => T[] | undefined;
      }
  );

export interface LibraryList<T> {
  items: T[];
  /** No list to show for the current parameters yet — render the skeleton. */
  loading: boolean;
  /**
   * The list on screen is not complete yet (the progressive first screenful).
   * The item count and scroll restoration wait for this; for a grouped list it
   * is the same as `loading`.
   */
  loadingRest: boolean;
  /** Load the list again — `SyncLibraryButton`'s `onSyncComplete`. */
  refetch: () => Promise<void>;
}

/**
 * A library page's list: fetched on mount and on every parameter change
 * (debounced), refetched when a sync changes it, and refreshed in place.
 *
 * - **Load or refresh.** A fetch for the parameters whose list is on screen (a
 *   sync's refetch, the Sync button, a reconnect's resync) is a refresh: no
 *   skeleton, the whole new list handed over once and swapped in where the old
 *   one stands, so cards keyed by id stay mounted and a new item takes its
 *   slot. Anything else (a new filter, sort or server) shows the skeleton —
 *   including going back to the previous parameters while the skeleton for
 *   others is up.
 * - **Rendering.** What the user is waiting on behind the skeleton — the first
 *   screenful, or a grouped list — renders as a normal update; everything else
 *   (the rest of the library, every refresh) inside `startTransition`, so it
 *   never blocks input.
 * - **Errors.** A failed request never leaves a loading flag on. The list
 *   stays when it answers the same parameters (the list refreshed, or a first
 *   screenful), and is emptied when it answers others, which it would read as
 *   the result of.
 * - **Stale answers.** Only the latest request's answer is applied.
 *
 * Each library page carried its own copy of all of this, and the copies drifted.
 */
export function useLibraryList<T, B = unknown>(options: LibraryListOptions<T, B>): LibraryList<T> {
  const { url, params, syncScope, debounceMs, mode } = options;
  const select = options.mode === "grouped" ? options.select : undefined;
  const query = params.toString();

  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRest, setLoadingRest] = useState(true);
  const latest = useLatestRequest();
  // The list in `items`: the request it answers (`listCacheKeyFor`), its
  // length, and whether it is on screen — false while the skeleton stands in.
  const held = useRef<{ key: string | null; length: number; visible: boolean }>({
    key: null,
    length: 0,
    visible: false,
  });

  const refetch = useCallback(async () => {
    const token = latest.begin();
    const requestParams = new URLSearchParams(query);
    const listKey = listCacheKeyFor(url, requestParams);
    const refresh = held.current.visible && held.current.key === listKey;
    if (!refresh) {
      held.current.visible = false;
      setLoading(true);
      setLoadingRest(true);
    }
    // Set once this request's list (or its first screenful) is on screen.
    let applied = false;
    const apply = (list: T[], done: boolean) => {
      if (!latest.isCurrent(token)) return;
      held.current = { key: listKey, length: list.length, visible: true };
      const update = () => {
        setItems(list);
        setLoading(false);
        if (done) setLoadingRest(false);
      };
      // React's standalone `startTransition`, not `useTransition`'s: nothing
      // reads the pending flag, and tracking it re-rendered the whole page
      // around every transition.
      if (applied || refresh) startTransition(update);
      else update();
      applied = true;
    };
    try {
      if (mode === "progressive") {
        await fetchListProgressively<T>(url, requestParams, apply, {
          quiet: refresh,
          shownLength: refresh ? held.current.length : undefined,
        });
      } else if (select) {
        await loadCachedList<B>(url, requestParams, (body) => apply(select(body) ?? [], true));
      }
    } catch (error) {
      console.error(`Failed to load ${url}:`, error);
      if (!latest.isCurrent(token)) return;
      if (held.current.key !== listKey) {
        setItems([]);
        held.current.key = null;
        held.current.length = 0;
      }
      held.current.visible = true;
      setLoading(false);
      setLoadingRest(false);
    }
  }, [url, query, mode, select, latest]);

  useListFetch(refetch, debounceMs);
  useLibrarySyncRefetch(syncScope, refetch);

  return { items, loading, loadingRest, refetch };
}
