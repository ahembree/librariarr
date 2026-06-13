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
]);

const MASKED_VALUE = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

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
  // IPv6 loopback (::1), unique-local (fc00::/7 → fc../fd..) and link-local (fe80::/10).
  cleaned = cleaned.replace(
    /(?:::1\b|\b(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f])(?::[0-9a-f]{0,4}){1,7})/gi,
    "[internal]"
  );
  return cleaned;
}
