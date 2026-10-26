/**
 * A short-lived store of GET responses the media detail views are about to
 * need, so a request can start before the component that reads it mounts.
 *
 * Two gaps it closes:
 *
 * - A detail page fetched its record, rendered, and only then did the play
 *   history and the Arr/Seerr cards mount and ask for theirs — two round trips
 *   before the page was complete, though every one of those requests needs only
 *   the id in the URL. The page now starts them all at once
 *   (`prefetchMediaDetail`) and each component takes its answer from here.
 * - The hover popover fetched the item's record for its summary and threw the
 *   rest away; a click a moment later fetched the same record again. The
 *   popover now reads through `peek`, which keeps the answer for the click.
 *
 * `take` hands an entry over ONCE and forgets it: the first reader gets the
 * prefetched answer, every later read (a refetch after a sync, a page change)
 * goes to the network as before. Entries expire after `ttlMs` so a stale
 * prefetch is never served, and only successful answers are kept — an error
 * status or a failed request is dropped, so the reader asks again.
 */

export interface PrefetchedJson<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
}

interface Entry {
  promise: Promise<PrefetchedJson>;
  expiresAt: number;
}

export interface PrefetchStore {
  /** Start `url` if no live entry holds it. */
  prefetch(url: string): void;
  /** The live entry for `url`, started if missing, and kept for a later `take`. */
  peek<T = unknown>(url: string): Promise<PrefetchedJson<T>>;
  /** The live entry for `url`, removed from the store, or null. */
  take<T = unknown>(url: string): Promise<PrefetchedJson<T>> | null;
  /** `take(url)`, else a plain request that is not stored. */
  fetch<T = unknown>(url: string): Promise<PrefetchedJson<T>>;
  clear(): void;
  /** Forget every entry whose URL `drop` accepts. */
  clearWhere(drop: (url: string) => boolean): void;
}

async function requestJson(url: string): Promise<PrefetchedJson> {
  try {
    const res = await fetch(url);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

export function createPrefetchStore(
  ttlMs: number,
  maxEntries: number,
  now: () => number = Date.now,
): PrefetchStore {
  const entries = new Map<string, Entry>();

  function live(url: string): Entry | undefined {
    const entry = entries.get(url);
    if (!entry) return undefined;
    if (now() > entry.expiresAt) {
      entries.delete(url);
      return undefined;
    }
    return entry;
  }

  function start(url: string): Entry {
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    const promise = requestJson(url);
    const entry: Entry = { promise, expiresAt: now() + ttlMs };
    entries.set(url, entry);
    void promise.then((result) => {
      // An error is not worth keeping: the reader should ask again.
      if (!result.ok && entries.get(url) === entry) entries.delete(url);
    });
    return entry;
  }

  function take<T>(url: string): Promise<PrefetchedJson<T>> | null {
    const entry = live(url);
    if (!entry) return null;
    entries.delete(url);
    return entry.promise as Promise<PrefetchedJson<T>>;
  }

  return {
    prefetch(url) {
      if (!live(url)) start(url);
    },
    peek<T>(url: string) {
      return (live(url) ?? start(url)).promise as Promise<PrefetchedJson<T>>;
    },
    take,
    fetch<T>(url: string) {
      return take<T>(url) ?? (requestJson(url) as Promise<PrefetchedJson<T>>);
    },
    clear() {
      entries.clear();
    },
    clearWhere(drop) {
      for (const url of [...entries.keys()]) if (drop(url)) entries.delete(url);
    },
  };
}

/**
 * Thirty seconds: long enough for a hover to become a click and for a page's
 * components to mount, short enough that nothing shown is older than a glance.
 */
export const DETAIL_PREFETCH_TTL_MS = 30_000;

export const detailPrefetch = createPrefetchStore(DETAIL_PREFETCH_TTL_MS, 100);

/** The play history card's first page — the URL `PlayHistory` asks for. */
export const PLAY_HISTORY_PAGE_SIZE = 5;

export function mediaRecordUrl(id: string): string {
  return `/api/media/${id}`;
}

export function mediaPlaysUrl(id: string, page: number, serverId?: string): string {
  const params = new URLSearchParams({ page: String(page), limit: String(PLAY_HISTORY_PAGE_SIZE) });
  if (serverId) params.set("serverId", serverId);
  return `/api/media/${id}/plays?${params}`;
}

export function arrInfoUrl(id: string): string {
  return `/api/media/${id}/arr-info`;
}

export function seerrInfoUrl(id: string): string {
  return `/api/media/${id}/seerr-info`;
}

/**
 * The list a grouped detail page shows under its record: a show's seasons, a
 * season's episodes, an album's tracks, an artist's albums.
 */
export type DetailChildList = "seasons" | "episodes" | "tracks" | "albums";

/**
 * A detail page's child list, named by the page's own id (`?itemId=`). The
 * routes read the series, season, album or artist from that record
 * themselves, so the list is asked for beside the record instead of after it
 * arrives — the pages built the URL from the record's fields and so waited a
 * whole round trip. The episode and track lists keep the order and the
 * `limit=0` the pages always sent (a parent bounds them; there is nothing to
 * page).
 */
export function detailChildrenUrl(kind: DetailChildList, id: string): string {
  const itemId = encodeURIComponent(id);
  switch (kind) {
    case "seasons":
      return `/api/media/series/seasons?itemId=${itemId}`;
    case "episodes":
      return `/api/media/series?itemId=${itemId}&sortBy=episodeNumber&sortOrder=asc&limit=0`;
    case "tracks":
      return `/api/media/music?itemId=${itemId}&sortBy=episodeNumber&sortOrder=asc&limit=0`;
    case "albums":
      return `/api/media/music/albums?itemId=${itemId}`;
  }
}

/**
 * Forget what a change to the media can make stale: item records (titles,
 * streams, play counts) and play history pages. The Arr and Seerr matches are
 * kept — a library sync or a new play changes neither, and they are the costly
 * ones (live calls to every instance) that a detail page still loading has
 * just started and is about to take.
 */
export function dropMediaDerivedPrefetches(): void {
  detailPrefetch.clearWhere((url) => !/\/(arr|seerr)-info$/.test(url));
}

/** Warm the item's record — a card the pointer rests on, a row about to open. */
export function prefetchMediaRecord(id: string): void {
  detailPrefetch.prefetch(mediaRecordUrl(id));
}

/**
 * Everything a detail page reads that needs only the id, started together.
 * `plays` is the per-item play history (movie and track pages; an episode's is
 * scoped by series identity, which only its record carries). `integrations`
 * (default true) is the Arr/Seerr cards, which a grouped artist view does not
 * show. Seerr knows no music. `children` is the page's child list
 * (`detailChildrenUrl`), which the show, season, artist and album pages list.
 */
export function prefetchMediaDetail(
  id: string,
  options: {
    mediaType: "MOVIE" | "SERIES" | "MUSIC";
    plays: boolean;
    integrations?: boolean;
    children?: DetailChildList;
  },
): void {
  detailPrefetch.prefetch(mediaRecordUrl(id));
  if (options.children) detailPrefetch.prefetch(detailChildrenUrl(options.children, id));
  if (options.integrations !== false) {
    detailPrefetch.prefetch(arrInfoUrl(id));
    if (options.mediaType !== "MUSIC") detailPrefetch.prefetch(seerrInfoUrl(id));
  }
  if (options.plays) detailPrefetch.prefetch(mediaPlaysUrl(id, 1));
}
