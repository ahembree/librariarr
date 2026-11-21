/**
 * Utilities for sanitizing sensitive data from API responses.
 */

const SENSITIVE_FIELDS = new Set([
  "accessToken",
  "apiKey",
  "plexToken",
  "passwordHash",
  "backupEncryptionPassword",
  "oidcClientSecret",
  "aiApiKey",
]);

export const MASKED_VALUE = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

/**
 * Recursively strips sensitive fields from an object,
 * replacing their values with a masked placeholder.
 * Returns a new object; does not mutate the original.
 *
 * Guards against circular references (returns the placeholder on revisit) so a
 * cyclic graph can't trigger unbounded recursion / stack overflow.
 */
export function sanitize<T>(obj: T, seen: WeakSet<object> = new WeakSet()): T {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (obj instanceof Date) return obj;
  if (seen.has(obj as object)) return "[circular]" as T;
  seen.add(obj as object);

  if (Array.isArray(obj)) return obj.map((item) => sanitize(item, seen)) as T;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.has(key) && value != null) {
      result[key] = MASKED_VALUE;
    } else if (typeof value === "object" && value !== null && !(value instanceof Date)) {
      result[key] = sanitize(value, seen);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/**
 * Sanitize error messages for external consumption.
 * Strips internal file paths and private IPs that may leak infrastructure details.
 */
export function sanitizeErrorDetail(
  detail: string | undefined
): string | undefined {
  if (!detail) return undefined;
  let cleaned = detail.replace(/\/[^\s:]+\.(ts|tsx|js|mjs|cjs|json|sql|env)/g, "[internal]");
  // Private / loopback / link-local IPv4 (incl. 169.254/16 and 0.0.0.0).
  cleaned = cleaned.replace(
    /\b(?:127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0)\b/g,
    "[internal]"
  );
  // IPv6 loopback (::1), unique-local (fc00::/7 → fc../fd..) and link-local
  // (fe80::/10). Each segment requires 1-4 hex digits (the old `{0,4}` allowed
  // empty groups, which matched a bare `fc00:` prefix or unrelated hex-colon
  // text), and at least one segment must follow the prefix.
  cleaned = cleaned.replace(
    /(?:::1\b|\b(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f])(?:::?[0-9a-f]{1,4})+\b)/gi,
    "[internal]"
  );
  // A plex.direct hostname is the server's IP address with the dots replaced
  // by dashes (`192-168-1-5.<hash>.plex.direct`), so it carries the address
  // the IPv4 rule above cannot see — and for a remote server, the PUBLIC one.
  cleaned = cleaned.replace(/\b(?:[\w-]+\.)+plex\.direct\b/gi, "[internal]");
  return cleaned;
}

/** Name-lookup error codes: what follows is always the host that was looked up. */
const LOOKUP_ERROR_CODES = "ENOTFOUND|EAI_AGAIN";
/**
 * Connection error codes: followed by `address:port` when Node names one
 * (`connect ECONNREFUSED 203.0.113.7:32400`) — and by ordinary words when it
 * does not, which must be left alone. `EPROTO` and `ECONNRESET` are not here:
 * what follows them is the TLS or socket detail, never an address.
 */
const CONNECT_ERROR_CODES = "ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|EADDRNOTAVAIL";

/**
 * Remove every network address from error text, public ones included.
 *
 * `sanitizeErrorDetail` hides private addresses and keeps the rest, because
 * the admin reading the message needs to know WHICH host did not answer
 * (`getaddrinfo ENOTFOUND plex.example.com`). A third-party integration
 * reading the same row through the public API does not: the public API strips
 * a media server's `url` and `machineId` from every response
 * (`src/lib/api-keys/trim-internals.ts`), and a failed sync's error text
 * handed the same address back — the server's public IP, DNS name and port.
 * Applied on top of `sanitizeErrorDetail`, for the public API only.
 */
export function redactNetworkAddresses(text: string): string {
  return (
    text
      // scheme://host[:port] — the path, if any, is kept (it is the API route).
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/"'<>()]+/gi, "[address]")
      // The host a lookup failed on: `getaddrinfo ENOTFOUND plex.example.com`.
      .replace(new RegExp(`\\b(${LOOKUP_ERROR_CODES})\\s+[^\\s,;)]+`, "g"), "$1 [address]")
      // The address a connection failed to, when one is named — recognised by
      // its port: `connect ECONNREFUSED 203.0.113.7:32400`, `… ::1:32400`.
      .replace(new RegExp(`\\b(${CONNECT_ERROR_CODES})\\s+[^\\s,;)]*:\\d{1,5}(?![\\w:])`, "g"), "$1 [address]")
      // A certificate mismatch lists the host and every name on the certificate.
      .replace(/\b(Host|DNS|IP Address):\s*[^\s,;)]+/g, "$1: [address]")
      // Any IPv4 address left, with its port.
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "[address]")
      // A bracketed IPv6 literal, with its port.
      .replace(/\[[0-9a-f:.%]*:[0-9a-f:.%]*\](?::\d{1,5})?/gi, "[address]")
  );
}
