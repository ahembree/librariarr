interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private store = new Map<string, RateLimitEntry>();

  constructor(
    private maxAttempts: number,
    private windowMs: number
  ) {}

  check(key: string): {
    limited: boolean;
    remaining: number;
    retryAfterMs?: number;
  } {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now >= entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + this.windowMs });
      return { limited: false, remaining: this.maxAttempts - 1 };
    }

    entry.count++;
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
   * Report whether a key is already over budget, WITHOUT consuming any.
   *
   * `check()` both counts and decides, which is wrong when the decision has to
   * come first: a caller that must reject an over-budget request before doing
   * expensive work (a database read, a log write) would otherwise have to spend
   * that work to find out. Mirrors `check()`'s threshold exactly — `check()`
   * rejects once a recorded count exceeds `maxAttempts`, so a stored count that
   * has already reached it means the next attempt is refused.
   */
  peek(key: string): { limited: boolean; retryAfterMs?: number } {
    const entry = this.store.get(key);
    const now = Date.now();
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

// 10 attempts per 15-minute window
export const authRateLimiter = new RateLimiter(10, 15 * 60 * 1000);

// External integrations hitting /api/v1. Bucketed per API key (not per IP) —
// the key is the identity there, and several integrations behind one NAT must
// not share a budget. Generous enough for polling dashboards, tight enough that
// a leaked key can't be used to scrape the whole library at line rate:
// 120 requests per minute.
export const apiKeyRateLimiter = new RateLimiter(120, 60 * 1000);

/**
 * Rejected /api/v1 authentication attempts, bucketed per client IP.
 *
 * The per-key limiter below cannot cover these: a request that fails to
 * authenticate has no key to bucket by. Without this, an unauthenticated
 * caller could hammer the API indefinitely — and because a rejection is logged
 * at WARN, and `logger` persists WARN to the `LogEntry` table, every one of
 * those requests would also become a durable database write. Capping failures
 * bounds both the traffic and the log growth.
 *
 * Deliberately more forgiving than `authRateLimiter` (10/15min): an integration
 * restarting with a stale key should get a clear 401 a few times rather than an
 * opaque 429 on its second attempt. A key that authenticates never touches this.
 */
export const apiKeyFailureLimiter = new RateLimiter(20, 5 * 60 * 1000);

// AI chat/test is interactive — a user asks many questions in a session, so the
// tight auth limit is wrong here. Still bounded so a runaway client (or a leaked
// session) can't hammer a paid LLM endpoint: 30 requests per 5-minute window.
export const aiRateLimiter = new RateLimiter(30, 5 * 60 * 1000);

// Cleanup expired entries every 5 minutes
setInterval(() => {
  authRateLimiter.cleanup();
  aiRateLimiter.cleanup();
  apiKeyRateLimiter.cleanup();
  apiKeyFailureLimiter.cleanup();
}, 5 * 60 * 1000).unref();

/**
 * Check a rate limit against the given limiter and return a 429 Response if
 * limited, or null if allowed. Buckets per client IP (see getClientIp).
 */
export function checkRateLimit(
  request: Request,
  limiter: RateLimiter,
  bucket: string,
): Response | null {
  const ip = getClientIp(request);
  const rateCheck = limiter.check(`${bucket}:${ip}`);
  if (rateCheck.limited) {
    return Response.json(
      { error: "Too many attempts. Try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)),
        },
      }
    );
  }
  return null;
}

/**
 * Check auth rate limit and return a 429 Response if limited, or null if allowed.
 * Consolidates the repeated rate-limit check pattern used across auth endpoints.
 */
export function checkAuthRateLimit(request: Request, bucket: string): Response | null {
  return checkRateLimit(request, authRateLimiter, bucket);
}

/**
 * Resolve the client IP for rate-limit bucketing.
 *
 * `x-forwarded-for` / `x-real-ip` are set by reverse proxies. We trust them
 * by default because most deployments sit behind a proxy that scrubs and
 * re-injects them — this is the documented topology in the install docs.
 *
 * For deployments exposed *directly* to the internet (no proxy between
 * Librariarr and the client), trusting these headers means an attacker can
 * trivially bypass per-IP rate limits by rotating `X-Forwarded-For`. Set
 * `TRUST_PROXY_HEADERS=false` in that case to fall back to a global bucket
 * (less granular but tamper-proof against header spoofing).
 *
 * Falsy values for `TRUST_PROXY_HEADERS`: `"false"`, `"0"`, `"no"`
 * (case-insensitive). Anything else (including unset) means trust.
 */
export function getClientIp(request: Request): string {
  if (proxyHeadersTrusted()) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
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
