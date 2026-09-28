import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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

vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  checkAuthRateLimit: () => null,
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

const prisma = getTestPrisma();
const ISSUER = "https://idp.example.com";
const STALE = 1;

async function signIn(overrides: Parameters<typeof createTestUser>[0] = {}) {
  const user = await createTestUser(overrides);
  setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "old", authenticatedAt: STALE });
  return user;
}

describe("/api/auth/reauth/*", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
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
      mockGetPlexUser.mockResolvedValue({ id: 4242, username: "me", email: "me@example.com" });
      const before = Date.now();

      await expectJson(await call({ authToken: "fresh" }), 200);

      const session = getMockSession();
      expect(session.authenticatedAt).toBeGreaterThanOrEqual(before);
      expect(session.plexToken).toBe("fresh");
      expect(session.userId).toBe(user.id);
      const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
      expect(refreshed?.plexToken).toBe("fresh");
    });

    it("refuses a different Plex account", async () => {
      const user = await signIn({ plexId: "4242" });
      mockGetPlexUser.mockResolvedValue({ id: 999, username: "other", email: "o@example.com" });

      await expectJson(await call({ authToken: "other" }), 403);
      expect(getMockSession().authenticatedAt).toBe(STALE);
      const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
      expect(refreshed?.plexToken).not.toBe("other");
    });

    it("refuses a token Plex rejects", async () => {
      await signIn({ plexId: "4242" });
      mockGetPlexUser.mockRejectedValue(new Error("401"));
      await expectJson(await call({ authToken: "bad" }), 401);
      expect(getMockSession().authenticatedAt).toBe(STALE);
    });

    it("refuses an account with no linked Plex", async () => {
      const user = await signIn();
      await prisma.user.update({ where: { id: user.id }, data: { plexId: null } });
      await expectJson(await call({ authToken: "t" }), 400);
      expect(mockGetPlexUser).not.toHaveBeenCalled();
    });

    it("validates the body", async () => {
      await signIn();
      await expectJson(await call({}), 400);
    });
  });

  describe("POST /api/auth/reauth/oidc", () => {
    const call = () => callRoute(oidcPOST, { url: "/api/auth/reauth/oidc", method: "POST", body: {} });

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
      expect(url.searchParams.get("prompt")).toBe("login");
      const session = getMockSession();
      expect(session.oidcFlow).toBe("reauth");
      expect(url.searchParams.get("state")).toBe(session.oidcState);
      // Only the callback stamps the sign-in time.
      expect(session.authenticatedAt).toBe(STALE);
    });

    it("refuses when no SSO identity is linked", async () => {
      const user = await signIn();
      await seedOidc(user.id);
      await prisma.user.update({ where: { id: user.id }, data: { ssoSubject: null } });
      await expectJson(await call(), 400);
      expect(getMockSession().oidcFlow).toBeUndefined();
    });

    it("refuses when OIDC is not configured", async () => {
      await signIn();
      await expectJson(await call(), 400);
    });
  });

  describe("POST /api/auth/reauth/forward", () => {
    const call = (headers: Record<string, string> = {}) =>
      callRoute(forwardPOST, { url: "/api/auth/reauth/forward", method: "POST", body: {}, headers });

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
      await expectJson(await call({ "Remote-User": "alice" }), 200);
      expect(getMockSession().authenticatedAt).toBeGreaterThanOrEqual(before);
    });

    it("refuses another subject or a missing header", async () => {
      const user = await signIn();
      await seedForward(user.id);
      await expectJson(await call({ "Remote-User": "mallory" }), 403);
      await expectJson(await call(), 403);
      expect(getMockSession().authenticatedAt).toBe(STALE);
    });

    it("requires FORWARD_AUTH_SECRET when it is set", async () => {
      const user = await signIn();
      await seedForward(user.id);
      const previous = process.env.FORWARD_AUTH_SECRET;
      process.env.FORWARD_AUTH_SECRET = "proxy-secret-value";
      try {
        await expectJson(await call({ "Remote-User": "alice" }), 403);
        expect(getMockSession().authenticatedAt).toBe(STALE);
        await expectJson(
          await call({ "Remote-User": "alice", "X-Librariarr-Proxy-Secret": "proxy-secret-value" }),
          200,
        );
      } finally {
        if (previous === undefined) delete process.env.FORWARD_AUTH_SECRET;
        else process.env.FORWARD_AUTH_SECRET = previous;
      }
    });

    it("refuses when forward-auth is not configured", async () => {
      await signIn();
      await expectJson(await call({ "Remote-User": "alice" }), 400);
    });
  });
});
