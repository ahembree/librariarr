/**
 * Resolve the client IP for rate-limit bucketing.
 *
 * `x-forwarded-for` / `x-real-ip` are set by reverse proxies. We trust them
 * by default because most deployments sit behind a proxy that scrubs and
 * re-injects them — this is the documented topology in the install docs.
 *
 * `X-Forwarded-For` is read from the RIGHT: a proxy appends the address it
 * saw to whatever the client sent, so the last entry is the one hop the
 * client could not forge and the first entry is whatever the client typed.
 * Taking the first entry let a client behind a perfectly configured proxy
 * pick its own bucket on every request.
 *
 * For deployments exposed *directly* to the internet (no proxy between
 * Librariarr and the client), even the last entry is client-supplied. Set
 * `TRUST_PROXY_HEADERS=false` in that case to fall back to a single shared
 * bucket — and either way, `checkAuthRateLimit` also applies the global
 * `authGlobalRateLimiter` floor that no header can escape.
 *
 * Falsy values for `TRUST_PROXY_HEADERS`: `"false"`, `"0"`, `"no"`
 * (case-insensitive). Anything else (including unset) means trust.
 */
export function getClientIp(request: Request): string {
  if (proxyHeadersTrusted()) {
    const forwarded = request.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .at(-1);
    if (forwarded) return forwarded;
    const realIp = request.headers.get("x-real-ip");
    if (realIp) return realIp;
  }
  // Next.js Request API doesn't expose raw socket IP. When proxy headers are
  // either absent or distrusted, fall back to a single shared bucket — slower
  // legitimate users but no way to escape rate limits via header rotation.
  return "unknown";
}

function proxyHeadersTrusted(): boolean {
  const raw = process.env.TRUST_PROXY_HEADERS;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "false" || normalized === "0" || normalized === "no");
}

/** Longest client address a log line repeats: it can be a header a client wrote. */
export const MAX_AUDIT_ADDRESS_LENGTH = 64;

/** The request's address as an audit log line shows it (see `getClientIp`). */
export function auditAddress(request: Request): string {
  return getClientIp(request).slice(0, MAX_AUDIT_ADDRESS_LENGTH);
}
