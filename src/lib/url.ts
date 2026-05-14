import type { NextRequest } from "next/server";

/**
 * Build the external base URL for redirects.
 *
 * Forwarded headers (x-forwarded-host, x-forwarded-proto) are always trusted
 * here because they cannot cause an open redirect — browsers never send them,
 * so a spoofing attacker would only redirect themselves, not a victim.
 *
 * Works in all deployment topologies:
 *  - HTTPS reverse proxy (Nginx/Traefik/Caddy, Docker or host)
 *  - HTTP reverse proxy
 *  - Chained proxies (comma-separated header values)
 *  - Direct access (localhost or LAN IP, no proxy)
 */
interface SameOriginOptions {
  /**
   * When true, requests with NEITHER Origin NOR Referer are rejected. Use for
   * routes that are only ever reached via in-app button/anchor (e.g.
   * `/api/auth/sso/forward`) — the no-headers case there is only reachable
   * via an attacker page setting `Referrer-Policy: no-referrer`.
   *
   * Default false, which permits no-header requests (address-bar navigation,
   * server-side redirects like the auth layout's redirect to /logout when
   * the session is invalid).
   */
  strict?: boolean;
}

/**
 * Verify the request originates from the same site as the app itself.
 *
 * For GET endpoints that mutate session state (logout, forward-auth login),
 * `SameSite=Lax` cookies are sent on top-level cross-site navigations, so an
 * attacker site can force-trigger the endpoint via a link or window.location.
 * Checking Origin (or Referer as a fallback) is the standard mitigation.
 *
 * Returns true when:
 *  - Origin matches the external base URL, OR
 *  - Origin is absent and Referer matches, OR
 *  - (Non-strict only) Both Origin and Referer are absent — direct address-
 *    bar navigation or server-side redirect. An attacker page with
 *    `Referrer-Policy: no-referrer` can produce no-header requests too, so
 *    routes that aren't reached via address-bar should pass `strict: true`.
 */
export function isSameOriginRequest(
  request: NextRequest,
  options: SameOriginOptions = {}
): boolean {
  const expectedBase = getExternalBaseUrl(request);
  const origin = request.headers.get("origin");
  if (origin) return origin === expectedBase;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const r = new URL(referer);
      return `${r.protocol}//${r.host}` === expectedBase;
    } catch {
      return false;
    }
  }
  // Neither header present. In strict mode this is suspicious (attacker
  // pages can strip Referer via Referrer-Policy: no-referrer); in lenient
  // mode it's the address-bar / server-redirect case.
  return !options.strict;
}

export function getExternalBaseUrl(request: NextRequest): string {
  // x-forwarded-host is added by reverse proxies; take the first value
  // when multiple proxies are chained (comma-separated).
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    new URL(request.url).host;

  // x-forwarded-proto tells us whether SSL was terminated upstream.
  // Without it, infer from the raw request URL (http when hitting Next.js directly).
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    new URL(request.url).protocol.replace(":", "");

  return `${proto}://${host}`;
}
