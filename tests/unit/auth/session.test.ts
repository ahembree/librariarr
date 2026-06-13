import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The global setup file (tests/setup/mock-session.ts) mocks @/lib/auth/session
// for every test. This file is the exception — it tests the REAL module, so opt
// out of that global mock and drive its dependencies instead.
vi.unmock("@/lib/auth/session");

/**
 * Unit tests for the iron-session wrapper. Auth/session handling is security
 * critical, so this exercises every branch of secret resolution, the Secure
 * cookie attribute, and session validation — all with iron-session, next/headers,
 * the DB, and fs mocked (no real cookies/files/DB).
 *
 * `getSessionOptions` memoizes the secret + cookie options on first use, so each
 * test resets the module registry and re-applies mocks via `vi.doMock` (which,
 * unlike hoisted `vi.mock`, applies to the dynamic import that follows a reset).
 */
const mockGetIronSession = vi.fn();
const mockCookies = vi.fn();
const mockUserFindUnique = vi.fn();
const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const ORIG_SECRET = process.env.SESSION_SECRET;
const ORIG_COOKIE_SECURE = process.env.COOKIE_SECURE;
const VALID_SECRET = "x".repeat(40);

type SessionModule = typeof import("@/lib/auth/session");
const load = (): Promise<SessionModule> => import("@/lib/auth/session");

beforeEach(() => {
  vi.resetModules();
  mockGetIronSession.mockReset();
  mockCookies.mockReset().mockResolvedValue({ get: vi.fn(), set: vi.fn() });
  mockUserFindUnique.mockReset();
  for (const f of Object.values(mockFs)) f.mockReset();
  mockFs.existsSync.mockReturnValue(false);
  for (const f of Object.values(mockLogger)) f.mockReset();

  // doMock (not hoisted) applies to the dynamic import() each test performs
  // after the registry reset above.
  vi.doMock("iron-session", () => ({ getIronSession: mockGetIronSession }));
  vi.doMock("next/headers", () => ({ cookies: mockCookies }));
  vi.doMock("@/lib/db", () => ({ prisma: { user: { findUnique: mockUserFindUnique } } }));
  vi.doMock("@/lib/logger", () => ({ logger: mockLogger }));
  vi.doMock("fs", () => ({ default: mockFs, ...mockFs }));

  // Default: a valid env secret so getSession() succeeds unless a test overrides.
  process.env.SESSION_SECRET = VALID_SECRET;
  delete process.env.COOKIE_SECURE;
});

