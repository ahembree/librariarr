import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import {
  RateLimiter,
  getClientIp,
  checkRateLimit,
  checkAuthRateLimit,
  authGlobalRateLimiter,
  authRateLimiter,
  peekAuthRateLimit,
  reserveAuthAttempt,
} from "@/lib/rate-limit/rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3, 60_000); // 3 attempts per 60s
  });

  it("allows first request and returns correct remaining count", () => {
    const result = limiter.check("user1");
    expect(result.limited).toBe(false);
    expect(result.remaining).toBe(2);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("allows requests up to the max attempts", () => {
    limiter.check("user1");
    limiter.check("user1");
    const result = limiter.check("user1");
    expect(result.limited).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("blocks requests exceeding max attempts", () => {
    limiter.check("user1");
    limiter.check("user1");
    limiter.check("user1");
    const result = limiter.check("user1");
    expect(result.limited).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("tracks different keys independently", () => {
    limiter.check("user1");
    limiter.check("user1");
    limiter.check("user1");
    const result = limiter.check("user2");
    expect(result.limited).toBe(false);
    expect(result.remaining).toBe(2);
  });

  it("resets after window expires", () => {
    vi.useFakeTimers();
    try {
      limiter.check("user1");
      limiter.check("user1");
      limiter.check("user1");
      limiter.check("user1"); // blocked

      vi.advanceTimersByTime(61_000);

      const result = limiter.check("user1");
      expect(result.limited).toBe(false);
      expect(result.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleanup removes expired entries", () => {
    vi.useFakeTimers();
    try {
      limiter.check("user1");
      limiter.check("user2");

      vi.advanceTimersByTime(61_000);
      limiter.cleanup();

      // After cleanup and window expiry, requests should be fresh
      const result = limiter.check("user1");
      expect(result.limited).toBe(false);
      expect(result.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleanup does not remove active entries", () => {
    vi.useFakeTimers();
    try {
      limiter.check("user1");
      limiter.check("user1");
      limiter.check("user1");

      vi.advanceTimersByTime(30_000);
      limiter.cleanup();

      const result = limiter.check("user1");
      expect(result.limited).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RateLimiter.peek", () => {
  it("reports the next check's verdict without counting", () => {
    const limiter = new RateLimiter(3, 60_000);
    for (let i = 0; i < 50; i++) expect(limiter.peek("k").limited).toBe(false);
    // Fifty peeks charged nothing: the first check still has the full budget.
    expect(limiter.check("k").remaining).toBe(2);
  });

  it("is limited exactly when the next check would be", () => {
    const limiter = new RateLimiter(3, 60_000);
    limiter.check("k");
    limiter.check("k");
    expect(limiter.peek("k").limited).toBe(false);
    limiter.check("k");
    const peeked = limiter.peek("k");
    expect(peeked.limited).toBe(true);
    expect(peeked.retryAfterMs).toBeGreaterThan(0);
    expect(limiter.check("k").limited).toBe(true);
  });

  it("clears when the window expires", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(1, 60_000);
      limiter.check("k");
      expect(limiter.peek("k").limited).toBe(true);
      vi.advanceTimersByTime(61_000);
      expect(limiter.peek("k").limited).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps keys independent", () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check("a");
    expect(limiter.peek("a").limited).toBe(true);
    expect(limiter.peek("b").limited).toBe(false);
  });
});

describe("RateLimiter maxEntries", () => {
  it("drops the oldest key to admit a new one once full", () => {
    const limiter = new RateLimiter(1, 60_000, 2);
    limiter.check("a");
    limiter.check("b");
    expect(limiter.peek("a").limited).toBe(true);
    limiter.check("c"); // evicts "a", the oldest
    expect(limiter.peek("a").limited).toBe(false);
    expect(limiter.peek("b").limited).toBe(true);
    expect(limiter.peek("c").limited).toBe(true);
  });

  it("does not evict when an existing key is counted again", () => {
    const limiter = new RateLimiter(5, 60_000, 2);
    limiter.check("a");
    limiter.check("b");
    limiter.check("a");
    limiter.check("b");
    expect(limiter.check("a").remaining).toBe(2);
    expect(limiter.check("b").remaining).toBe(2);
  });
});

describe("checkRateLimit", () => {
  it("returns null while under the limit", () => {
    const limiter = new RateLimiter(2, 60_000);
    const req = new Request("http://localhost/api/ai/chat", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(checkRateLimit(req, limiter, "ai-chat")).toBeNull();
    expect(checkRateLimit(req, limiter, "ai-chat")).toBeNull();
  });

  it("returns a 429 with Retry-After once the limit is exceeded", async () => {
    const limiter = new RateLimiter(1, 60_000);
    const req = new Request("http://localhost/api/ai/chat", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(checkRateLimit(req, limiter, "ai-chat")).toBeNull();
    const limited = checkRateLimit(req, limiter, "ai-chat");
    expect(limited).not.toBeNull();
    expect(limited!.status).toBe(429);
    expect(Number(limited!.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await limited!.json()).error).toContain("Too many");
  });

  it("buckets independently per bucket name and per client IP", () => {
    const limiter = new RateLimiter(1, 60_000);
    const reqA = new Request("http://localhost/api/ai/chat", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    const reqB = new Request("http://localhost/api/ai/chat", {
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    expect(checkRateLimit(reqA, limiter, "ai-chat")).toBeNull();
    // Different IP → separate bucket, still allowed.
    expect(checkRateLimit(reqB, limiter, "ai-chat")).toBeNull();
    // Same IP + bucket → now limited.
    expect(checkRateLimit(reqA, limiter, "ai-chat")).not.toBeNull();
    // Same IP, different bucket → separate counter, allowed.
    expect(checkRateLimit(reqA, limiter, "ai-other")).toBeNull();
  });
});

describe("getClientIp", () => {
  it("returns the LAST (proxy-appended) IP from x-forwarded-for, not the client-supplied first", () => {
    // A proxy appends the address it saw; the first entry is whatever the
    // client typed. Taking the first let a client pick its own bucket.
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(getClientIp(request)).toBe("5.6.7.8");
  });

  it("ignores empty trailing entries in x-forwarded-for", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, " },
    });
    expect(getClientIp(request)).toBe("5.6.7.8");
  });

  it("returns single IP from x-forwarded-for", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(getClientIp(request)).toBe("1.2.3.4");
  });

  it("trims whitespace from x-forwarded-for", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "1.2.3.4,   5.6.7.8  " },
    });
    expect(getClientIp(request)).toBe("5.6.7.8");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-real-ip": "9.8.7.6" },
    });
    expect(getClientIp(request)).toBe("9.8.7.6");
  });

  it("prefers x-forwarded-for over x-real-ip", () => {
    const request = new Request("http://localhost/api/test", {
      headers: {
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "9.8.7.6",
      },
    });
    expect(getClientIp(request)).toBe("1.2.3.4");
  });

  it("returns 'unknown' when no proxy headers are present", () => {
    const request = new Request("http://localhost/api/test");
    expect(getClientIp(request)).toBe("unknown");
  });

  describe("TRUST_PROXY_HEADERS env var", () => {
    const originalValue = process.env.TRUST_PROXY_HEADERS;

    afterEach(() => {
      if (originalValue === undefined) {
        delete process.env.TRUST_PROXY_HEADERS;
      } else {
        process.env.TRUST_PROXY_HEADERS = originalValue;
      }
    });

    it("ignores forwarded headers when TRUST_PROXY_HEADERS=false", () => {
      process.env.TRUST_PROXY_HEADERS = "false";
      const request = new Request("http://localhost/api/test", {
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      // Falls back to "unknown" so an attacker can't escape rate-limit buckets
      // by rotating spoofed X-Forwarded-For values when there's no real proxy.
      expect(getClientIp(request)).toBe("unknown");
    });

    it("ignores forwarded headers when TRUST_PROXY_HEADERS=0", () => {
      process.env.TRUST_PROXY_HEADERS = "0";
      const request = new Request("http://localhost/api/test", {
        headers: { "x-real-ip": "1.2.3.4" },
      });
      expect(getClientIp(request)).toBe("unknown");
    });

    it("trusts forwarded headers when TRUST_PROXY_HEADERS=true", () => {
      process.env.TRUST_PROXY_HEADERS = "true";
      const request = new Request("http://localhost/api/test", {
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      expect(getClientIp(request)).toBe("1.2.3.4");
    });

    it("trusts forwarded headers when env var is unset (default)", () => {
      delete process.env.TRUST_PROXY_HEADERS;
      const request = new Request("http://localhost/api/test", {
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      expect(getClientIp(request)).toBe("1.2.3.4");
    });
  });
});

describe("checkAuthRateLimit — global floor", () => {
  const originalValue = process.env.TRUST_PROXY_HEADERS;

  afterEach(() => {
    if (originalValue === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalValue;
    // The global limiter is a module singleton; drop our bucket's entry.
    (authGlobalRateLimiter as unknown as { store: Map<string, unknown> }).store.clear();
  });

  it("rotating X-Forwarded-For cannot escape the limit indefinitely", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const bucket = "login-global-floor-test";
    let limited = 0;
    // 61 attempts, each from a "different" client. The per-IP limit (10)
    // never trips; the global floor (60 per bucket) must.
    for (let i = 0; i < 61; i++) {
      const req = new Request("http://localhost/api/auth/local/login", {
        method: "POST",
        headers: { "x-forwarded-for": `10.0.${Math.floor(i / 256)}.${i % 256}` },
      });
      if (checkAuthRateLimit(req, bucket)) limited++;
    }
    expect(limited).toBe(1);
  });

  it("the global floor is per bucket", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    for (let i = 0; i < 60; i++) {
      const req = new Request("http://localhost/api/x", {
        headers: { "x-forwarded-for": `10.1.0.${i}` },
      });
      expect(checkAuthRateLimit(req, "bucket-a")).toBeNull();
    }
    const other = new Request("http://localhost/api/x", {
      headers: { "x-forwarded-for": "10.1.0.1" },
    });
    expect(checkAuthRateLimit(other, "bucket-b")).toBeNull();
    const again = new Request("http://localhost/api/x", {
      headers: { "x-forwarded-for": "10.1.0.61" },
    });
    const res = checkAuthRateLimit(again, "bucket-a");
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("RateLimiter.check with a cost", () => {
  it("charges one call as several attempts", () => {
    const limiter = new RateLimiter(10, 60_000);
    expect(limiter.check("k", 4)).toMatchObject({ limited: false, remaining: 6 });
    expect(limiter.check("k", 4)).toMatchObject({ limited: false, remaining: 2 });
    expect(limiter.check("k", 4).limited).toBe(true);
    expect(limiter.check("k").limited).toBe(true);
  });

  it("refuses a single call that costs more than the whole budget", () => {
    const limiter = new RateLimiter(3, 60_000);
    const res = limiter.check("k", 4);
    expect(res.limited).toBe(true);
    expect(res.retryAfterMs).toBe(60_000);
  });

  it("costs one attempt by default", () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.check("k").remaining).toBe(1);
    expect(limiter.check("k").remaining).toBe(0);
  });
});

describe("RateLimiter.refund", () => {
  it("gives back attempts charged in the current window", () => {
    const limiter = new RateLimiter(2, 60_000);
    limiter.check("k");
    const { window } = limiter.check("k");
    expect(limiter.peek("k").limited).toBe(true);
    limiter.refund("k", window);
    expect(limiter.peek("k").limited).toBe(false);
  });

  it("never goes below zero, and ignores an unknown key", () => {
    const limiter = new RateLimiter(2, 60_000);
    limiter.refund("unknown", Date.now() + 60_000);
    const { window } = limiter.check("k");
    limiter.refund("k", window);
    limiter.refund("k", window);
    // Back to zero, not below: exactly the budget, then refused. A count left
    // at -1 would let a third attempt through.
    expect(limiter.check("k").limited).toBe(false);
    expect(limiter.check("k").limited).toBe(false);
    expect(limiter.check("k").limited).toBe(true);
  });

  // A charge ends with its window; a newer window counts other attempts, so a
  // late refund must not cancel one of those.
  it("does not refund into a newer window", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(2, 1000);
      const { window } = limiter.check("k");
      vi.advanceTimersByTime(1500);
      limiter.check("k");
      limiter.check("k");
      limiter.refund("k", window);
      expect(limiter.check("k").limited).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not refund into a window created after the charge's was evicted", () => {
    const limiter = new RateLimiter(1, 60_000, 1);
    const { window } = limiter.check("a");
    limiter.check("b"); // evicts "a"
    vi.useFakeTimers({ now: Date.now() + 5 });
    try {
      limiter.check("a"); // a new window for "a", full
      limiter.refund("a", window);
      expect(limiter.peek("a").limited).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("peekAuthRateLimit / reserveAuthAttempt", () => {
  const stores = () =>
    [authRateLimiter, authGlobalRateLimiter].map(
      (l) => (l as unknown as { store: Map<string, unknown> }).store,
    );
  const originalValue = process.env.TRUST_PROXY_HEADERS;

  afterEach(() => {
    if (originalValue === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalValue;
    for (const store of stores()) store.clear();
  });

  const from = (ip: string) =>
    new Request("http://localhost/api/settings/api-keys", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
    });

  it("charges nothing for attempts that succeed, and refuses an address after ten failures", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    // Fifty correct passwords in a row: each reservation is refunded.
    for (let i = 0; i < 50; i++) {
      expect(peekAuthRateLimit(from("10.9.0.1"), "peek-test")).toBeNull();
      const attempt = reserveAuthAttempt(from("10.9.0.1"), "peek-test");
      expect(attempt.refused).toBeNull();
      if (!attempt.refused) attempt.refund();
    }
    // Ten wrong ones: reserved and kept.
    for (let i = 0; i < 10; i++) expect(reserveAuthAttempt(from("10.9.0.1"), "peek-test").refused).toBeNull();
    const res = peekAuthRateLimit(from("10.9.0.1"), "peek-test");
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBeTruthy();
    expect(reserveAuthAttempt(from("10.9.0.1"), "peek-test").refused?.status).toBe(429);
    // Another address is unaffected.
    expect(peekAuthRateLimit(from("10.9.0.2"), "peek-test")).toBeNull();
  });

  // Charging only after a failed compare let every request of a concurrent
  // burst pass the check before the first compare finished.
  it("counts concurrent attempts from the moment they start", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    // Fifty guesses in flight at once, none finished yet.
    const outcomes = Array.from({ length: 50 }, () => reserveAuthAttempt(from("10.9.1.1"), "burst"));
    const held = outcomes.filter((r) => r.refused === null);
    expect(held).toHaveLength(10);
    expect(outcomes.filter((r) => r.refused?.status === 429)).toHaveLength(40);
    // A refused reservation charged nothing, so one success frees one slot —
    // and only one, however often it is refunded.
    const success = held[0];
    if (!success.refused) {
      success.refund();
      success.refund();
    }
    expect(reserveAuthAttempt(from("10.9.1.1"), "burst").refused).toBeNull();
    expect(reserveAuthAttempt(from("10.9.1.1"), "burst").refused?.status).toBe(429);
  });

  it("applies the global floor no address can escape", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    for (let i = 0; i < 60; i++) {
      expect(reserveAuthAttempt(from(`10.10.${Math.floor(i / 250)}.${i % 250}`), "peek-global").refused).toBeNull();
    }
    expect(peekAuthRateLimit(from("10.11.0.1"), "peek-global")?.status).toBe(429);
    // Refused by the floor: the fresh address's own bucket is not charged.
    expect(reserveAuthAttempt(from("10.11.0.1"), "peek-global").refused?.status).toBe(429);
    const perIp = (authRateLimiter as unknown as { store: Map<string, { count: number }> }).store;
    expect(perIp.get("peek-global:10.11.0.1")?.count ?? 0).toBe(0);
    // Other buckets keep their own floor.
    expect(peekAuthRateLimit(from("10.11.0.1"), "peek-other")).toBeNull();
  });

  // The per-address key is whatever X-Forwarded-For says on a directly
  // exposed install, so a client rotating it adds an entry per request.
  it("tracks at most 10,000 addresses", () => {
    for (let i = 0; i < 10_050; i++) authRateLimiter.check(`flood:10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
    const perIp = (authRateLimiter as unknown as { store: Map<string, unknown> }).store;
    expect(perIp.size).toBe(10_000);
  });
});
