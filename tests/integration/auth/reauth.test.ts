import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession, getMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// file deepcode ignore HardcodedNonCryptoSecret/test: Test file with hardcoded values

const mockGetPlexUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/plex/auth", () => ({ getPlexUser: mockGetPlexUser }));

const { mockDiscover } = vi.hoisted(() => ({ mockDiscover: vi.fn() }));
vi.mock("@/lib/sso/oidc-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sso/oidc-client")>()),
  discoverOidc: mockDiscover,
  resolveRedirectUri: () => "http://localhost:3000/api/auth/sso/oidc/callback",
}));

const { mockCheckAuthRateLimit, mockPeek, mockReserve, mockSucceeded } = vi.hoisted(() => {
  const mockSucceeded = vi.fn();
  return {
    mockCheckAuthRateLimit: vi.fn((): Response | null => null),
    mockPeek: vi.fn((): Response | null => null),
    mockReserve: vi.fn(
      (): { refused: Response } | { refused: null; succeeded: () => void } => ({ refused: null, succeeded: mockSucceeded }),
    ),
    mockSucceeded,
  };
});
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  PASSWORD_CONFIRM_BUCKET: "password-confirm",
  checkAuthRateLimit: mockCheckAuthRateLimit,
  peekAuthRateLimit: mockPeek,
  reserveAuthAttempt: mockReserve,
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST as plexPOST } from "@/app/api/auth/reauth/plex/route";
import { POST as oidcPOST } from "@/app/api/auth/reauth/oidc/route";
import { POST as forwardPOST } from "@/app/api/auth/reauth/forward/route";
import { POST as passwordPOST } from "@/app/api/auth/reauth/password/route";

const prisma = getTestPrisma();
const ISSUER = "https://idp.example.com";
const STALE = 1;
const TOO_MANY = () => Response.json({ error: "Too many attempts. Try again later." }, { status: 429 });

/** What `getPlexUser` answers for a plex.tv account. */
const plexAccount = (id: number, username: string) => ({
  id,
  uuid: `uuid-${id}`,
  email: `${username}@example.com`,
  username,
  authToken: `token-${id}`,
  thumb: `https://plex.tv/users/uuid-${id}/avatar`,
});

async function signIn(overrides: Parameters<typeof createTestUser>[0] = {}) {
  const user = await createTestUser(overrides);
  setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: STALE });
  return user;
}

