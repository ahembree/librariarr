/**
 * Sanitize identity claims (username + email) before persisting them to the
 * User record. These values come from an external IdP (OIDC userinfo) or a
 * reverse proxy (forward-auth headers) — both are external trust boundaries.
 * Writing unvalidated values means:
 *   - control characters end up in logs (CRLF log-injection, NUL truncation)
 *   - multi-MB strings can be written to a TEXT column with no length cap
 *   - garbage like "not-an-email" lands in the email field and breaks any
 *     downstream feature that assumes it's parseable.
 *
 * This module returns `undefined` for unusable values rather than throwing —
 * the caller's policy is "sync if we can, leave the field alone otherwise."
 */

/** Maximum characters we'll persist for username/email. Generous (real-world
 *  values are <100 chars) but bounded — a hostile IdP shouldn't be able to
 *  stream multi-MB strings into our DB. */
const MAX_LENGTH = 256;

/** Strip ASCII control characters (NUL, CR, LF, etc) and DEL. These break
 *  log lines, can be used for log injection, and have no legitimate place
 *  in a username or email. */
function stripControls(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, "");
}

/** Returns a sanitized username if the input is usable, undefined otherwise.
 *  "Usable" = non-empty after trim + control-strip, within the length cap. */
export function sanitizeUsername(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = stripControls(raw).trim();
  if (!cleaned) return undefined;
  if (cleaned.length > MAX_LENGTH) return undefined;
  return cleaned;
}

/** Returns a sanitized email if it looks vaguely like an email and fits the
 *  length cap. The check is intentionally loose (one `@`, non-empty local and
 *  domain parts) — full RFC 5322 validation is famously hard and we just
 *  want to reject obviously-bogus values like "not-an-email" or whitespace. */
export function sanitizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = stripControls(raw).trim();
  if (!cleaned) return undefined;
  if (cleaned.length > MAX_LENGTH) return undefined;
  const at = cleaned.indexOf("@");
  if (at <= 0 || at !== cleaned.lastIndexOf("@")) return undefined;
  if (at === cleaned.length - 1) return undefined;
  return cleaned;
}
