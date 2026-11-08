/**
 * A library listing held a page at a time: what `useLibraryList` keeps, asks
 * for and hands the pages. Client-safe and free of React, so the paging rules
 * are tested on their own.
 *
 * The library pages used to load whole libraries (`limit=0`): a first
 * screenful, then everything after it — tens of MB on a large library, every
 * byte of it queried, serialised, compressed, sent and parsed whether or not
 * anyone scrolled to it. Now the first page carries the listing's `index`
 * (`src/lib/media/list-index.ts`: the row count, the A–Z offsets, the header's
 * sums), the virtualizers render that many rows, and each page of
 * `LIST_PAGE_SIZE` rows is asked for when the rows on screen reach it. Every
 * response is one page, however large the library.
 */

import type { ListIndex } from "@/lib/media/list-index";

/**
 * Rows per request. Within every listing route's cap (`MAX_LIST_LIMIT` 100,
 * the grouped `MAX_GROUPED_LIST_LIMIT` 200), and more than a viewport holds at
 * any card size or table density.
 */
export const LIST_PAGE_SIZE = 100;

/**
 * Rows past each end of the range on screen whose pages are asked for too, so
 * scrolling at a reading pace finds the next page already there.
 */
export const LIST_LOOKAHEAD_ROWS = 50;

/** Page requests in flight at once; a range past them waits for one to finish. */
export const MAX_PAGES_IN_FLIGHT = 3;

/** The parameters that pick a page; a page's caller never chooses them. */
const PAGE_PARAMS = ["page", "limit", "offset", "index"];

/** The listing's parameters without any page parameter — the list's identity. */
export function listingParams(params: URLSearchParams): URLSearchParams {
  const listing = new URLSearchParams(params);
  for (const param of PAGE_PARAMS) listing.delete(param);
  return listing;
}

/**
 * The URL of page `page` (0-based) of a listing. The first page always asks
 * for the index too, so every first page is one URL (and one entry of the
 * server's response cache).
 */
export function pageUrl(url: string, params: URLSearchParams, page: number, pageSize = LIST_PAGE_SIZE): string {
  const query = listingParams(params);
  query.set("limit", String(pageSize));
  query.set("offset", String(page * pageSize));
  if (page === 0) query.set("index", "1");
  return `${url}?${query}`;
}

/** The pages holding rows `[start, end]` and the lookahead around them, within a list of `total` rows. */
export function pagesForRange(
  start: number,
  end: number,
  total: number,
  { pageSize = LIST_PAGE_SIZE, lookahead = LIST_LOOKAHEAD_ROWS }: { pageSize?: number; lookahead?: number } = {},
): number[] {
  if (total <= 0 || end < start) return [];
  const first = Math.max(0, Math.floor((start - lookahead) / pageSize));
  const last = Math.min(Math.ceil(total / pageSize) - 1, Math.floor((end + lookahead) / pageSize));
  const pages: number[] = [];
  for (let page = first; page <= last; page++) pages.push(page);
  return pages;
}

/**
 * A listing as far as it has been read: its index and the pages loaded so
 * far, keyed by page number. What the browser's list cache keeps for a page
 * coming back to it.
 */
export interface PagedListSnapshot<T> {
  index: ListIndex;
  pages: ReadonlyMap<number, readonly T[]>;
}

/**
 * The rows for the virtualizers: `index.total` long, each loaded page's rows
 * in place and `undefined` where no page has answered yet (a placeholder).
 * A page answered before the list shrank may reach past the end; it is cut.
 */
export function rowsOf<T>(snapshot: PagedListSnapshot<T>, pageSize = LIST_PAGE_SIZE): (T | undefined)[] {
  const total = snapshot.index.total;
  // Filled, not sparse: `map`/`some` skip holes, and a placeholder must be visited.
  const rows = new Array<T | undefined>(total).fill(undefined);
  for (const [page, pageRows] of snapshot.pages) {
    const offset = page * pageSize;
    for (let i = 0; i < pageRows.length && offset + i < total; i++) rows[offset + i] = pageRows[i];
  }
  return rows;
}

/** The rows of a flat listing's page (`items`) — `useLibraryList`'s `select` for movies, episodes and tracks. */
export function selectListItems<T>(body: { items?: T[] }): T[] | undefined {
  return body.items;
}
