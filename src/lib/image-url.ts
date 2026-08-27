/**
 * Shared artwork-width vocabulary for the media image proxy.
 *
 * The cache used to bake every image at one 800px variant, but a grid card
 * renders a poster at ~130-190 CSS px and an episode still at ~200-310, so a
 * library page downloaded roughly 5x the bytes it could ever display. Cards now
 * ask for the variant that matches their aspect ratio; detail views keep the
 * 800px default and the hero keeps `CACHE_WIDTH_ART`.
 *
 * The widths are a closed set on purpose: each distinct width is a separate
 * cached file, so an unbounded `?w=` would let a caller spray the cache with
 * arbitrary sizes. This module is deliberately free of node builtins so both
 * the client cards and the route can import it.
 */

/** Poster and square cards (~190 CSS px at the largest card size, 2x DPR). */
export const CACHE_WIDTH_GRID = 400;
/** Landscape cards — episode stills run ~310 CSS px at the largest size. */
export const CACHE_WIDTH_GRID_WIDE = 640;
/** Detail panels, hover popovers and anything that doesn't ask for a width. */
export const CACHE_WIDTH_DEFAULT = 800;
/** Full-bleed backdrop on the detail hero. */
export const CACHE_WIDTH_ART = 1920;

/** Widths a client may request via `?w=`. `CACHE_WIDTH_ART` is not one of
 *  them — it is selected by `?type=art`, not by the caller's own sizing. */
export const REQUESTABLE_CACHE_WIDTHS: readonly number[] = [
  CACHE_WIDTH_GRID,
  CACHE_WIDTH_GRID_WIDE,
  CACHE_WIDTH_DEFAULT,
];

/** Every width that can end up on disk for a single artwork URL. Invalidation
 *  must purge all of them — the cache key is derived from the *normalized*
 *  URL, so a Plex artwork swap reuses the same key and a variant left behind
 *  would keep serving the old image until the TTL expires. */
export const ALL_CACHE_WIDTHS: readonly number[] = [
  CACHE_WIDTH_GRID,
  CACHE_WIDTH_GRID_WIDE,
  CACHE_WIDTH_DEFAULT,
  CACHE_WIDTH_ART,
];

/**
 * Parse a `?w=` value against the allow-list. Returns null for anything not
 * explicitly permitted (missing, malformed, or an unsupported size) so the
 * caller falls back to the default width.
 */
export function parseImageWidth(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const width = Number(raw);
  return REQUESTABLE_CACHE_WIDTHS.includes(width) ? width : null;
}

/**
 * Append `w=<width>` to an image-proxy URL.
 *
 * Only rewrites the app's own `/api/` URLs — an absolute or external src is
 * returned untouched. An explicit `w=` already on the URL wins, so a caller
 * that sized itself isn't overridden.
 */
export function withImageWidth(url: string, width: number): string {
  if (!url.startsWith("/api/")) return url;
  if (/[?&]w=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}