describe("/api/auth/reauth/*", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // mockReset: a `mockResolvedValue` from one test must not answer the next.
    mockGetPlexUser.mockReset();
    mockDiscover.mockReset();
    mockCheckAuthRateLimit.mockReturnValue(null);
    mockPeek.mockReturnValue(null);
    mockReserve.mockReturnValue({ refused: null, succeeded: mockSucceeded });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("POST /api/auth/reauth/plex", () => {
    const call = (body: unknown) =>
      callRoute(plexPOST, { url: "/api/auth/reauth/plex", method: "POST", body });

    it("returns 401 when not signed in", async () => {
      await expectJson(await call({ authToken: "t" }), 401);
      expect(mockGetPlexUser).not.toHaveBeenCalled();
    });

    it("stamps the sign-in time for the linked Plex account", async () => {
      const user = await signIn({ plexId: "4242" });
      mockGetPlexUser.mockResolvedValue(plexAccount(4242, "me"));
      const before = Date.now();

      expect(await expectJson(await call({ authToken: "fresh" }), 200)).toEqual({ verified: true });
      expect(mockGetPlexUser).toHaveBeenCalledWith("fresh");
      expect(mockReserve).toHaveBeenCalledWith(expect.anything(), "plex-reauth");
      expect(mockSucceeded).toHaveBeenCalledTimes(1);

      const session = getMockSession();
      expect(session.authenticatedAt).toBeGreaterThanOrEqual(before);
      // The refreshed token goes to the User row only, never the cookie.
      expect("plexToken" in session).toBe(false);
      expect(session.userId).toBe(user.id);
      const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
      expect(refreshed?.plexToken).toBe("fresh");
    });

    it("refuses a different Plex account", async () => {
      const user = await signIn({ plexId: "4242" });
      mockGetPlexUser.mockResolvedValue(plexAccount(999, "other"));

      const body = await expectJson<{ error: string }>(await call({ authToken: "other" }), 403);
      expect(body.error).toMatch(/different account than the one linked/);
      expect(getMockSession().authenticatedAt).toBe(STALE);
      // A failed confirmation stays charged.
      expect(mockSucceeded).not.toHaveBeenCalled();
      const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
      expect(refreshed?.plexToken).toBe(user.plexToken);
    });

    it("refuses a token Plex rejects", async () => {
      await signIn({ plexId: "4242" });
      mockGetPlexUser.mockRejectedValue(new Error("Request failed with status code 401"));
      const body = await expectJson<{ error: string }>(await call({ authToken: "bad" }), 401);
      expect(body.error).toBe("Plex sign-in failed");
      expect(getMockSession().authenticatedAt).toBe(STALE);
      expect(mockSucceeded).not.toHaveBeenCalled();
    });

    it("stops before asking plex.tv when the attempt cannot be reserved", async () => {
      await signIn({ plexId: "4242" });
      mockReserve.mockReturnValue({ refused: TOO_MANY() });
      mockGetPlexUser.mockResolvedValue(plexAccount(4242, "me"));

      await expectJson(await call({ authToken: "fresh" }), 429);
      expect(mockGetPlexUser).not.toHaveBeenCalled();
      expect(getMockSession().authenticatedAt).toBe(STALE);
    });

    // Plex sign-in is turned off where a household shares the Plex account; a
    // Plex round-trip then proves no more here than it would at login.
    it("refuses while Plex sign-in is turned off", async () => {
      const user = await signIn({ plexId: "4242" });
      await prisma.appSettings.create({ data: { userId: user.id, plexLoginEnabled: false } });
      mockGetPlexUser.mockResolvedValue(plexAccount(4242, "me"));

      const body = await expectJson<{ error: string }>(await call({ authToken: "fresh" }), 400);
      expect(body.error).toBe("Plex sign-in is not available for this account");
      expect(mockGetPlexUser).not.toHaveBeenCalled();
      expect(getMockSession().authenticatedAt).toBe(STALE);
    });

    it("refuses an account with no linked Plex", async () => {
      const user = await signIn();
      await prisma.user.update({ where: { id: user.id }, data: { plexId: null } });
      const body = await expectJson<{ error: string }>(await call({ authToken: "t" }), 400);
      expect(body.error).toBe("Plex sign-in is not available for this account");
      expect(mockGetPlexUser).not.toHaveBeenCalled();
    });

    it("validates the body", async () => {
      await signIn();
      const body = await expectJson<{ error: string }>(await call({}), 400);
      expect(body.error).toBe("Validation failed");
      expect(mockGetPlexUser).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/auth/reauth/oidc", () => {
    const NONCE = "attempt-nonce-0123456789";
    const call = (body: unknown = { nonce: NONCE }) =>
      callRoute(oidcPOST, { url: "/api/auth/reauth/oidc", method: "POST", body });

    async function seedOidc(userId: string) {
      await prisma.appSettings.create({
        data: { userId, ssoMode: "OIDC", ssoEnabled: true, oidcIssuer: ISSUER, oidcClientId: "client" },
      });
      await prisma.user.update({
        where: { id: userId },
        data: { ssoEnabled: true, ssoSubject: "sub-1", ssoIssuer: ISSUER },
      });
    }

    it("returns 401 when not signed in", async () => {
      await expectJson(await call(), 401);
    });

    it("starts a reauth handshake that asks the IdP to sign in again", async () => {
      const user = await signIn();
      await seedOidc(user.id);
      mockDiscover.mockResolvedValue({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
      });

      const { authorizationUrl } = await expectJson<{ authorizationUrl: string }>(await call(), 200);
      const url = new URL(authorizationUrl);
      expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/auth`);
      expect(url.searchParams.get("prompt")).toBe("login");
      expect(url.searchParams.get("client_id")).toBe("client");
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/sso/oidc/callback");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      const session = getMockSession();
      expect(session.oidcFlow).toBe("reauth");
      expect(session.oidcVerifier).toEqual(expect.any(String));
      expect(url.searchParams.get("state")).toBe(session.oidcState);
      // The attempt's nonce rides in the state, so the popup's report reaches
      // that attempt only.
      expect(session.oidcState).toMatch(new RegExp(`\\.${NONCE}$`));
      // Only the callback stamps the sign-in time.
      expect(session.authenticatedAt).toBe(STALE);
    });

    it("refuses when no SSO identity is linked", async () => {
      const user = await signIn();
      await seedOidc(user.id);
      await prisma.user.update({ where: { id: user.id }, data: { ssoSubject: null } });
      const body = await expectJson<{ error: string }>(await call(), 400);
      expect(body.error).toBe("SSO sign-in is not available for this account");
      expect(mockDiscover).not.toHaveBeenCalled();
      expect(getMockSession().oidcFlow).toBeUndefined();
    });

    it("returns the limiter's 429 without starting a handshake", async () => {
      const user = await signIn();
      await seedOidc(user.id);
      mockCheckAuthRateLimit.mockReturnValue(TOO_MANY());

      await expectJson(await call(), 429);
      expect(mockCheckAuthRateLimit).toHaveBeenCalledWith(expect.anything(), "sso-oidc-reauth");
      expect(mockDiscover).not.toHaveBeenCalled();
      expect(getMockSession().oidcFlow).toBeUndefined();
    });

    it("requires a well-formed attempt nonce", async () => {
      const user = await signIn();
      await seedOidc(user.id);
      await expectJson(await call({}), 400);
      await expectJson(await call({ nonce: "short" }), 400);
      await expectJson(await call({ nonce: "has.a.dot.in.it.0123" }), 400);
      expect(getMockSession().oidcFlow).toBeUndefined();
    });

    it("refuses when OIDC is not configured", async () => {
      await signIn();
      const body = await expectJson<{ error: string }>(await call(), 400);
      expect(body.error).toBe("SSO sign-in is not available for this account");
      expect(getMockSession().oidcFlow).toBeUndefined();
    });
  });

  describe("POST /api/auth/reauth/forward", () => {
    // Forward-auth is not usable without the secret (forward-secret.ts); the
    // proxy sends it on every request, so every call here carries it unless
    // a test says otherwise.
    const SECRET = "proxy-secret-value";
    const PROXY = { "X-Librariarr-Proxy-Secret": SECRET };
    let previousSecret: string | undefined;
    beforeEach(() => {
      previousSecret = process.env.FORWARD_AUTH_SECRET;
      process.env.FORWARD_AUTH_SECRET = SECRET;
    });
    afterEach(() => {
      if (previousSecret === undefined) delete process.env.FORWARD_AUTH_SECRET;
      else process.env.FORWARD_AUTH_SECRET = previousSecret;
    });
    const call = (headers: Record<string, string> = {}) =>
      callRoute(forwardPOST, { url: "/api/auth/reauth/forward", method: "POST", body: {}, headers: { ...PROXY, ...headers } });

    async function seedForward(userId: string) {
      await prisma.appSettings.create({
        data: { userId, ssoMode: "FORWARD_AUTH", ssoEnabled: true, forwardAuthUserHeader: "Remote-User" },
      });
      await prisma.user.update({
        where: { id: userId },
        data: { ssoEnabled: true, ssoSubject: "alice", ssoIssuer: "forward-auth" },
      });
    }

    it("returns 401 when not signed in", async () => {
      await expectJson(await call({ "Remote-User": "alice" }), 401);
    });

    it("stamps the sign-in time when the proxy names the linked subject", async () => {
      const user = await signIn();
      await seedForward(user.id);
      const before = Date.now();
      expect(await expectJson(await call({ "Remote-User": "alice" }), 200)).toEqual({ verified: true });
      expect(getMockSession().authenticatedAt).toBeGreaterThanOrEqual(before);
      expect(mockSucceeded).toHaveBeenCalledTimes(1);
    });

    it("stops before reading the header when the attempt cannot be reserved", async () => {
      const user = await signIn();
      await seedForward(user.id);
      mockReserve.mockReturnValue({ refused: TOO_MANY() });

      await expectJson(await call({ "Remote-User": "alice" }), 429);
      expect(getMockSession().authenticatedAt).toBe(STALE);
    });

    it("refuses another subject or a missing header", async () => {
      const user = await signIn();
      await seedForward(user.id);
      await expectJson(await call({ "Remote-User": "mallory" }), 403);
      await expectJson(await call(), 403);
      expect(getMockSession().authenticatedAt).toBe(STALE);
      expect(mockSucceeded).not.toHaveBeenCalled();
    });

    it("requires the proxy secret the proxy was configured with", async () => {
      const user = await signIn();
      await seedForward(user.id);
      for (const wrong of ["", "guess"]) {
        await expectJson(await call({ "Remote-User": "alice", "X-Librariarr-Proxy-Secret": wrong }), 403);
        expect(getMockSession().authenticatedAt).toBe(STALE);
      }
      await expectJson(await call({ "Remote-User": "alice" }), 200);
    });

    // A stolen cookie can read the linked subject from /api/settings/sso/me;
    // with the secret unset the route must not accept the header at all.
    it("refuses with forward_auth_unconfigured while FORWARD_AUTH_SECRET is unset", async () => {
      const user = await signIn();
      await seedForward(user.id);
      delete process.env.FORWARD_AUTH_SECRET;
      const body = await expectJson<{ code: string }>(await call({ "Remote-User": "alice" }), 400);
      expect(body.code).toBe("forward_auth_unconfigured");
      expect(getMockSession().authenticatedAt).toBe(STALE);
    });

    it("refuses when forward-auth is not configured", async () => {
      await signIn();
      const body = await expectJson<{ error: string }>(await call({ "Remote-User": "alice" }), 400);
      expect(body.error).toBe("SSO sign-in is not available for this account");
      expect(getMockSession().authenticatedAt).toBe(STALE);
    });
  });
  describe("POST /api/auth/reauth/password", () => {
    const PASSWORD = "correct horse battery";
    const call = (body: unknown) =>
      callRoute(passwordPOST, { url: "/api/auth/reauth/password", method: "POST", body });

    /** A password and password sign-in on, unless `settings` say otherwise. */
    async function signInWithPassword(settings: Record<string, unknown> = { localAuthEnabled: true }) {
      const user = await signIn();
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
      });
      await prisma.appSettings.create({ data: { userId: user.id, ...settings } });
      return user;
    }

    // With password sign-in off the password is accepted for nothing — here
    // included — so it is never even compared.
    it.each([
      ["local login is off", { localAuthEnabled: false }],
      [
        "SSO replaces the local form",
        { localAuthEnabled: true, ssoEnabled: true, ssoMode: "OIDC", oidcIssuer: ISSUER, oidcClientId: "c" },
      ],
    ])("refuses the right password while %s", async (_label, settings) => {
      await signInWithPassword(settings);
      const body = await expectJson<{ error: string }>(await call({ password: PASSWORD }), 400);
      expect(body.error).toBe("Password sign-in is turned off");
      expect(getMockSession().authenticatedAt).toBe(STALE);
      expect(mockReserve).not.toHaveBeenCalled();
    });

    it("returns 401 when not signed in", async () => {
      await expectJson(await call({ password: PASSWORD }), 401);
    });

    it("stamps the sign-in time for the right password", async () => {
      await signInWithPassword();
      const before = Date.now();
      expect(await expectJson(await call({ password: PASSWORD }), 200)).toEqual({ verified: true });
      expect(getMockSession().authenticatedAt).toBeGreaterThanOrEqual(before);
      // Charged up front and given back: a right password costs nothing.
      expect(mockReserve).toHaveBeenCalledTimes(1);
      expect(mockSucceeded).toHaveBeenCalledTimes(1);
    });

    it("refuses a wrong password and charges it like a failed login", async () => {
      await signInWithPassword();
      const body = await expectJson<{ code: string }>(await call({ password: "nope" }), 403);
      expect(body.code).toBe("password_incorrect");
      expect(getMockSession().authenticatedAt).toBe(STALE);
      // The API-key step-up's bucket: one guess budget for both, not two.
      expect(mockReserve).toHaveBeenCalledTimes(1);
      expect(mockReserve).toHaveBeenCalledWith(expect.anything(), "password-confirm");
      expect(mockSucceeded).not.toHaveBeenCalled();
    });

    // Reserved before the compare, so concurrent guesses count as they start.
    it("stops before comparing when the attempt cannot be reserved", async () => {
      await signInWithPassword();
      const compare = vi.spyOn(bcrypt, "compare");
      try {
        mockReserve.mockReturnValue({ refused: TOO_MANY() });
        expect((await call({ password: PASSWORD })).status).toBe(429);
        expect(compare).not.toHaveBeenCalled();
        expect(getMockSession().authenticatedAt).toBe(STALE);
        expect(mockSucceeded).not.toHaveBeenCalled();
      } finally {
        compare.mockRestore();
      }
    });

    it("stops before checking once the limiter says so", async () => {
      await signInWithPassword();
      const compare = vi.spyOn(bcrypt, "compare");
      try {
        mockPeek.mockReturnValue(TOO_MANY());
        expect((await call({ password: PASSWORD })).status).toBe(429);
        expect(mockPeek).toHaveBeenCalledWith(expect.anything(), "password-confirm");
        expect(mockReserve).not.toHaveBeenCalled();
        expect(compare).not.toHaveBeenCalled();
        expect(getMockSession().authenticatedAt).toBe(STALE);
      } finally {
        compare.mockRestore();
      }
    });

    it("refuses an account with no password, and an empty one", async () => {
      await signIn();
      const noPassword = await expectJson<{ error: string }>(await call({ password: PASSWORD }), 400);
      expect(noPassword.error).toBe("This account has no password");
      const empty = await expectJson<{ error: string }>(await call({ password: "" }), 400);
      expect(empty.error).toBe("Validation failed");
      expect(mockReserve).not.toHaveBeenCalled();
      expect(getMockSession().authenticatedAt).toBe(STALE);
    });
  });
});
