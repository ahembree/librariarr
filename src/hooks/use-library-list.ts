"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { useListFetch } from "@/hooks/use-list-fetch";
import { useLibrarySyncRefetch } from "@/hooks/use-library-sync-refetch";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import { fetchJson, libraryListCache, listCacheKeyFor, type ListCache } from "@/lib/media/list-cache";
import type { ListIndex } from "@/lib/media/list-index";
import {
  LIST_PAGE_SIZE,
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
  /** The route and listing query (sorted, no page parameters) every page of it is read with. */
  url: string;
  query: string;
  /** `listCacheKeyFor` of the listing; null for the dead listing before any. */
  key: string | null;
  index: ListIndex | null;
  pages: Map<number, readonly T[]>;
  /**
   * Pages kept across a refresh: shown until they are read again in range,
   * never stored in the list cache (they predate what the cache's clear was for).
   */
  stale: Set<number>;
  /** Page requests in flight, each aborted once the range on screen no longer needs it. */
  inFlight: Map<number, AbortController>;
  /** Pages whose request failed: when each may be asked again, and how often it failed. */
  failed: Map<number, { retryAt: number; attempts: number }>;
  /** The list cache's generation when this listing started loading. */
  generation: number;
  /** When the index this listing shows was read: its age in the list cache. */
  readAt: number;
  /** On screen — false while the skeleton stands in for it. */
  visible: boolean;
}

function emptyHeld<T>(url: string, query: string, key: string | null, generation: number): Held<T> {
  return {
    url,
    query,
    key,
    index: null,
    pages: new Map(),
    stale: new Set(),
    inFlight: new Map(),
    failed: new Map(),
    generation,
    readAt: 0,
    visible: false,
  };
}

/** Stop every request a listing has in flight — it was replaced. */
function abortAll<T>(h: Held<T>): void {
  for (const controller of h.inFlight.values()) controller.abort();
  h.inFlight.clear();
}

