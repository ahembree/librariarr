interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private store = new Map<string, RateLimitEntry>();

  constructor(
    readonly maxAttempts: number,
    private windowMs: number,
    /**
     * Most keys tracked at once; the oldest is dropped to admit a new one.
     * For limiters keyed by attacker-chosen values (a presented credential),
     * where a flood of distinct keys would otherwise grow the map without
     * bound until the next cleanup. Dropping an entry only forgets a count.
     */
    private maxEntries = Number.POSITIVE_INFINITY
  ) {}

  /**
   * Count an attempt. `cost` charges it as that many attempts, for a request
   * that is many times the work of an ordinary one (a whole-library listing
   * against a per-request budget).
   */
  check(
    key: string,
    cost = 1,
  ): {
    limited: boolean;
    remaining: number;
    retryAfterMs?: number;
  } {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now >= entry.resetAt) {
      if (!entry && this.store.size >= this.maxEntries) {
        const oldest = this.store.keys().next().value;
        if (oldest !== undefined) this.store.delete(oldest);
      }
      this.store.set(key, { count: cost, resetAt: now + this.windowMs });
      if (cost > this.maxAttempts) {
        return { limited: true, remaining: 0, retryAfterMs: this.windowMs };
      }
      return { limited: false, remaining: this.maxAttempts - cost };
    }

    entry.count += cost;
    if (entry.count > this.maxAttempts) {
      return {
        limited: true,
        remaining: 0,
        retryAfterMs: entry.resetAt - now,
      };
    }

    return { limited: false, remaining: this.maxAttempts - entry.count };
  }

  /**
   * Whether the NEXT `check(key)` would be refused — without counting this
   * call. For limiters that count only failures: the caller peeks before doing
   * the expensive work and calls `check` only once the attempt has failed, so
   * successful attempts are never charged against the budget.
   */
  peek(key: string): { limited: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry || now >= entry.resetAt) return { limited: false };
    if (entry.count >= this.maxAttempts) {
      return { limited: true, retryAfterMs: entry.resetAt - now };
    }
    return { limited: false };
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.resetAt) this.store.delete(key);
    }
  }
}

// 10 attempts per 15-minute window, per client IP
export const authRateLimiter = new RateLimiter(10, 15 * 60 * 1000);

// The tamper-proof floor under the per-IP auth limit: total attempts per
// bucket across ALL clients. The per-IP key is only as trustworthy as the IP,
// and the IP comes from a header when a proxy is trusted — so a client that
// can rotate `X-Forwarded-For` (a direct-exposure install, or a proxy that
// appends rather than replaces) gets a fresh per-IP bucket on every request.
// Measured before this existed: 12 login attempts with 12 different forwarded
// addresses, zero 429s. This bucket cannot be escaped by anything in the
// request. Generous enough that one admin never sees it; a brute force does.
export const authGlobalRateLimiter = new RateLimiter(60, 15 * 60 * 1000);

// AI chat/test is interactive — a user asks many questions in a session, so the
// tight auth limit is wrong here. Still bounded so a runaway client (or a leaked
// session) can't hammer a paid LLM endpoint: 30 requests per 5-minute window.
export const aiRateLimiter = new RateLimiter(30, 5 * 60 * 1000);

// ─── Public API (/api/v1) ───
//
// A key is 256 bits of randomness, so no limiter here is what stops guessing —
// nothing needs to. What they must never do is let one client's failures lock
// OUT a valid key: every container on one Docker host usually shares an
// address, and with TRUST_PROXY_HEADERS=false every client shares the single
// "unknown" address, so any per-address bucket that blocks lets whoever sends
// 500 junk requests shut every integration out, again and again. So:
//
// - failures are counted per PRESENTED CREDENTIAL, charged only on
//   failure (see `peek`): a client stuck on a deleted or expired key gets 429s
//   after 20 tries, and nothing else is affected — a valid key never fails, so
//   no one can fill its bucket. Capped at 10,000 tracked credentials so a flood
//   of distinct junk keys cannot grow memory;
// - `apiKeyFailureLogLimiter` bounds only the LOGGING of failures (50 WARN rows
//   per window across every client), so a flood cannot become a flood of log
//   rows either — it limits what is written, never who is served.
export const apiKeyCredentialFailureLimiter = new RateLimiter(20, 15 * 60 * 1000, 10_000);
export const apiKeyFailureLogLimiter = new RateLimiter(50, 15 * 60 * 1000);

