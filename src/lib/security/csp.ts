/**
 * The app's Content-Security-Policy, in one place: `src/proxy.ts` sends it on
 * every page with a fresh nonce, and `next.config.ts` sends the nonce-less form
 * on API responses. Alias- and dependency-free, since `next.config.ts` imports
 * it by relative path.
 *
 * Pages allow scripts by NONCE, not `'unsafe-inline'`: the proxy generates one
 * per request and passes it to Next.js in the request's own
 * `Content-Security-Policy` header, which is where Next.js reads it from to
 * stamp its bootstrap and chunk scripts (`get-script-nonce-from-header`).
 * `'strict-dynamic'` then lets those trusted scripts load the rest of the
 * bundle (lazy chunks, the Swagger UI bundle). Under it a CSP3 browser ignores
 * `'self'` and `'unsafe-inline'` for scripts; both stay listed only as the
 * fallback for a browser without nonce support. An injected inline script has
 * no nonce and does not run.
 *
 * A nonce has to be in the HTML, so every page renders per request — the root
 * layout opts in with `connection()`. Every signed-in page already did (the
 * layout reads the session cookie); only the login pages were static.
 */

export interface PageCspOptions {
  /** The request's nonce. Omitted for responses that carry no HTML (API). */
  nonce?: string;
  /** `next dev`: React Refresh evaluates source maps with `eval`. */
  dev?: boolean;
}

export function buildCsp({ nonce, dev = false }: PageCspOptions = {}): string {
  const script = nonce
    ? ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'unsafe-inline'"]
    : ["'self'", "'unsafe-inline'"];
  if (dev) script.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self' https://plex.tv https://app.plex.tv",
    "frame-ancestors 'none'",
    // Not covered by default-src: without these an injected <base> could
    // re-point every relative URL, an injected <form> could post to another
    // origin, and <object>/<embed> would load same-origin plugin content. The
    // app uses none of them (SSO starts from a link, Plex from a popup, every
    // form submits via fetch).
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** A fresh nonce: 16 random bytes, base64. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
