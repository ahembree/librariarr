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
export const FORWARD_AUTH_PROXY_HEADER = "x-librariarr-proxy-secret";

/**
 * Whether the request may use forward-auth: true when `FORWARD_AUTH_SECRET` is
 * unset or empty, otherwise only when the proxy header carries the same value.
 */
export function hasForwardAuthSecret(headers: Headers): boolean {
  const configured = process.env.FORWARD_AUTH_SECRET;
  if (!configured) return true;
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
