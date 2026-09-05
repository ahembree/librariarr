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

// Cleanup expired entries every 5 minutes
setInterval(() => {
  authRateLimiter.cleanup();
  authGlobalRateLimiter.cleanup();
  aiRateLimiter.cleanup();
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
