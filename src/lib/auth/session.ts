import {
  getIronSession,
  type IronSession,
  type SessionOptions,
} from "iron-session";
import { cookies, headers } from "next/headers";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface SessionData {
  userId?: string;
  plexToken?: string;
  isLoggedIn: boolean;
  sessionVersion?: number;
  // Transient SSO OIDC handshake state — present only between the redirect to
  // the IdP and the callback. Cleared once the callback consumes them.
  oidcState?: string;
  oidcVerifier?: string;
  /**
   * Tells the OIDC callback whether this handshake was an anonymous login
   * (default) or an authenticated link flow initiated from the settings
   * page. The link path captures the IdP-issued `sub` directly so admins
   * don't need to find it in logs — and it doubles as live verification
   * that client_id + client_secret + redirect URI all work before SSO is
   * activated.
   */
  oidcFlow?: "link";
}

const SESSION_SECRET_FILE = "/config/.session-secret";

/**
 * Resolve the session secret from (in priority order):
 * 1. SESSION_SECRET environment variable
 * 2. Persisted auto-generated secret at /config/.session-secret
 * 3. Newly generated secret (persisted for future restarts)
 */
function resolveSessionSecret(): string {
  // 1. Explicit env var takes priority
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret && envSecret.length >= 32) {
    return envSecret;
  }

  if (envSecret && envSecret.length > 0 && envSecret.length < 32) {
    throw new Error(
      "SESSION_SECRET is set but must be at least 32 characters long. " +
        "Generate one with: openssl rand -hex 32"
    );
  }

  // 2. Check for previously auto-generated secret
  try {
    if (existsSync(SESSION_SECRET_FILE)) {
      const stored = readFileSync(SESSION_SECRET_FILE, "utf-8").trim();
      if (stored.length >= 32) {
        logger.info(
          "session",
          `Using auto-generated session secret from ${SESSION_SECRET_FILE}`
        );
        return stored;
      }
    }
  } catch {
    // File unreadable — fall through to generate a new one
  }

  // 3. Generate and persist a new secret
  const generated = randomBytes(32).toString("hex"); // 64-char hex string
  try {
    mkdirSync(dirname(SESSION_SECRET_FILE), { recursive: true });
    writeFileSync(SESSION_SECRET_FILE, generated + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    logger.info(
      "session",
      `No SESSION_SECRET configured — auto-generated and saved to ${SESSION_SECRET_FILE}`
    );
  } catch (err) {
    // Persist failed (e.g. read-only filesystem) — use the generated value
    // for this process lifetime but warn that sessions won't survive restarts
    logger.warn(
      "session",
      `Auto-generated SESSION_SECRET but could not persist to ${SESSION_SECRET_FILE} — ` +
        "sessions will be invalidated on restart. " +
        "Set SESSION_SECRET in your environment to avoid this.",
      { error: err instanceof Error ? err.message : String(err) }
    );
  }

  return generated;
}

// Lazy-initialised so the module can be imported at build time (next build's
// "Collecting page data" phase) without requiring SESSION_SECRET to exist.
let _sessionOptions: SessionOptions | null = null;

function getSessionOptions(): SessionOptions {
  if (!_sessionOptions) {
    const sessionSecret = resolveSessionSecret();
    _sessionOptions = {
      password: sessionSecret,
      cookieName: "librariarr_session",
      // The seal's own lifetime. iron-session defaults this to 14 days
      // regardless of the cookie's Max-Age, so without it a 30-day cookie
      // carried a seal that stopped unsealing after two weeks — the docs
      // promised 30 days and the cookie said 30 days, but the session died
      // at 14. Keep `ttl` and `maxAge` in lockstep.
      ttl: SESSION_LIFETIME_SECONDS,
      cookieOptions: {
        secure: resolveCookieSecure() ?? false,
        httpOnly: true,
        sameSite: "lax" as const,
        maxAge: SESSION_LIFETIME_SECONDS,
      },
    };
  }
  return _sessionOptions;
}

/** 30 days — the one number both the seal TTL and the cookie Max-Age use. */
export const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

/**
 * Per-request session options: the memoized base plus a `Secure` attribute
 * that follows the request when `COOKIE_SECURE` is not set explicitly. A
 * request that arrived over HTTPS (directly, or via a proxy that sets
 * `x-forwarded-proto: https`) gets a Secure cookie, so an HTTPS-fronted
 * deployment no longer leaks its session cookie over a stray plain-HTTP
 * request just because the operator never found the env var.
 */