/** How long a failed page waits before it is asked again: 2 s, doubling, at most a minute. */
export function pageRetryDelay(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * The events, besides `sync:completed` (`useLibrarySyncRefetch`), after which
 * the server has dropped its listings (`invalidateMediaCaches`) and the shell
 * the tab's list cache. A listing on screen is refreshed in place: its later
 * pages would otherwise be read from the changed listing — a play moving an
 * item in a Last Played sort — and stitched onto pages read before it.
 */
const MEDIA_CHANGE_EVENTS = ["sync:failed", "watch-history:updated", "server:changed", "settings:changed"] as const;

const NO_ROWS: never[] = [];

/**
 * A library page's list, read a page at a time: the first page and the
 * listing's index (`?index=1`) on mount and on every parameter change
 * (debounced), then each further page as the rows on screen reach it
 * (`requestRange`), refetched when a sync changes it, and refreshed in place.
 * Every request is one page (`LIST_PAGE_SIZE` rows), however large the library.
 *
 * - **Load or refresh.** A fetch for the parameters whose list is on screen (a
 *   sync's refetch, the Sync button, a reconnect's resync, any other event
 *   that changes the media — `MEDIA_CHANGE_EVENTS`) is a refresh: no
 *   skeleton; the first page and the index are read again and swapped in, and
 *   the other pages stay on screen until they are read again as they come into
 *   range, so cards keyed by id stay mounted. Anything else (a new filter,
 *   sort or server) shows the skeleton until its first page answers.
 * - **Paging.** Pages are read with the held listing's own query, so a page
 *   asked for while a new filter waits out its debounce still belongs to the
 *   list on screen. The pages nearest the middle of the range on screen go
 *   first, at most `MAX_PAGES_IN_FLIGHT` at once, and a request the range has
 *   scrolled away from is aborted to free its slot.
 * - **Coming back.** A listing this tab read recently is shown at once from the
 *   browser's list cache — every page read since its index — and refreshed
 *   behind when it is past fresh (`list-cache.ts`). It keeps the age of its
 *   index there, however many pages are added to it.
 * - **Rendering.** The first page of new parameters renders as a normal update;
 *   every later page and every refresh inside `startTransition`.
 * - **Errors.** A failed first page never leaves a loading flag on; the list
 *   stays when it answers the same parameters and is emptied otherwise. A
 *   failed page stays a placeholder and is asked again after `pageRetryDelay`.
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
  const held = useRef<Held<T>>(emptyHeld("", "", null, 0));
  const range = useRef<[number, number]>([0, 0]);

  // A dead listing on unmount: answers still in flight find it replaced.
  useEffect(() => {
    return () => {
      latest.cancel();
      abortAll(held.current);
      held.current = emptyHeld("", "", null, 0);
    };
  }, [latest]);

  const rowsIn = useCallback((body: B): T[] => selectRef.current(body) ?? [], []);

  /**
   * Hand the held listing to the page, and keep it for coming back — without
   * the pages kept from before a refresh, and at the age of its index.
   */
  const publish = useCallback(
    (h: Held<T>, { urgent = false, store = true }: { urgent?: boolean; store?: boolean } = {}) => {
      if (!h.index) return;
      const next: PagedListSnapshot<T> = { index: h.index, pages: new Map(h.pages) };
      if (store && h.key) {
        const read = new Map([...h.pages].filter(([page]) => !h.stale.has(page)));
        cache.set(h.key, { index: h.index, pages: read }, h.generation, h.readAt);
      }
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
    const centre = Math.floor((start + end) / 2 / LIST_PAGE_SIZE);
    const wanted = pagesForRange(start, end, h.index.total).sort(
      (a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b,
    );
    // A request the range has left frees its slot (the first page, read with
    // the index by `refetch`, is never one of them).
    for (const [page, controller] of h.inFlight) {
      if (page !== 0 && !wanted.includes(page)) {
        controller.abort();
        h.inFlight.delete(page);
      }
    }
    const now = Date.now();
    for (const page of wanted) {
      if (h.inFlight.size >= MAX_PAGES_IN_FLIGHT) return;
      if (h.inFlight.has(page)) continue;
      if ((h.failed.get(page)?.retryAt ?? 0) > now) continue;
      if (h.pages.has(page) && !h.stale.has(page)) continue;
      const controller = new AbortController();
      h.inFlight.set(page, controller);
      fetchJson<B & { index?: ListIndex }>(pageUrl(h.url, new URLSearchParams(h.query), page), controller.signal).then(
        (body) => {
          if (held.current !== h || h.inFlight.get(page) !== controller) return;
          h.inFlight.delete(page);
          h.failed.delete(page);
          h.pages.set(page, rowsIn(body));
          h.stale.delete(page);
          // The first page read again carries the index again.
          if (page === 0 && body.index) {
            h.index = body.index;
            h.readAt = Date.now();
          }
          publish(h);
          pumpRef.current();
        },
        (error: unknown) => {
          if (held.current !== h || h.inFlight.get(page) !== controller) return;
          console.error(`Failed to load page ${page} of ${h.url}:`, error);
          h.inFlight.delete(page);
          const attempts = (h.failed.get(page)?.attempts ?? 0) + 1;
          const delay = pageRetryDelay(attempts);
          h.failed.set(page, { retryAt: Date.now() + delay, attempts });
          setTimeout(() => {
            if (held.current === h) pumpRef.current();
          }, delay);
          pumpRef.current();
        },
      );
    }
  }, [rowsIn, publish]);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  const requestRange = useCallback(
    (start: number, end: number) => {
      range.current = [start, end];
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
    // The previous listing's requests answer nothing anyone will read.
    abortAll(previous);

    let h: Held<T>;
    if (refresh) {
      // Everything on screen stays, and is read again as it comes into range.
      h = emptyHeld<T>(url, query, key, generation);
      h.index = previous.index;
      h.pages = new Map(previous.pages);
      h.stale = new Set(previous.pages.keys());
      h.readAt = previous.readAt;
      h.visible = true;
    } else {
      // Another listing: the range on screen is the new view's to report.
      range.current = [0, 0];
      h = emptyHeld<T>(url, query, key, generation);
      const cached = cache.get<PagedListSnapshot<T>>(key);
      if (cached) {
        h.index = cached.value.index;
        h.pages = new Map(cached.value.pages);
        h.readAt = cached.storedAt;
        h.visible = true;
        held.current = h;
        // Shown as it was kept, and not stored again: that would make it younger.
        publish(h, { urgent: true, store: false });
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
    const controller = new AbortController();
    h.inFlight.set(0, controller);
    try {
      const body = await fetchJson<B & { index?: ListIndex }>(pageUrl(url, listing, 0), controller.signal);
      if (!latest.isCurrent(token) || held.current !== h) return;
      h.inFlight.delete(0);
      const rows = rowsIn(body);
      h.pages.set(0, rows);
      h.stale.delete(0);
      // A route that sends no index (none today) is one page long.
      h.index = body.index ?? { total: rows.length };
      h.readAt = Date.now();
      const wasVisible = h.visible;
      h.visible = true;
      publish(h, { urgent: !wasVisible });
      pump();
    } catch (error) {
      if (!latest.isCurrent(token) || held.current !== h) return;
      console.error(`Failed to load ${url}:`, error);
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
  // An event only: a reconnect's resync (no `timestamp`) is
  // `useLibrarySyncRefetch`'s already.
  useRealtimeEvents(MEDIA_CHANGE_EVENTS, (data) => {
    if (typeof data.timestamp === "number" && held.current.visible) void refetch();
  });

  const items = useMemo(() => (snapshot ? rowsOf(snapshot) : NO_ROWS), [snapshot]);
  return { items, index: snapshot?.index ?? null, loading, requestRange, refetch };
}
