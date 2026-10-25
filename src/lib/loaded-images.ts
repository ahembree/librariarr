/**
 * Artwork URLs this tab has already loaded, so a view about to show a larger
 * copy of the same poster can paint the smaller one first: the grid loaded the
 * 400px card variant, and the detail page's 800px poster used to leave an
 * empty box until it arrived. Only a URL the browser actually loaded here is
 * offered — on a direct visit the small variant would be a second request
 * (and, uncached on the server, a resize) for a placeholder.
 *
 * Bounded: the oldest URLs are forgotten first, which only costs a placeholder.
 */

import { CACHE_WIDTH_GRID, CACHE_WIDTH_GRID_WIDE, withImageWidth } from "@/lib/image-url";

const MAX_URLS = 5000;

const loaded = new Set<string>();

export function markImageLoaded(url: string | null | undefined): void {
  if (!url) return;
  // Re-inserting moves the URL to the newest end.
  loaded.delete(url);
  loaded.add(url);
  while (loaded.size > MAX_URLS) {
    const oldest = loaded.values().next().value;
    if (oldest === undefined) break;
    loaded.delete(oldest);
  }
}

export function wasImageLoaded(url: string): boolean {
  return loaded.has(url);
}

/** The first of `candidates` this tab has loaded, or null. */
export function firstLoadedImage(candidates: readonly string[]): string | null {
  return candidates.find((url) => loaded.has(url)) ?? null;
}

export function __resetLoadedImages(): void {
  loaded.clear();
}

/**
 * A grid-width copy of `url` (the poster and the landscape card widths) that
 * this tab has loaded, or null — and null for a URL that already names a width.
 */
export function posterPlaceholderFor(url: string): string | null {
  if (/[?&]w=/.test(url)) return null;
  return firstLoadedImage([withImageWidth(url, CACHE_WIDTH_GRID), withImageWidth(url, CACHE_WIDTH_GRID_WIDE)]);
}
