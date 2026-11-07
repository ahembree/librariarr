"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { useListFetch } from "@/hooks/use-list-fetch";
import { useLibrarySyncRefetch } from "@/hooks/use-library-sync-refetch";
import { fetchJson, libraryListCache, listCacheKeyFor, type ListCache } from "@/lib/media/list-cache";
import type { ListIndex } from "@/lib/media/list-index";
import {
  MAX_PAGES_IN_FLIGHT,
  listingParams,
  pageUrl,
  pagesForRange,
  rowsOf,
  type PagedListSnapshot,
} from "@/lib/media/paged-list";
import type { SyncViewScope } from "@/lib/media/sync-scope";
import { sortedQueryString } from "@/lib/sorted-query";

export interface LibraryListOptions<T, B> {
  /** The listing route, e.g. `/api/media/movies`. */
  url: string;
  /**
   * Sort, filters and server for the request. Compared by value: a new object
   * with the same parameters does not refetch, so pages build it inline. Page
   * parameters (`page`, `limit`, `offset`, `index`) are the hook's own and
   * are ignored here.
   */
  params: URLSearchParams;
  /** The rows in a page's body (`items`, `series`, `artists`, …). Read through a ref, so it may be inline. */
  select: (body: B) => T[] | undefined;
  /** Which `sync:completed` events can change this list (`useLibrarySyncRefetch`). */
  syncScope: SyncViewScope;
  /** How long a filter or sort change waits for the next one (`useListFetch`). */
  debounceMs?: number;
  /** The browser's list cache (tests). */
  cache?: ListCache;
}

export interface LibraryList<T> {
  /**
   * The whole listing's rows, `index.total` long: each row whose page has
   * answered, and `undefined` (a placeholder) where none has yet.
   */
  items: readonly (T | undefined)[];
  /** The listing's index — count, A–Z offsets, the header's sums; null until the first page answers. */
  index: ListIndex | null;
  /** No list to show for the current parameters yet — render the skeleton. */
  loading: boolean;
  /**
   * Rows `[start, end]` are on screen: load the pages that hold them (and the
   * lookahead around them). The view's virtualizer calls it as it scrolls.
   */
  requestRange: (start: number, end: number) => void;
  /** Load the list again — `SyncLibraryButton`'s `onSyncComplete`. */
  refetch: () => Promise<void>;
}

/** One listing as held: its index, its loaded pages, and the paging bookkeeping. */
interface Held<T> {
  /** `listCacheKeyFor` of the listing (no page parameters); null before any. */
  key: string | null;
  index: ListIndex | null;
  pages: Map<number, readonly T[]>;
  /** Pages kept across a refresh, shown until they are read again in range. */
  stale: Set<number>;
  inFlight: Set<number>;
  /** Pages whose request failed: asked again only when the range on screen moves. */
  failed: Set<number>;
  /** The list cache's generation when this listing started loading. */
  generation: number;
  /** On screen — false while the skeleton stands in for it. */
  visible: boolean;
}

function emptyHeld<T>(key: string | null, generation: number): Held<T> {
  return {
    key,
    index: null,
    pages: new Map(),
    stale: new Set(),
    inFlight: new Set(),
    failed: new Set(),
    generation,
    visible: false,
  };
}

const NO_ROWS: never[] = [];

/**
 * A library page's list, read a page at a time: the first page and the
 * listing's index (`?index=1`) on mount and on every parameter change
 * (debounced), then each further page as the rows on screen reach it
 * (`requestRange`), refetched when a sync changes it, and refreshed in place.
 * Every request is one page (`LIST_PAGE_SIZE` rows), however large the library.
 *
 * - **Load or refresh.** A fetch for the parameters whose list is on screen (a
 *   sync's refetch, the Sync button, a reconnect's resync) is a refresh: no
 *   skeleton; the first page and the index are read again and swapped in, and
 *   the other pages stay on screen until they are read again as they come into
 *   range, so cards keyed by id stay mounted. Anything else (a new filter,
 *   sort or server) shows the skeleton until its first page answers.
 * - **Coming back.** A listing this tab read recently is shown at once from the
 *   browser's list cache — every page read so far — and refreshed behind when
 *   it is past fresh (`list-cache.ts`).
 * - **Rendering.** The first page of new parameters renders as a normal update;
 *   every later page and every refresh inside `startTransition`.
 * - **Errors.** A failed first page never leaves a loading flag on; the list
 *   stays when it answers the same parameters and is emptied otherwise. A
 *   failed page stays a placeholder and is asked again when the range moves.
 * - **Stale answers.** Only answers for the listing held now are applied.
 */
