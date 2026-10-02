import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.unmock("@/lib/auth/session");

/**
 * `getSession()` under an API key, against the REAL session module.
 *
 * `/api/v1` handlers are the app's own route handlers run by `withApiKey`, and
 * those handlers call `getSession()`. The rest of the suite mocks the session
 * module (with a copy of this branch), so this file is where the real one is
 * held to it: under a principal the cookie is never read, the User row is
 * never consulted, and the cookie-session primitives refuse outright.
 */

const cookies = vi.fn();
const findUnique = vi.fn();

type SessionModule = typeof import("@/lib/auth/session");
type PrincipalModule = typeof import("@/lib/api-keys/principal");

let session: SessionModule;
let principal: PrincipalModule;

const KEY = {
  keyId: "key-1",
  userId: "user-1",
  name: "Home Assistant",
  prefix: "lbr_abcdef",
  scopes: ["streams:read" as const],
};

beforeEach(async () => {
  vi.resetModules();
  cookies.mockReset();
  findUnique.mockReset();
  process.env.SESSION_SECRET = "api-key-session-secret-long-enough-for-iron!!";
  vi.doMock("next/headers", () => ({ cookies, headers: async () => new Map() }));
  vi.doMock("@/lib/db", () => ({ prisma: { user: { findUnique } } }));
  vi.doMock("@/lib/logger", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  session = await import("@/lib/auth/session");
  principal = await import("@/lib/api-keys/principal");
});

afterEach(() => {
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/db");
  vi.doUnmock("@/lib/logger");
});

describe("getSession under an API key (real module)", () => {
  it("is the key's owner without reading a cookie or the User row", async () => {
    const result = await principal.runAsApiKey(KEY, () => session.getSession());
    expect(result.isLoggedIn).toBe(true);
    expect(result.userId).toBe("user-1");
    expect(result.plexToken).toBeUndefined();
    expect(cookies).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("refuses to save the session", async () => {
    const result = await principal.runAsApiKey(KEY, () => session.getSession());
    await expect(result.save()).rejects.toThrow(/no cookie session/);
  });

  it("refuses the cookie primitives the login flows use", async () => {
    await principal.runAsApiKey(KEY, async () => {
      await expect(session.getRawSession()).rejects.toThrow(/not available to API key requests/);
      await expect(session.rotateSession()).rejects.toThrow(/not available to API key requests/);
    });
    expect(cookies).not.toHaveBeenCalled();
  });

  it("reads the cookie as always outside an API key request", async () => {
    const jar = new Map<string, string>();
    cookies.mockResolvedValue({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => jar.set(name, value),
      delete: (name: string) => jar.delete(name),
    });
    const result = await session.getSession();
    expect(cookies).toHaveBeenCalled();
    expect(result.isLoggedIn).toBeFalsy();
  });
});
