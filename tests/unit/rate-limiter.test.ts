import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter, getClientIp } from "@/lib/rate-limit/rate-limiter";

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

describe("getClientIp", () => {
  it("returns first IP from x-forwarded-for header", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(getClientIp(request)).toBe("1.2.3.4");
  });

  it("returns single IP from x-forwarded-for", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(getClientIp(request)).toBe("1.2.3.4");
  });

  it("trims whitespace from x-forwarded-for", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "  1.2.3.4  , 5.6.7.8" },
    });
    expect(getClientIp(request)).toBe("1.2.3.4");
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