async function getRequestSessionOptions(): Promise<SessionOptions> {
  const base = getSessionOptions();
  const explicit = resolveCookieSecure();
  if (explicit !== null) return base;
  return {
    ...base,
    cookieOptions: { ...base.cookieOptions, secure: await requestIsHttps() },
  };
}

async function requestIsHttps(): Promise<boolean> {
  try {
    const h = await headers();
    const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    return proto === "https";
  } catch {
    // Outside a request scope (instrumentation, tests) — no way to know.
    return false;
  }
}

/**
 * Resolve the explicit `COOKIE_SECURE` setting: `true`/`1`/`yes` → true, any
 * other value → false, unset → `null` (infer from the request, see
 * `getRequestSessionOptions`).
 *
 * The inferred default exists because a hard `false` left every HTTPS
 * deployment whose operator never found the env var sending its session
 * cookie without `Secure`, while a hard `true` would silently break direct
 * plain-HTTP setups (LAN, http://host:3000 with no proxy) — the browser would
 * refuse to store the cookie and users would never stay logged in. Following
 * `x-forwarded-proto` gets both right; the env var remains the override.
 */
function resolveCookieSecure(): boolean | null {
  const raw = process.env.COOKIE_SECURE;
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

/**
 * Read the session cookie WITHOUT checking it against the User row. Only the
 * login flows and `getSession` itself should need this — everything that
 * answers a request on behalf of a logged-in user must go through
 * `getSession`, which is what enforces revocation.
 */
export async function getRawSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, await getRequestSessionOptions());
}

/**
 * Read the session AND enforce revocation. A cookie that unseals is not
 * enough: the User row is the source of truth for whether it is still
 * honoured. A logged-in session whose `userId` no longer exists, or whose
 * `sessionVersion` no longer matches the row (a credential change, an SSO
 * link/unlink — everything that increments it "to invalidate other
 * sessions"), comes back with `isLoggedIn` false and no `userId`, so every
 * `if (!session.isLoggedIn) return 401` guard downstream refuses it.
 *
 * This lives in `getSession` itself, rather than in a second helper the
 * routes would have to remember to call, because the check was previously
 * only made by the page layout — and the 170-odd API routes each checked
 * `isLoggedIn` alone. A password change therefore logged the stale cookie out
 * of the HTML pages while it kept full read/write access to every `/api/*`
 * route, including the backup download that carries the Plex token in
 * plaintext. Revocation that only covers the UI is not revocation.
 *
 * The downgrade is in-memory only — nothing is saved — so a route that goes
 * on to `save()` the session (the OIDC login handshake writes its `state`
 * into whatever session the visitor carries) persists the logged-out state,
 * never resurrects the stale one. A session with NO `sessionVersion` is
 * treated as stale too: every login path has stamped one for a long time,
 * and a cookie without one could otherwise never be revoked at all.
 *
 * The DB lookup is a single primary-key read; a DB error is treated as
 * "not valid" (fail closed), matching what `isSessionValid` always did.
 */
export async function getSession(): Promise<IronSession<SessionData>> {
  const session = await getRawSession();
  if (!session.isLoggedIn) return session;
  const valid = await isUserSessionCurrent(session.userId, session.sessionVersion);
  if (!valid) {
    session.isLoggedIn = false;
    session.userId = undefined;
    session.sessionVersion = undefined;
    session.plexToken = undefined;
  }
  return session;
}

async function isUserSessionCurrent(
  userId: string | undefined,
  sessionVersion: number | undefined
): Promise<boolean> {
  if (!userId || sessionVersion === undefined) return false;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    return !!user && user.sessionVersion === sessionVersion;
  } catch {
    return false;
  }
}

/**
 * Start a brand-new session for a login, discarding whatever the visitor was
 * carrying first. That discard is the session-fixation defence — a pre-seeded
 * cookie must not survive into the authenticated session — and it is also what
 * drops the transient OIDC handshake fields and any stale Plex token.
 *
 * The destroy and the write have to happen on two different session objects:
 * iron-session refuses to save a session that was destroyed and then written
 * back into ("saving these fields would restore the cookie you just cleared").
 * Re-reading after the destroy yields an empty session over the same cookie
 * store, which is the supported way to express "sign this visitor out, then
 * sign this user in".
 */
export async function rotateSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  const options = await getRequestSessionOptions();
  const previous = await getIronSession<SessionData>(cookieStore, options);
  previous.destroy();
  return getIronSession<SessionData>(cookieStore, options);
}

/**
 * Whether the current request carries a session that is still honoured.
 * `getSession` already performs the User-row check, so this is just its
 * verdict — kept as a named helper for the page layout.
 */
export async function isSessionValid(): Promise<boolean> {
  const session = await getSession();
  return session.isLoggedIn === true && !!session.userId;
}
