/**
 * Utilities for sanitizing sensitive data from API responses.
 */

const SENSITIVE_FIELDS = new Set([
  "accessToken",
  "apiKey",
  "plexToken",
  "passwordHash",
  "backupEncryptionPassword",
]);

const MASKED_VALUE = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

/**
 * Recursively strips sensitive fields from an object,
 * replacing their values with a masked placeholder.
 * Returns a new object; does not mutate the original.
 */
export function sanitize<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitize) as T;
  if (obj instanceof Date) return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.has(key) && value != null) {
      result[key] = MASKED_VALUE;
    } else if (typeof value === "object" && value !== null && !(value instanceof Date)) {
      result[key] = sanitize(value);
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
  let cleaned = detail.replace(/\/[^\s:]+\.(ts|js|mjs)/g, "[internal]");
  cleaned = cleaned.replace(
    /\b(?:127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)\b/g,
    "[internal]"
  );
  return cleaned;
}
