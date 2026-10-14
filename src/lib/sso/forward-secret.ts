import { timingSafeEqual } from "node:crypto";

/**
 * Forward-auth trusts an identity header its reverse proxy injects, which is
 * only safe while that proxy is the only way to reach the app. When the app's
 * port is also reachable directly — published on every interface, or reachable
 * from another container — anyone who can reach it can send the header
 * themselves and sign in as the linked admin; and a stolen cookie can confirm
 * "it's you" the same way (`/api/auth/reauth/forward`), the linked subject
 * being readable from `/api/settings/sso/me`.
 *
 * `FORWARD_AUTH_SECRET` closes that without depending on the network layout: a
 * forward-auth sign-in must also carry this header with the same value, which
 * only the proxy is configured to send. It is REQUIRED for forward-auth —
 * `isSsoUsable` reads forward-auth as not configured without it, so the login
 * page offers no SSO button, the settings page refuses to turn it on, and the
 * login and confirmation routes refuse with `forward_auth_unconfigured` — not
 * opt-in, because the safe setup has to be the one an install gets by default
 * and "block the port at the firewall" is a step nothing checks.
 */
export const FORWARD_AUTH_PROXY_HEADER = "x-librariarr-proxy-secret";

/** Whether `FORWARD_AUTH_SECRET` is set to a non-empty value. */
export function isForwardAuthSecretConfigured(): boolean {
  return !!process.env.FORWARD_AUTH_SECRET;
}

/**
 * Whether the request came through the proxy: `FORWARD_AUTH_SECRET` is set and
 * the proxy header carries the same value. Always false while it is unset —
 * forward-auth is not usable then, and a route that reaches this check anyway
 * must refuse.
 */
export function hasForwardAuthSecret(headers: Headers): boolean {
  const configured = process.env.FORWARD_AUTH_SECRET;
  if (!configured) return false;
  return matchesConfigured(
    Buffer.from(headers.get(FORWARD_AUTH_PROXY_HEADER) ?? "", "utf8"),
    Buffer.from(configured, "utf8"),
  );
}

/**
 * One constant-time comparison that covers both the length and the bytes.
 * Each side is written as its length (4 bytes) followed by at most
 * `configured.length` bytes of its value, into buffers sized from the
 * configured value alone, so a value of another length fails on the length
 * field inside `timingSafeEqual` rather than on a separate check before it.
 * The usual `a.length === b.length && timingSafeEqual(a, b)` returns early on
 * a length mismatch, which tells a caller how long the secret is.
 */
function matchesConfigured(presented: Buffer, configured: Buffer): boolean {
  const left = Buffer.alloc(4 + configured.length);
  const right = Buffer.alloc(4 + configured.length);
  left.writeUInt32BE(presented.length, 0);
  presented.copy(left, 4, 0, configured.length);
  right.writeUInt32BE(configured.length, 0);
  configured.copy(right, 4);
  return timingSafeEqual(left, right);
}
