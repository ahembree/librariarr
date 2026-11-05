/**
 * Whether a request most likely comes from a phone, from its user agent (and
 * Chromium's `Sec-CH-UA-Mobile` hint where sent). The server cannot see the
 * screen, and rendered every page in the desktop layout — its 248px sidebar
 * squeezing the page into the last third of a phone's screen until the page
 * had hydrated and switched to the phone layout. A wrong guess (a phone-sized
 * tablet, a narrowed desktop window) switches after hydration exactly as
 * every phone used to.
 *
 * Tablets are left out: iPadOS sends a desktop user agent, an Android tablet
 * leaves "Mobile" out, and both are at least 768px wide, the desktop layout.
 */
export function isLikelyPhone(userAgent: string | null, uaMobileHint: string | null): boolean {
  if (uaMobileHint === "?1") return true;
  if (!userAgent) return false;
  if (/iPhone|iPod/.test(userAgent)) return true;
  return /Android/.test(userAgent) && /Mobile/.test(userAgent);
}
