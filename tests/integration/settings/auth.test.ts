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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{
      plexConnected: boolean;
      localAuthEnabled: boolean;
      hasPassword: boolean;
      displayName: string;
    }>(res);
    expect(body.localAuthEnabled).toBe(true);
    expect(body.plexConnected).toBe(true);
    expect(body.hasPassword).toBe(false);
    expect(body.displayName).toBe("testuser");
  });

  it("returns default localAuthEnabled=false when no AppSettings exists", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ localAuthEnabled: boolean }>(res);
    expect(body.localAuthEnabled).toBe(false);
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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { localAuthEnabled: "not-a-boolean" },
    });
    await expectJson(res, 400);
  });

  // ── SSO branches ───────────────────────────────────────────────────
  //
  // The PUT route also gates on SSO. Three relevant cases:
  //   1. Local form is hidden while SSO is usable, so localAuthEnabled alone
  //      can't be the only login method.
  //   2. SSO with a linked subject IS a valid fallback for the lockout guard.
  //   3. Toggling plexLoginEnabled off when SSO is the only remaining method
  //      must work without tripping the lockout guard.

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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ localAuthHiddenBySso: boolean }>(res);
    expect(body.localAuthHiddenBySso).toBe(true);
  });

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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { plexLoginEnabled: false },
    });
    const body = await expectJson<{ plexLoginEnabled: boolean }>(res);
    expect(body.plexLoginEnabled).toBe(false);
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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { plexLoginEnabled: false },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/no way to sign in/);
  });

  it("refuses to enable local auth without a passwordHash set", async () => {
    const user = await createTestUser();
    // passwordHash is null
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { localAuthEnabled: true },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/Set a local password first/);
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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

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
});
