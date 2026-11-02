/**
 * Whether a page request is the browser loading a document (typing the URL, a
 * reload, a PWA launch) rather than the Next.js router fetching the page's RSC
 * payload for a client-side navigation or a prefetch.
 *
 * Next.js removes its own `RSC` header before a page renders, so a page cannot
 * read it from `headers()`. The browser's own marking stays: a document load
 * says `Sec-Fetch-Dest: document`, a router fetch `empty`. A browser too old to
 * send Fetch Metadata is told apart by `Accept`, which only a document load
 * fills with `text/html`.
 */
export function isDocumentRequest(headers: { get(name: string): string | null }): boolean {
  const dest = headers.get("sec-fetch-dest");
  if (dest !== null) return dest === "document";
  return (headers.get("accept") ?? "").includes("text/html");
}
