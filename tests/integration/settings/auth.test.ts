import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import AFTER mocks
import { GET, PUT } from "@/app/api/settings/auth/route";

const prisma = getTestPrisma();

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/settings/auth
// ---------------------------------------------------------------------------
describe("GET /api/settings/auth", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns current auth settings", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, localAuthEnabled: true },
    });
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson(res);
    expect(body).toEqual({
      plexConnected: true,
      localUsername: null,
      hasPassword: false,
      localAuthEnabled: true,
      plexLoginEnabled: true,
      localAuthHiddenBySso: false,
      passwordSignInEnabled: true,
      displayName: "testuser",
    });
  });

  it("returns default localAuthEnabled=false when no AppSettings exists", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ localAuthEnabled: boolean; plexLoginEnabled: boolean }>(res);
    expect(body.localAuthEnabled).toBe(false);
    expect(body.plexLoginEnabled).toBe(true);
  });

  it("reports localAuthHiddenBySso=true when SSO is usable", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        localAuthEnabled: true,
        ssoEnabled: true,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ localAuthHiddenBySso: boolean; passwordSignInEnabled: boolean }>(res);
    expect(body.localAuthHiddenBySso).toBe(true);
    // SSO replaces the local form, so the password is accepted for nothing.
    expect(body.passwordSignInEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/auth
// ---------------------------------------------------------------------------
describe("PUT /api/settings/auth", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { localAuthEnabled: true },
    });
    await expectJson(res, 401);
  });

  it("returns 400 on invalid body", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { localAuthEnabled: "not-a-boolean" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["localAuthEnabled: Invalid input: expected boolean, received string"]);
    expect(await prisma.appSettings.count()).toBe(0);
  });

  // ── SSO branches ───────────────────────────────────────────────────
  //
  // The PUT route also gates on SSO. Three relevant cases:
  //   1. Local form is hidden while SSO is usable, so localAuthEnabled alone
  //      can't be the only login method.
  //   2. SSO with a linked subject IS a valid fallback for the lockout guard.
  //   3. Toggling plexLoginEnabled off when SSO is the only remaining method
  //      must work without tripping the lockout guard.

  it("allows disabling Plex login when SSO is the fallback", async () => {
    const user = await createTestUser({ plexId: "p1" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "abc", ssoIssuer: "https://idp.example.com", ssoEnabled: true },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        plexLoginEnabled: true,
        ssoEnabled: true,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { plexLoginEnabled: false },
    });
    const body = await expectJson<{ plexLoginEnabled: boolean }>(res);
    expect(body.plexLoginEnabled).toBe(false);
    expect((await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.plexLoginEnabled).toBe(false);
  });

  it("rejects disabling Plex login when SSO is the only fallback but unlinked", async () => {
    // Global SSO is enabled but the user has no ssoSubject — that's NOT a
    // usable fallback. The lockout guard must reject.
    const user = await createTestUser({ plexId: "p1" });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        plexLoginEnabled: true,
        localAuthEnabled: false,
        ssoEnabled: true,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { plexLoginEnabled: false },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/no way to sign in/);
    expect((await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.plexLoginEnabled).toBe(true);
  });

  it("rejects turning local login off when it is the only way in", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { plexId: null, passwordHash: "hashed_existing", localUsername: "testuser" },
    });
    await prisma.appSettings.create({ data: { userId: user.id, localAuthEnabled: true } });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });

    const res = await callRoute(PUT, { method: "PUT", body: { localAuthEnabled: false } });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/no way to sign in/);
    expect((await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.localAuthEnabled).toBe(true);
  });

  it("refuses to enable local auth without a passwordHash set", async () => {
    const user = await createTestUser();
    // passwordHash is null
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { localAuthEnabled: true },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/Set a local password first/);
    expect(await prisma.appSettings.count()).toBe(0);
  });

  it("updates localAuthEnabled to true", async () => {
    const user = await createTestUser();
    // The PUT now refuses to enable local login without a passwordHash set
    // — otherwise the form would appear on the login page but every
    // submission would fail. The UI's credential-prompt dialog covers this
    // in the client, but the route enforces server-side too. Set the hash
    // explicitly here to exercise the happy path.
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_existing", localUsername: "testuser" },
    });
    // Turning local login on gives the password its power back: it needs a
    // recent sign-in (refused otherwise, below).
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { localAuthEnabled: true },
    });
    const body = await expectJson<{ localAuthEnabled: boolean }>(res);
    expect(body.localAuthEnabled).toBe(true);

    // Verify persisted
    const settings = await prisma.appSettings.findUnique({
      where: { userId: user.id },
    });
    expect(settings?.localAuthEnabled).toBe(true);
  });

  // While local login is off the password is accepted for nothing. A stolen
  // cookie that knows an old password must not be able to switch it back on
  // and then use it, so turning it on needs a recent sign-in — by another
  // method: the password is not offered.
  it("refuses to turn local login on from a stale session", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_existing", localUsername: "testuser" },
    });
    await prisma.appSettings.create({ data: { userId: user.id, localAuthEnabled: false } });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    const body = await expectJson<{ code: string; methods: string[] }>(
      await callRoute(PUT, { method: "PUT", body: { localAuthEnabled: true } }),
      403,
    );
    expect(body.code).toBe("reauth_required");
    expect(body.methods).toEqual(["plex"]);
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.localAuthEnabled).toBe(false);
  });

  it("lets a stale session turn local login off, or on while SSO still replaces it", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_existing", localUsername: "testuser", ssoSubject: "sub", ssoEnabled: true },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        localAuthEnabled: false,
        ssoEnabled: true,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    // SSO hides the local form, so the password stays off: nothing to confirm.
    const stored = async () => (await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.localAuthEnabled;
    await expectJson(await callRoute(PUT, { method: "PUT", body: { localAuthEnabled: true } }), 200);
    expect(await stored()).toBe(true);
    await expectJson(await callRoute(PUT, { method: "PUT", body: { localAuthEnabled: false } }), 200);
    expect(await stored()).toBe(false);
  });

  // Plex login is turned off where a household shares the Plex account:
  // turning it back on lets whoever holds that account sign in, so a stolen
  // cookie must not be able to do it any more than turn the password on.
  describe("turning Plex login on", () => {
    const STALE = Date.now() - 16 * 60 * 1000;

    async function seed(plexId: string | null = "plex-1") {
      const user = await createTestUser();
      await prisma.user.update({
        where: { id: user.id },
        data: { plexId, passwordHash: "hashed_existing", localUsername: "testuser" },
      });
      await prisma.appSettings.create({
        data: { userId: user.id, localAuthEnabled: true, plexLoginEnabled: false },
      });
      return user;
    }

    it("needs a recent sign-in, by another method", async () => {
      const user = await seed();
      setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: STALE });

      const body = await expectJson<{ code: string; methods: string[]; error: string }>(
        await callRoute(PUT, { method: "PUT", body: { plexLoginEnabled: true } }),
        403,
      );
      expect(body.code).toBe("reauth_required");
      expect(body.error).toMatch(/^Turning on Plex login/);
      expect(body.methods).toEqual(["password"]);
      const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
      expect(settings?.plexLoginEnabled).toBe(false);

      setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });
      await expectJson(await callRoute(PUT, { method: "PUT", body: { plexLoginEnabled: true } }), 200);
      const after = await prisma.appSettings.findUnique({ where: { userId: user.id } });
      expect(after?.plexLoginEnabled).toBe(true);
    });

    it("lets a stale session turn it off, or on with no Plex account linked", async () => {
      const unlinked = await seed(null);
      setMockSession({ isLoggedIn: true, userId: unlinked.id, authenticatedAt: STALE });
      const stored = async () =>
        (await prisma.appSettings.findUnique({ where: { userId: unlinked.id } }))?.plexLoginEnabled;
      await expectJson(await callRoute(PUT, { method: "PUT", body: { plexLoginEnabled: true } }), 200);
      expect(await stored()).toBe(true);
      await expectJson(await callRoute(PUT, { method: "PUT", body: { plexLoginEnabled: false } }), 200);
      expect(await stored()).toBe(false);
    });

    it("asks nothing under SSO_DISABLE_OVERRIDE, which already accepts a Plex login", async () => {
      const user = await seed();
      setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: STALE });
      vi.stubEnv("SSO_DISABLE_OVERRIDE", "true");
      try {
        await expectJson(await callRoute(PUT, { method: "PUT", body: { plexLoginEnabled: true } }), 200);
      } finally {
        vi.unstubAllEnvs();
      }
      expect((await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.plexLoginEnabled).toBe(true);
    });
  });

  // SSO_DISABLE_OVERRIDE is the recovery path when SSO is down: password
  // sign-in is on regardless, as at login, so nothing is being turned on.
  it("under SSO_DISABLE_OVERRIDE, reports password sign-in on and asks nothing to turn local login on", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_existing", localUsername: "testuser" },
    });
    await prisma.appSettings.create({ data: { userId: user.id, localAuthEnabled: false } });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });
    vi.stubEnv("SSO_DISABLE_OVERRIDE", "true");
    try {
      const info = await expectJson<{ passwordSignInEnabled: boolean }>(await callRoute(GET));
      expect(info.passwordSignInEnabled).toBe(true);
      await expectJson(await callRoute(PUT, { method: "PUT", body: { localAuthEnabled: true } }), 200);
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.localAuthEnabled).toBe(true);
  });
});
