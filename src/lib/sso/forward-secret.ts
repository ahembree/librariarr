import { timingSafeEqual } from "node:crypto";

/**
 * Forward-auth trusts an identity header its reverse proxy injects, which is
 * only safe while that proxy is the only way to reach the app. When the app's
 * port is also reachable directly — published on every interface, or reachable
 * from another container — anyone who can reach it can send the header
 * themselves and sign in as the linked admin.
 *
 * `FORWARD_AUTH_SECRET` closes that without depending on the network layout:
 * when it is set, a forward-auth login must also carry this header with the
 * same value, which only the proxy is configured to send. Unset, forward-auth
 * behaves as before (opt-in, so an existing setup keeps signing in until its
 * proxy is configured).
 */
export const FORWARD_AUTH_SECRET_HEADER = "x-librariarr-proxy-secret";

export function forwardAuthSecretConfigured(): boolean {
  return (process.env.FORWARD_AUTH_SECRET ?? "") !== "";
}

/**
 * Whether the request may use forward-auth: true when no secret is
 * configured, otherwise only when the header matches it. The comparison is
 * constant-time over the value; only a length mismatch returns early, and the
 * length is not the secret.
 */
export function hasForwardAuthSecret(headers: Headers): boolean {
  const expected = Buffer.from(process.env.FORWARD_AUTH_SECRET ?? "", "utf8");
  if (expected.length === 0) return true;
  const presented = Buffer.from(headers.get(FORWARD_AUTH_SECRET_HEADER) ?? "", "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