export function useLibraryList<T, B = unknown>(options: LibraryListOptions<T, B>): LibraryList<T> {
  const { url, params, syncScope, debounceMs, cache = libraryListCache } = options;
  // Sorted and without page parameters, so the same listing is one request.
  const query = sortedQueryString(listingParams(params));
  const selectRef = useRef(options.select);
  useEffect(() => {
    selectRef.current = options.select;
  });

  const [snapshot, setSnapshot] = useState<PagedListSnapshot<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useLatestRequest();
  const held = useRef<Held<T>>(emptyHeld(null, 0));
  const range = useRef<[number, number]>([0, 0]);

  // A dead listing on unmount: answers still in flight find it replaced.
  useEffect(() => {
    return () => {
      latest.cancel();
      held.current = emptyHeld(null, 0);
    };
  }, [latest]);

  const rowsIn = useCallback((body: B): T[] => selectRef.current(body) ?? [], []);

  /** Hand the held listing to the page, and keep it for coming back. */
  const publish = useCallback(
    (h: Held<T>, { urgent = false }: { urgent?: boolean } = {}) => {
      if (!h.index) return;
      const next: PagedListSnapshot<T> = { index: h.index, pages: new Map(h.pages) };
      if (h.key) cache.set(h.key, next, h.generation);
      const update = () => {
        setSnapshot(next);
        setLoading(false);
      };
      // React's standalone `startTransition`, not `useTransition`'s: nothing
      // reads the pending flag, and tracking it re-rendered the whole page.
      if (urgent) update();
      else startTransition(update);
    },
    [cache],
  );

  // Ask for the pages the range on screen needs that are missing or stale. A
  // finished request asks again through the ref (a callback cannot name itself).
  const pumpRef = useRef<() => void>(() => {});
  const pump = useCallback(() => {
    const h = held.current;
    if (!h.index || !h.visible) return;
    const [start, end] = range.current;
    for (const page of pagesForRange(start, end, h.index.total)) {
      if (h.inFlight.size >= MAX_PAGES_IN_FLIGHT) return;
      if (h.inFlight.has(page) || h.failed.has(page)) continue;
      if (h.pages.has(page) && !h.stale.has(page)) continue;
      h.inFlight.add(page);
      const listing = new URLSearchParams(query);
      fetchJson<B & { index?: ListIndex }>(pageUrl(url, listing, page)).then(
        (body) => {
          if (held.current !== h) return;
          h.inFlight.delete(page);
          h.pages.set(page, rowsIn(body));
          h.stale.delete(page);
          // The first page read again carries the index again.
          if (page === 0 && body.index) h.index = body.index;
          publish(h);
          pumpRef.current();
        },
        (error: unknown) => {
          if (held.current !== h) return;
          console.error(`Failed to load page ${page} of ${url}:`, error);
          h.inFlight.delete(page);
          h.failed.add(page);
          pumpRef.current();
        },
      );
    }
  }, [url, query, rowsIn, publish]);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  const requestRange = useCallback(
    (start: number, end: number) => {
      const [prevStart, prevEnd] = range.current;
      range.current = [start, end];
      // A moved range retries what failed before.
      if (start !== prevStart || end !== prevEnd) held.current.failed.clear();
      pump();
    },
    [pump],
  );

  const refetch = useCallback(async () => {
    const token = latest.begin();
    const listing = new URLSearchParams(query);
    const key = listCacheKeyFor(url, listing);
    const generation = cache.generation();
    const previous = held.current;
    const refresh = previous.visible && previous.key === key;

    let h: Held<T>;
    if (refresh) {
      // Everything on screen stays, and is read again as it comes into range.
      h = emptyHeld<T>(key, generation);
      h.index = previous.index;
      h.pages = new Map(previous.pages);
      h.stale = new Set(previous.pages.keys());
      h.visible = true;
    } else {
      h = emptyHeld<T>(key, generation);
      const cached = cache.get<PagedListSnapshot<T>>(key);
      if (cached) {
        h.index = cached.value.index;
        h.pages = new Map(cached.value.pages);
        h.visible = true;
        held.current = h;
        publish(h, { urgent: true });
        if (cached.fresh) {
          pump();
          return;
        }
        // Past fresh: shown, and refreshed behind it like a list on screen.
        h.stale = new Set(h.pages.keys());
      } else {
        setLoading(true);
      }
    }
    held.current = h;
    // Pages the listing held are read again only in range; the first page
    // (with the index) is read now.
    h.inFlight.add(0);
    try {
      const body = await fetchJson<B & { index?: ListIndex }>(pageUrl(url, listing, 0));
      if (!latest.isCurrent(token) || held.current !== h) return;
      h.inFlight.delete(0);
      const rows = rowsIn(body);
      h.pages.set(0, rows);
      h.stale.delete(0);
      // A route that sends no index (none today) is one page long.
      h.index = body.index ?? { total: rows.length };
      const wasVisible = h.visible;
      h.visible = true;
      publish(h, { urgent: !wasVisible });
      pump();
    } catch (error) {
      console.error(`Failed to load ${url}:`, error);
      if (!latest.isCurrent(token) || held.current !== h) return;
      h.inFlight.delete(0);
      if (!h.index) {
        // Nothing to show for these parameters: an empty list, not the
        // previous parameters' rows read as their result.
        h.index = { total: 0 };
        h.pages.clear();
        setSnapshot({ index: h.index, pages: new Map() });
      }
      h.visible = true;
      setLoading(false);
    }
  }, [url, query, cache, latest, rowsIn, publish, pump]);

  useListFetch(refetch, debounceMs);
  useLibrarySyncRefetch(syncScope, refetch);

  const items = useMemo(() => (snapshot ? rowsOf(snapshot) : NO_ROWS), [snapshot]);
  return { items, index: snapshot?.index ?? null, loading, requestRange, refetch };
}
