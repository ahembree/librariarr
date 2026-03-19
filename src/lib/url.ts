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
