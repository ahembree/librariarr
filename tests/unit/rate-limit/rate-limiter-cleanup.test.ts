import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Module = typeof import("@/lib/rate-limit/rate-limiter");

const FIVE_MIN = 5 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function req(ip: string): Request {
  return new Request("http://localhost/api/auth/login", { headers: { "x-forwarded-for": ip } });
}

/** A fresh copy of the module, loaded under fake timers so its cleanup interval is controllable. */
async function load(): Promise<Module> {
  vi.resetModules();
  return import("@/lib/rate-limit/rate-limiter");
}

// Every address below comes from X-Forwarded-For, which is only read while
// proxy headers are trusted (the default): pin that against the shell's env.
beforeEach(() => {
  vi.stubEnv("TRUST_PROXY_HEADERS", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rate-limiter periodic cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sweeps every shared limiter every five minutes", async () => {
    const mod = await load();
    const cleanup = vi.spyOn(mod.RateLimiter.prototype, "cleanup");

    await vi.advanceTimersByTimeAsync(FIVE_MIN - 1);
    expect(cleanup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    // auth, auth floor, AI, and the five API-key limiters.
    expect(cleanup).toHaveBeenCalledTimes(8);
    const swept = new Set(cleanup.mock.contexts);
    for (const limiter of [
      mod.authRateLimiter,
      mod.authGlobalRateLimiter,
      mod.aiRateLimiter,
      mod.apiKeyCredentialFailureLimiter,
      mod.apiKeyFailureLogLimiter,
      mod.apiKeyUnknownLookupFloor,
      mod.apiKeyVerificationFloor,
      mod.apiKeyRequestLimiter,
    ]) {
      expect(swept.has(limiter)).toBe(true);
    }
  });

  it("a per-address entry whose window has ended (and been swept) starts a fresh window", async () => {
    const mod = await load();
    const bucket = "sweep";
    for (let i = 0; i < 10; i++) expect(mod.checkRateLimit(req("1.1.1.1"), mod.authRateLimiter, bucket)).toBeNull();
    expect(mod.checkRateLimit(req("1.1.1.1"), mod.authRateLimiter, bucket)?.status).toBe(429);

    // The 15-minute window ends and the 5-minute sweep removes the entry.
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + FIVE_MIN);
    const fresh = mod.authRateLimiter.check(`${bucket}:1.1.1.1`);
    expect(fresh).toMatchObject({ limited: false, remaining: 9 });
  });

  it("forgets known addresses whose 30 days have passed while keeping recent ones", async () => {
    const mod = await load();
    mod.rememberAuthenticatedAddress(req("10.0.0.1"));
    await vi.advanceTimersByTimeAsync(THIRTY_DAYS - FIVE_MIN);
    mod.rememberAuthenticatedAddress(req("10.0.0.2"));

    // Crossing the 30-day mark on a sweep tick drops only the first address.
    await vi.advanceTimersByTimeAsync(2 * FIVE_MIN);
    expect(mod.isKnownAddress("10.0.0.2")).toBe(true);
    expect(mod.isKnownAddress("10.0.0.1")).toBe(false);
  });

  it("when full, drops expired addresses before evicting a live one", async () => {
    const mod = await load();
    // Off the sweep's 5-minute grid, so the 30-day expiry falls between ticks.
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 9_999; i++) {
      mod.rememberAuthenticatedAddress(req(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`));
    }
    // A later sign-in that is still live when the rest have expired.
    vi.advanceTimersByTime(THIRTY_DAYS - FIVE_MIN);
    mod.rememberAuthenticatedAddress(req("11.0.0.1"));
    // Past 30 days for the first 9,999, but before the next sweep tick runs.
    vi.advanceTimersByTime(FIVE_MIN + 1000);
    mod.rememberAuthenticatedAddress(req("11.0.0.2"));

    expect(mod.isKnownAddress("11.0.0.1")).toBe(true);
    expect(mod.isKnownAddress("11.0.0.2")).toBe(true);
    expect(mod.isKnownAddress("10.0.0.5")).toBe(false);
  });

  it("re-remembering an address slides its 30-day window", async () => {
    const mod = await load();
    mod.rememberAuthenticatedAddress(req("10.0.0.3"));
    await vi.advanceTimersByTimeAsync(THIRTY_DAYS - 1000);
    mod.rememberAuthenticatedAddress(req("10.0.0.3"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(mod.isKnownAddress("10.0.0.3")).toBe(true);
  });
});

describe("auth attempt reservations", () => {
  let mod: Module;

  beforeEach(async () => {
    vi.useFakeTimers();
    mod = await load();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses at the global floor for unknown addresses and charges nothing for the refusal", () => {
    const bucket = "floor";
    // 60 distinct addresses fill the floor.
    for (let i = 0; i < 60; i++) {
      const attempt = mod.reserveAuthAttempt(req(`192.168.1.${i}`), bucket);
      expect(attempt.refused).toBeNull();
    }
    const refused = mod.reserveAuthAttempt(req("192.168.2.1"), bucket);
    expect(refused.refused?.status).toBe(429);
    expect(refused.refused?.headers.get("Retry-After")).toBe("900");
    // The refused attempt's per-address charge was given back.
    expect(mod.authRateLimiter.check(`${bucket}:192.168.2.1`).remaining).toBe(9);
    expect(mod.peekAuthRateLimit(req("192.168.2.2"), bucket)?.status).toBe(429);
  });

  it("a known address bypasses the floor in peek and reserve, and succeeded() is idempotent", () => {
    const bucket = "known";
    const first = mod.reserveAuthAttempt(req("8.8.8.8"), bucket);
    // A second attempt in flight from the same address, which fails.
    const second = mod.reserveAuthAttempt(req("8.8.8.8"), bucket);
    if (first.refused || second.refused) throw new Error("unexpected refusal");
    first.succeeded();
    first.succeeded();
    expect(mod.isKnownAddress("8.8.8.8")).toBe(true);
    // Given back once, not twice: the failed attempt stays charged, so this
    // check is the second of ten.
    expect(mod.authRateLimiter.check(`${bucket}:8.8.8.8`).remaining).toBe(8);

    for (let i = 0; i < 60; i++) mod.reserveAuthAttempt(req(`172.16.0.${i}`), bucket);
    expect(mod.peekAuthRateLimit(req("172.16.1.1"), bucket)?.status).toBe(429);
    expect(mod.peekAuthRateLimit(req("8.8.8.8"), bucket)).toBeNull();
    const known = mod.reserveAuthAttempt(req("8.8.8.8"), bucket);
    expect(known.refused).toBeNull();
    if (!known.refused) known.succeeded();
  });

  it("refuses at the per-address limit and peeks the same verdict", () => {
    const bucket = "per-ip";
    for (let i = 0; i < 10; i++) expect(mod.reserveAuthAttempt(req("5.5.5.5"), bucket).refused).toBeNull();
    expect(mod.peekAuthRateLimit(req("5.5.5.5"), bucket)?.status).toBe(429);
    const refused = mod.reserveAuthAttempt(req("5.5.5.5"), bucket);
    expect(refused.refused?.status).toBe(429);
    // Other addresses are unaffected.
    expect(mod.peekAuthRateLimit(req("5.5.5.6"), bucket)).toBeNull();
  });

  it("a cost above the limit is refused on the first check of a window", () => {
    const limiter = new mod.RateLimiter(5, 1000);
    expect(limiter.check("big", 6)).toMatchObject({ limited: true, remaining: 0, retryAfterMs: 1000 });
    expect(limiter.peek("big")).toMatchObject({ limited: true });
    vi.advanceTimersByTime(1000);
    expect(limiter.peek("big")).toEqual({ limited: false });
  });
});
