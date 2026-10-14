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
    /** The window this attempt was counted in, for `refund`. */
    window: number;
  } {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now >= entry.resetAt) {
      if (!entry && this.store.size >= this.maxEntries) {
        const oldest = this.store.keys().next().value;
        if (oldest !== undefined) this.store.delete(oldest);
      }
      const resetAt = now + this.windowMs;
      this.store.set(key, { count: cost, resetAt });
      if (cost > this.maxAttempts) {
        return { limited: true, remaining: 0, retryAfterMs: this.windowMs, window: resetAt };
      }
      return { limited: false, remaining: this.maxAttempts - cost, window: resetAt };
    }

    entry.count += cost;
    if (entry.count > this.maxAttempts) {
      return {
        limited: true,
        remaining: 0,
        retryAfterMs: entry.resetAt - now,
        window: entry.resetAt,
      };
    }

    return { limited: false, remaining: this.maxAttempts - entry.count, window: entry.resetAt };
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

  /**
   * Take back `cost` attempts `check` charged — for an attempt charged up
   * front that turned out not to count (see `reserveAuthAttempt`). `window` is
   * the one `check` returned: once that window has ended the charge is gone
   * with it, and a newer window's count belongs to other attempts.
   */
  refund(key: string, window: number, cost = 1): void {
    const entry = this.store.get(key);
    if (entry && entry.resetAt === window && Date.now() < entry.resetAt) {
      entry.count = Math.max(0, entry.count - cost);
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.resetAt) this.store.delete(key);
    }
  }
}

// 10 attempts per 15-minute window, per client IP. Keyed by an address that a
// client rotating `X-Forwarded-For` chooses, so capped like the credential
// limiter below: dropping an entry only forgets a count, and the global floor
// under it still holds.
export const authRateLimiter = new RateLimiter(10, 15 * 60 * 1000, 10_000);

// The tamper-proof floor under the per-IP auth limit: total attempts per
// bucket across every client whose address has never signed in. The per-IP key
// is only as trustworthy as the IP, and the IP comes from a header when a proxy
// is trusted — so a client that can rotate `X-Forwarded-For` (a direct-exposure
// install, or a proxy that appends rather than replaces) gets a fresh per-IP
// bucket on every request. Measured before this existed: 12 login attempts with
// 12 different forwarded addresses, zero 429s. This bucket cannot be escaped by
// anything in the request.
//
// It does NOT apply to an address a sign-in has succeeded from (`knownAddresses`
// below). Applied to everyone, it was a lockout anyone could cause: sixty wrong
// passwords from anywhere — four a minute, from a single rotating or shared
// address — refused every client on the bucket for the rest of the window, the
// admin included, for as long as the sender cared to keep going. An address
// the admin has signed in from is judged by its own per-address budget alone,
// which only that address's failures can spend; a flood of forged addresses
// still meets the floor. An address that forges the admin's own keeps sharing
// the admin's budget, as it always did.
export const authGlobalRateLimiter = new RateLimiter(60, 15 * 60 * 1000);

// ─── Addresses a sign-in has succeeded from ───
//
// Remembered by `AuthAttempt.succeeded()` and by `rememberAuthenticatedAddress`
// for `KNOWN_ADDRESS_TTL_MS` (sliding), bounded so a run of successful
// sign-ins through a proxy that reports a fresh address each time cannot grow
// it without end. In memory only, like every limiter here: after a restart the
// first sign-in from an address is subject to the floor again, exactly like a
// first sign-in from anywhere. Where no proxy header names the client —
// `TRUST_PROXY_HEADERS=false`, or a direct install with no proxy at all —
// every client is the one address "unknown", whose per-address budget of ten
// is already shared by everyone: the floor adds nothing there, and "unknown"
// is remembered like any other address so the admin is not refused by a floor
// their own address could never be told apart from.
const KNOWN_ADDRESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_KNOWN_ADDRESSES = 10_000;
const knownAddresses = new Map<string, number>();

/** Remember the request's address as one a sign-in has succeeded from. */
export function rememberAuthenticatedAddress(request: Request): void {
  const ip = getClientIp(request);
  const now = Date.now();
  if (!knownAddresses.has(ip) && knownAddresses.size >= MAX_KNOWN_ADDRESSES) {
    for (const [key, until] of knownAddresses) if (until <= now) knownAddresses.delete(key);
    if (knownAddresses.size >= MAX_KNOWN_ADDRESSES) {
      const oldest = knownAddresses.keys().next().value;
      if (oldest !== undefined) knownAddresses.delete(oldest);
    }
  }
  // Re-inserted so insertion order is last-sign-in order for the eviction above.
  knownAddresses.delete(ip);
  knownAddresses.set(ip, now + KNOWN_ADDRESS_TTL_MS);
}

/** Whether a sign-in has succeeded from this address in the last 30 days. */
export function isKnownAddress(ip: string): boolean {
  const until = knownAddresses.get(ip);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    knownAddresses.delete(ip);
    return false;
  }
  return true;
}

function cleanupKnownAddresses(): void {
  const now = Date.now();
  for (const [key, until] of knownAddresses) if (until <= now) knownAddresses.delete(key);
}

