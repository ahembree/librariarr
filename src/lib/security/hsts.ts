/**
 * `Strict-Transport-Security`, when the operator asks for it.
 *
 * Off unless `HSTS_MAX_AGE` (seconds) is set, on purpose. HSTS binds a HOST
 * NAME, every port of it: sent from `https://nas.lan`, it makes the browser
 * refuse `http://nas.lan:8989` — the Sonarr next door — for as long as the
 * policy lasts, and nothing served from this app can take that back. Only the
 * operator knows whether everything on the name is https. A reverse proxy
 * that already sends the header needs nothing here.
 *
 * Sent only on a request that arrived over https (a browser ignores it over
 * http, and a response there could be anyone's), and never with
 * `includeSubDomains`: sibling subdomains on plain http are the ordinary
 * homelab layout. Alias- and Node-free: `src/proxy.ts` imports it.
 */

/** Two years — the longest value worth accepting; anything above is clamped. */
export const HSTS_MAX_AGE_LIMIT = 63_072_000;

/** The header value for this environment, or `null` when HSTS is not asked for. */
export function hstsHeaderValue(raw: string | undefined = process.env.HSTS_MAX_AGE): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Math.min(Number(trimmed), HSTS_MAX_AGE_LIMIT);
  if (seconds <= 0) return null;
  return `max-age=${seconds}`;
}
