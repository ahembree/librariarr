import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.unmock("@/lib/auth/session");

/**
 * Session rotation against the REAL iron-session.
 *
 * Every login path (setup, local login, both Plex token branches, the OIDC
 * callback, forward-auth) signs the visitor out before signing the user in, so
 * a pre-seeded cookie can't survive into the authenticated session and a stale
 * Plex token or half-finished OIDC handshake can't leak across logins. The
 * obvious spelling of that — `session.destroy()` then write the new fields then
 * `save()` on the SAME object — is rejected by iron-session, because those
 * writes would restore the very cookie the destroy just cleared.
 *
 * The rest of the suite mocks iron-session, which means it cannot see that
 * rejection: it would pass against a library that throws on every single login.
 * This file therefore drives the real library over an in-memory cookie store,
 * which is the only place the actual sign-out-then-sign-in semantics are
 * checked.
 */

/** Minimal stand-in for the cookie store `next/headers` cookies() returns. */
function makeCookieStore(seed = new Map<string, string>()) {
  const jar = new Map(seed);
  return {
    jar,
    get(name: string) {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name: string | { name: string; value: string }, value?: string) {
      if (typeof name === "object") jar.set(name.name, name.value);
      else jar.set(name, value ?? "");
    },
    delete(name: string) {
      jar.delete(name);
    },
  };
}

const SECRET = "rotation-secret-that-is-long-enough-for-iron!!";
const ORIG_SECRET = process.env.SESSION_SECRET;

let store: ReturnType<typeof makeCookieStore>;

type SessionModule = typeof import("@/lib/auth/session");
const load = (): Promise<SessionModule> => import("@/lib/auth/session");

beforeEach(() => {
  vi.resetModules();
  store = makeCookieStore();
  process.env.SESSION_SECRET = SECRET;
  vi.doMock("next/headers", () => ({ cookies: async () => store }));
  vi.doMock("@/lib/db", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
  vi.doMock("@/lib/logger", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
});

afterEach(() => {
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/db");
  vi.doUnmock("@/lib/logger");
  if (ORIG_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIG_SECRET;
});

describe("rotateSession (real iron-session)", () => {
  it("writes a saveable session — the login flows' whole shape", async () => {
    const { rotateSession, getSession } = await load();

    const session = await rotateSession();
    session.userId = "user-1";
    session.isLoggedIn = true;
    session.sessionVersion = 4;
    await session.save();

    const readBack = await getSession();
    expect(readBack.userId).toBe("user-1");
    expect(readBack.isLoggedIn).toBe(true);
    expect(readBack.sessionVersion).toBe(4);
  });

  it("drops everything the visitor was carrying into the login", async () => {
    const { rotateSession, getSession } = await load();

    // A visitor arrives mid-OIDC-handshake, already holding a Plex token.
    const before = await getSession();
    before.userId = "someone-else";
    before.isLoggedIn = true;
    before.plexToken = "stale-plex-token";
    before.oidcState = "handshake-state";
    before.oidcVerifier = "handshake-verifier";
    await before.save();

    const session = await rotateSession();
    expect(session.userId).toBeUndefined();
    expect(session.plexToken).toBeUndefined();
    expect(session.oidcState).toBeUndefined();
    expect(session.oidcVerifier).toBeUndefined();

    session.userId = "user-2";
    session.isLoggedIn = true;
    await session.save();

    const readBack = await getSession();
    expect(readBack.userId).toBe("user-2");
    expect(readBack.plexToken).toBeUndefined();
    expect(readBack.oidcState).toBeUndefined();
  });

  it("is not interchangeable with destroy-then-write on one session object", async () => {
    // The pattern rotateSession() replaced. Kept as a test so the helper is
    // never "simplified" back into it: iron-session rejects the save, which
    // would take down every login path at runtime.
    const { getSession } = await load();

    const session = await getSession();
    session.userId = "prior";
    session.isLoggedIn = true;
    await session.save();

    const reused = await getSession();
    reused.destroy();
    reused.userId = "next";
    reused.isLoggedIn = true;
    await expect(reused.save()).rejects.toThrow(/destroyed session/i);
  });
});