/** Test-only: forget every address a sign-in has succeeded from. */
export function _resetKnownAddressesForTesting(): void {
  knownAddresses.clear();
}

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
  cleanupKnownAddresses();
}, 5 * 60 * 1000).unref();

/**
 * Check a rate limit against the given limiter and return a 429 Response if
 * limited, or null if allowed. Buckets per client IP (see getClientIp). When
 * a `globalLimiter` is given it is checked as well, keyed by bucket alone, so
 * the total across every client is bounded no matter what the IP claims —
 * except for an address a sign-in has succeeded from (`isKnownAddress`), which
 * neither charges it nor is refused by it: its own per-address budget is the
 * one bound that only its own attempts can spend.
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
  if (globalLimiter && !isKnownAddress(ip)) {
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
 * Applies both the per-IP limit and the global floor (`authGlobalRateLimiter`),
 * and charges EVERY call. For a route that only starts a flow (a Plex PIN, an
 * OIDC handshake) — there is no success to give back. A route that verifies a
 * credential uses `peekAuthRateLimit` + `reserveAuthAttempt` instead, so that
 * only its failures count.
 */
export function checkAuthRateLimit(request: Request, bucket: string): Response | null {
  return checkRateLimit(request, authRateLimiter, bucket, authGlobalRateLimiter);
}

/**
 * The one bucket the routes that are open before the first admin exists share:
 * `POST /api/auth/setup` (a bcrypt hash per call), and the setup-time backup
 * listing and restore. Whoever reaches a fresh install first becomes its
 * admin; this only keeps that from being a free CPU sink or a thousand
 * restores a minute. Charged on every call — none of them verifies a
 * credential — and ten per address per quarter hour is more than a setup
 * wizard makes.
 */
export const SETUP_BUCKET = "setup";

/**
 * The one bucket every current-password confirmation on a signed-in route is
 * charged to (the API-key step-up, `/api/auth/reauth/password` and a
 * credential change). Each bucket carries its own per-address and global
 * budget, so giving each route its own would add a fresh budget of guesses
 * per route.
 */
export const PASSWORD_CONFIRM_BUCKET = "password-confirm";

/**
 * The same two auth limiters, charged only on FAILURE. For every route that
 * verifies a credential: a login (the local password, a Plex token, an OIDC
 * callback, the forward-auth proxy's header) and a password or identity
 * confirmation on a route the user is already signed in to — creating an API
 * key, `/api/auth/reauth/*`, changing the credentials. Counting every attempt
 * spent the budget on sign-ins that succeeded (ten devices in a quarter hour,
 * or a routine run ten times) while a wrong password still costs exactly what
 * a failed login does.
 *
 * `peekAuthRateLimit` refuses early without counting; `reserveAuthAttempt`
 * charges the attempt immediately before the credential is checked, and its
 * `succeeded` gives it back when the check passed — and remembers the address
 * as one a sign-in has succeeded from, which exempts it from the global floor
 * (see `authGlobalRateLimiter`). Charging only after a failed compare let a
 * burst of concurrent wrong passwords all pass the check while their ~250 ms
 * bcrypt compares ran — N guesses instead of 10 — whereas a reservation counts
 * each one the moment it starts.
 */
export function peekAuthRateLimit(request: Request, bucket: string): Response | null {
  const ip = getClientIp(request);
  const perIp = authRateLimiter.peek(`${bucket}:${ip}`);
  if (perIp.limited) return tooManyAttempts(perIp.retryAfterMs);
  if (!isKnownAddress(ip)) {
    const global = authGlobalRateLimiter.peek(`${bucket}:*`);
    if (global.limited) return tooManyAttempts(global.retryAfterMs);
  }
  return null;
}

/**
 * A reserved attempt: refused with a 429, or held until `succeeded` gives it
 * back. An attempt that fails is simply left charged.
 */
export type AuthAttempt = { refused: Response } | { refused: null; succeeded: () => void };

export function reserveAuthAttempt(request: Request, bucket: string): AuthAttempt {
  const ip = getClientIp(request);
  const perIpKey = `${bucket}:${ip}`;
  const globalKey = `${bucket}:*`;
  const perIp = authRateLimiter.check(perIpKey);
  if (perIp.limited) {
    // Refused, so nothing was attempted: only failures count.
    authRateLimiter.refund(perIpKey, perIp.window);
    return { refused: tooManyAttempts(perIp.retryAfterMs) };
  }
  // The floor is for addresses no sign-in has succeeded from (see
  // `authGlobalRateLimiter`); a known address is bounded by its own budget.
  const global = isKnownAddress(ip) ? null : authGlobalRateLimiter.check(globalKey);
  if (global?.limited) {
    authRateLimiter.refund(perIpKey, perIp.window);
    authGlobalRateLimiter.refund(globalKey, global.window);
    return { refused: tooManyAttempts(global.retryAfterMs) };
  }
  // Refunded against the windows it was charged in, once: a window that has
  // since rolled over counts other attempts, not this one.
  let settled = false;
  return {
    refused: null,
    succeeded: () => {
      if (settled) return;
      settled = true;
      authRateLimiter.refund(perIpKey, perIp.window);
      if (global) authGlobalRateLimiter.refund(globalKey, global.window);
      rememberAuthenticatedAddress(request);
    },
  };
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
