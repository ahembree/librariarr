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
/**
 * Verify the request originates from the same site as the app itself.
 *
 * For GET endpoints that mutate session state (logout, forward-auth login),
 * `SameSite=Lax` cookies are sent on top-level cross-site navigations, so an
 * attacker site can force-trigger the endpoint via a link or window.location.
 * Checking Origin (or Referer as a fallback) is the standard mitigation.
 *
 * Returns true when:
 *  - No Origin/Referer is present (likely a direct address-bar navigation —
 *    can't be triggered cross-site)
 *  - Origin/Referer matches the external base URL
 */
export function isSameOriginRequest(request: NextRequest): boolean {
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
  // No Origin and no Referer — accept. Direct address-bar navigations,
  // server-side redirects (e.g. the authenticated layout redirecting to
  // /api/auth/logout when the session is invalid), and most curl-style
  // probes fall here. Cross-site attacks always carry one or the other.
  return true;
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
