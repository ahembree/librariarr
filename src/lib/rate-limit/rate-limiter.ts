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

// 10 attempts per 15-minute window
export const authRateLimiter = new RateLimiter(10, 15 * 60 * 1000);

// Cleanup expired entries every 5 minutes
setInterval(() => authRateLimiter.cleanup(), 5 * 60 * 1000).unref();

/**
 * Check auth rate limit and return a 429 Response if limited, or null if allowed.
 * Consolidates the repeated rate-limit check pattern used across auth endpoints.
 */
export function checkAuthRateLimit(request: Request, bucket: string): Response | null {
  const ip = getClientIp(request);
  const rateCheck = authRateLimiter.check(`${bucket}:${ip}`);
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