afterEach(() => {
  vi.doUnmock("iron-session");
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/db");
  vi.doUnmock("@/lib/logger");
  vi.doUnmock("fs");
  if (ORIG_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIG_SECRET;
  if (ORIG_COOKIE_SECURE === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = ORIG_COOKIE_SECURE;
});

/** Read the SessionOptions getSession() passed to getIronSession. */
function lastSessionOptions(): {
  password: string;
  cookieName: string;
  cookieOptions: { secure: boolean; httpOnly: boolean; sameSite: string; maxAge: number };
} {
  return mockGetIronSession.mock.calls.at(-1)![1];
}

describe("getSession — session options & secret resolution", () => {
  it("uses SESSION_SECRET from the environment when it is >= 32 chars", async () => {
    mockGetIronSession.mockResolvedValue({});
    const { getSession } = await load();
    await getSession();

    const opts = lastSessionOptions();
    expect(opts.password).toBe(VALID_SECRET);
    expect(opts.cookieName).toBe("librariarr_session");
    expect(opts.cookieOptions.httpOnly).toBe(true);
    expect(opts.cookieOptions.sameSite).toBe("lax");
    expect(opts.cookieOptions.maxAge).toBe(60 * 60 * 24 * 30);
    expect(mockFs.existsSync).not.toHaveBeenCalled();
  });

  it("throws when SESSION_SECRET is set but shorter than 32 chars", async () => {
    process.env.SESSION_SECRET = "too-short";
    mockGetIronSession.mockResolvedValue({});
    const { getSession } = await load();
    await expect(getSession()).rejects.toThrow(/at least 32 characters/i);
  });

  it("reads a persisted secret file when no env secret is set", async () => {
    delete process.env.SESSION_SECRET;
    const fileSecret = "f".repeat(64);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(`${fileSecret}\n`);
    mockGetIronSession.mockResolvedValue({});

    const { getSession } = await load();
    await getSession();

    expect(lastSessionOptions().password).toBe(fileSecret);
    expect(mockFs.readFileSync).toHaveBeenCalledWith("/config/.session-secret", "utf-8");
    expect(mockLogger.info).toHaveBeenCalled();
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("generates and persists a new secret when none exists", async () => {
    delete process.env.SESSION_SECRET;
    mockFs.existsSync.mockReturnValue(false);
    mockGetIronSession.mockResolvedValue({});

    const { getSession } = await load();
    await getSession();

    const opts = lastSessionOptions();
    expect(opts.password).toMatch(/^[0-9a-f]{64}$/);
    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/config", { recursive: true });
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/config/.session-secret",
      expect.stringMatching(/^[0-9a-f]{64}\n$/),
      expect.objectContaining({ mode: 0o600 }),
    );
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it("falls back to generating a secret when the persisted file is too short", async () => {
    delete process.env.SESSION_SECRET;
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("short\n");
    mockGetIronSession.mockResolvedValue({});

    const { getSession } = await load();
    await getSession();

    expect(lastSessionOptions().password).toMatch(/^[0-9a-f]{64}$/);
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });

  it("falls back to generating a secret when the file is unreadable", async () => {
    delete process.env.SESSION_SECRET;
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation(() => { throw new Error("EACCES"); });
    mockGetIronSession.mockResolvedValue({});

    const { getSession } = await load();
    await getSession();

    expect(lastSessionOptions().password).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still returns a generated secret (with a warning) when persisting fails", async () => {
    delete process.env.SESSION_SECRET;
    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => { throw new Error("EROFS: read-only filesystem"); });
    mockGetIronSession.mockResolvedValue({});

    const { getSession } = await load();
    await getSession();

    expect(lastSessionOptions().password).toMatch(/^[0-9a-f]{64}$/);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("memoizes options across calls (single secret resolution)", async () => {
    delete process.env.SESSION_SECRET;
    mockFs.existsSync.mockReturnValue(false);
    mockGetIronSession.mockResolvedValue({});

    const { getSession } = await load();
    await getSession();
    await getSession();

    expect(mockGetIronSession).toHaveBeenCalledTimes(2);
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const [first, second] = mockGetIronSession.mock.calls;
    expect(first[1].password).toBe(second[1].password);
  });
});

describe("getSession — Secure cookie attribute (COOKIE_SECURE)", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["yes", true],
    ["TRUE", true],
    ["  Yes  ", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["nonsense", false],
  ])("COOKIE_SECURE=%j → secure %s", async (raw, expected) => {
    process.env.COOKIE_SECURE = raw;
    mockGetIronSession.mockResolvedValue({});
    const { getSession } = await load();
    await getSession();
    expect(lastSessionOptions().cookieOptions.secure).toBe(expected);
  });

  it("defaults secure to false when COOKIE_SECURE is unset", async () => {
    delete process.env.COOKIE_SECURE;
    mockGetIronSession.mockResolvedValue({});
    const { getSession } = await load();
    await getSession();
    expect(lastSessionOptions().cookieOptions.secure).toBe(false);
  });
});

describe("isSessionValid", () => {
  it("returns false when the session is not logged in", async () => {
    mockGetIronSession.mockResolvedValue({ isLoggedIn: false });
    const { isSessionValid } = await load();
    expect(await isSessionValid()).toBe(false);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("returns false when logged in but there is no userId", async () => {
    mockGetIronSession.mockResolvedValue({ isLoggedIn: true });
    const { isSessionValid } = await load();
    expect(await isSessionValid()).toBe(false);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("returns true when the user exists and the session version matches", async () => {
    mockGetIronSession.mockResolvedValue({ isLoggedIn: true, userId: "u1", sessionVersion: 3 });
    mockUserFindUnique.mockResolvedValue({ id: "u1", sessionVersion: 3 });
    const { isSessionValid } = await load();
    expect(await isSessionValid()).toBe(true);
  });

  it("returns true when the session carries no version (no version check)", async () => {
    mockGetIronSession.mockResolvedValue({ isLoggedIn: true, userId: "u1" });
    mockUserFindUnique.mockResolvedValue({ id: "u1", sessionVersion: 7 });
    const { isSessionValid } = await load();
    expect(await isSessionValid()).toBe(true);
  });

  it("returns false when the session version is stale", async () => {
    mockGetIronSession.mockResolvedValue({ isLoggedIn: true, userId: "u1", sessionVersion: 1 });
    mockUserFindUnique.mockResolvedValue({ id: "u1", sessionVersion: 2 });
    const { isSessionValid } = await load();
    expect(await isSessionValid()).toBe(false);
  });

  it("returns false when the user no longer exists", async () => {
    mockGetIronSession.mockResolvedValue({ isLoggedIn: true, userId: "ghost", sessionVersion: 1 });
    mockUserFindUnique.mockResolvedValue(null);
    const { isSessionValid } = await load();
    expect(await isSessionValid()).toBe(false);
  });

  it("returns false when the database lookup throws", async () => {
    mockGetIronSession.mockResolvedValue({ isLoggedIn: true, userId: "u1", sessionVersion: 1 });
    mockUserFindUnique.mockRejectedValue(new Error("db down"));
    const { isSessionValid } = await load();
    expect(await isSessionValid()).toBe(false);
  });
});