// The one floor: how many well-formed keys that turn out NOT to exist may be
// looked up per minute, across every client. Every such key costs a database
// lookup, and without this nothing capped a flood of random ones. It refuses
// only credentials that have not authenticated in the last 15 minutes (the
// guard remembers those), so a key in active use is never shut out by it —
// only a key idle for longer, and only while the flood lasts. Far above any
// legitimate rate: an integration retrying a deleted key hits its own
// 20-failure bucket long before.
export const apiKeyUnknownLookupFloor = new RateLimiter(1000, 60 * 1000);

// How many scrypt verifications of API keys may run per minute, across every
// client. A key is stored as a salted scrypt hash and found by its 10-character
// display prefix, so a key whose prefix exists costs one key derivation (tens
// of milliseconds, 16 MiB) to reject. The prefix is not secret — it is shown in
// Settings — so this bounds what someone presenting forged keys under a known
// prefix can spend. Like the lookup floor it never touches a key verified in
// the last 15 minutes (the guard remembers those), and a legitimate process
// verifies each of its at most 50 keys once.
export const apiKeyVerificationFloor = new RateLimiter(100, 60 * 1000);

// Authenticated requests per API key: 600 a minute. Generous for dashboards and
// scripts paging through a library; bounds a runaway client or a leaked key.
export const apiKeyRequestLimiter = new RateLimiter(600, 60 * 1000);

// Cleanup expired entries every 5 minutes
setInterval(() => {
  authRateLimiter.cleanup();
  authGlobalRateLimiter.cleanup();
  aiRateLimiter.cleanup();
  apiKeyCredentialFailureLimiter.cleanup();
  apiKeyFailureLogLimiter.cleanup();
  apiKeyUnknownLookupFloor.cleanup();
  apiKeyVerificationFloor.cleanup();
  apiKeyRequestLimiter.cleanup();
}, 5 * 60 * 1000).unref();

/**
 * Check a rate limit against the given limiter and return a 429 Response if
 * limited, or null if allowed. Buckets per client IP (see getClientIp). When
 * a `globalLimiter` is given it is checked as well, keyed by bucket alone, so
 * the total across every client is bounded no matter what the IP claims.
 */
export function checkRateLimit(
  request: Request,
  limiter: RateLimiter,
  bucket: string,
  globalLimiter?: RateLimiter,
): Response | null {
  const ip = getClientIp(request);
  const perIp = limiter.check(`${bucket}:${ip}`);
  if (perIp.limited) return tooManyAttempts(perIp.retryAfterMs);
  if (globalLimiter) {
    const global = globalLimiter.check(`${bucket}:*`);
    if (global.limited) return tooManyAttempts(global.retryAfterMs);
  }
  return null;
}

function tooManyAttempts(retryAfterMs: number | undefined): Response {
  return Response.json(
    { error: "Too many attempts. Try again later." },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.ceil((retryAfterMs ?? 0) / 1000)),
      },
    }
  );
}

/**
 * Check auth rate limit and return a 429 Response if limited, or null if allowed.
 * Consolidates the repeated rate-limit check pattern used across auth endpoints.
 * Applies both the per-IP limit and the global floor (`authGlobalRateLimiter`).
 */
export function checkAuthRateLimit(request: Request, bucket: string): Response | null {
  return checkRateLimit(request, authRateLimiter, bucket, authGlobalRateLimiter);
}

/**
 * The same two auth limiters, charged only on FAILURE: `peekAuthRateLimit`
 * before the check, `recordAuthFailure` when it fails. For a password
 * confirmation on a route the user is already signed in to — creating an API
 * key — where counting every attempt would lock a legitimate user out of a
 * routine they may run ten times in a row, while a wrong password still costs
 * exactly what a failed login does.
 */
/**
 * The one bucket every current-password confirmation on a signed-in route is
 * charged to (the API-key step-up and `/api/auth/reauth/password`). Each
 * bucket carries its own per-address and global budget, so giving each route
 * its own would add a fresh budget of guesses per route.
 */
export const PASSWORD_CONFIRM_BUCKET = "password-confirm";

export function peekAuthRateLimit(request: Request, bucket: string): Response | null {
  const ip = getClientIp(request);
  const perIp = authRateLimiter.peek(`${bucket}:${ip}`);
  if (perIp.limited) return tooManyAttempts(perIp.retryAfterMs);
  const global = authGlobalRateLimiter.peek(`${bucket}:*`);
  if (global.limited) return tooManyAttempts(global.retryAfterMs);
  return null;
}

export function recordAuthFailure(request: Request, bucket: string): void {
  const ip = getClientIp(request);
  authRateLimiter.check(`${bucket}:${ip}`);
  authGlobalRateLimiter.check(`${bucket}:*`);
}

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
