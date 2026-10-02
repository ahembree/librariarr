import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

// Discovery cache invalidation is a side effect — verify the spy was called.
const mockInvalidateCache = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sso/oidc-client", () => ({
  invalidateOidcDiscoveryCache: mockInvalidateCache,
}));

import { GET, PUT } from "@/app/api/settings/sso/route";

const prisma = getTestPrisma();

describe("GET /api/settings/sso", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockInvalidateCache.mockClear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET, { method: "GET" });
    await expectJson(res, 401);
  });

  it("returns schema defaults when no AppSettings row exists yet", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{
      ssoEnabled: boolean;
      ssoMode: string;
      oidcIssuer: string | null;
      oidcUsernameClaim: string;
      hasPreviousConfig: boolean;
    }>(res);

    expect(body.ssoEnabled).toBe(false);
    expect(body.ssoMode).toBe("OIDC");
    expect(body.oidcIssuer).toBeNull();
    expect(body.oidcUsernameClaim).toBe("preferred_username");
    expect(body.hasPreviousConfig).toBe(false);
  });

  it("masks the client secret in the response", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
        oidcClientSecret: "super-secret-value",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{ oidcClientSecret: string }>(res);
    expect(body.oidcClientSecret).not.toContain("super-secret-value");
    expect(body.oidcClientSecret).toBe("••••••••");
  });

  it("reports hasPreviousConfig=true when a snapshot exists", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
        previousSsoConfig: { ssoMode: "OIDC", oidcIssuer: "https://old.example.com" },
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{ hasPreviousConfig: boolean }>(res);
    expect(body.hasPreviousConfig).toBe(true);
  });

  it("reports overrideActive=true when SSO_DISABLE_OVERRIDE is set", async () => {
    const original = process.env.SSO_DISABLE_OVERRIDE;
    process.env.SSO_DISABLE_OVERRIDE = "true";
    try {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const res = await callRoute(GET, { method: "GET" });
      const body = await expectJson<{ overrideActive: boolean }>(res);
      expect(body.overrideActive).toBe(true);
    } finally {
      if (original === undefined) delete process.env.SSO_DISABLE_OVERRIDE;
      else process.env.SSO_DISABLE_OVERRIDE = original;
    }
  });
});

describe("PUT /api/settings/sso", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockInvalidateCache.mockClear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { ssoMode: "OIDC" },
    });
    await expectJson(res, 401);
  });

  it("upserts when no AppSettings row exists", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: {
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });
    await expectJson(res, 200);

    const row = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(row?.oidcIssuer).toBe("https://idp.example.com");
    expect(row?.oidcClientId).toBe("client");
  });

  it("invalidates the OIDC discovery cache on save", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    await callRoute(PUT, {
      method: "PUT",
      body: { oidcIssuer: "https://idp.example.com" },
    });

    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
  });

  // ── Enable guards ─────────────────────────────────────────────────────

  it("refuses to enable SSO when OIDC issuer/client_id are missing", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "abc", ssoIssuer: "https://idp.example.com", ssoEnabled: true },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { ssoEnabled: true, ssoMode: "OIDC" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/OIDC issuer and client ID are required/);
  });

  it("refuses to enable SSO when admin has no SSO subject linked", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { ssoEnabled: true },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/Link an SSO identity/);
  });

  it("refuses to enable forward-auth without a user header", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "abc", ssoIssuer: "forward-auth", ssoEnabled: true },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { ssoEnabled: true, ssoMode: "FORWARD_AUTH", forwardAuthUserHeader: "" },
    });
    // The schema's .min(1) rejects empty strings before our guard runs.
    await expectJson(res, 400);
  });

  it("allows enabling SSO when subject is linked and config is complete", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "abc", ssoIssuer: "https://idp.example.com", ssoEnabled: true },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { ssoEnabled: true },
    });
    const body = await expectJson<{ ssoEnabled: boolean }>(res, 200);
    expect(body.ssoEnabled).toBe(true);
  });

  // ── Disable lockout guard ─────────────────────────────────────────────

  it("refuses to disable SSO when admin has no Plex and no local credentials", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        plexId: null,
        plexToken: null,
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
        localAuthEnabled: false,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { ssoEnabled: false },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/Cannot disable SSO/);
  });

  it("allows disabling SSO when Plex login is usable", async () => {
    const user = await createTestUser({ plexId: "p1" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "abc", ssoIssuer: "https://idp.example.com", ssoEnabled: true },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
        plexLoginEnabled: true,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { ssoEnabled: false },
    });
    const body = await expectJson<{ ssoEnabled: boolean }>(res, 200);
    expect(body.ssoEnabled).toBe(false);
  });

  // With local login on, SSO replacing the local form is what keeps the
  // password powerless; turning SSO off gives it back. A stale cookie that
  // knows the password must not be able to do that and then use it.
  it("asks a stale session to confirm before turning SSO off gives the password its power back", async () => {
    const user = await createTestUser({ plexId: "p1" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
        passwordHash: "h",
        localUsername: "alice",
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
        plexLoginEnabled: true,
        localAuthEnabled: true,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    const refused = await expectJson<{ code: string; methods: string[] }>(
      await callRoute(PUT, { method: "PUT", body: { ssoEnabled: false } }),
      403,
    );
    expect(refused.code).toBe("reauth_required");
    expect(refused.methods).not.toContain("password");
    expect((await prisma.appSettings.findFirstOrThrow()).ssoEnabled).toBe(true);

    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });
    const body = await expectJson<{ ssoEnabled: boolean }>(
      await callRoute(PUT, { method: "PUT", body: { ssoEnabled: false } }),
      200,
    );
    expect(body.ssoEnabled).toBe(false);
  });

  // With local login off the password stays powerless whatever SSO does, so
  // a stale session turning SSO off gives nothing back: no confirmation.
  it("lets a stale session with a password turn SSO off while local login is off", async () => {
    const user = await createTestUser({ plexId: "p1" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "abc", ssoIssuer: "https://idp.example.com", ssoEnabled: true, passwordHash: "h" },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
        plexLoginEnabled: true,
        localAuthEnabled: false,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    const body = await expectJson<{ ssoEnabled: boolean }>(
      await callRoute(PUT, { method: "PUT", body: { ssoEnabled: false } }),
      200,
    );
    expect(body.ssoEnabled).toBe(false);
  });

  // ── The admin's link must survive a save while SSO stays on ─────────────
  //
  // Another issuer, or the other mode, would orphan it: SSO login refuses the
  // admin as not_linked, the password is off because SSO replaces it, and
  // nothing is left to confirm "it's you" with to turn SSO off again.
  describe("while SSO stays on", () => {
    async function seedEnabled(ssoIssuer: string | null = "https://idp.example.com") {
      const user = await createTestUser({ plexId: "p1" });
      await prisma.user.update({
        where: { id: user.id },
        data: { ssoSubject: "abc", ssoIssuer, ssoEnabled: true, passwordHash: "h" },
      });
      await prisma.appSettings.create({
        data: {
          userId: user.id,
          ssoMode: "OIDC",
          ssoEnabled: true,
          oidcIssuer: "https://idp.example.com",
          oidcClientId: "client",
          plexLoginEnabled: false,
          localAuthEnabled: true,
        },
      });
      setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });
      return user;
    }

    it("refuses an issuer the admin's identity is not linked under", async () => {
      await seedEnabled();
      const body = await expectJson<{ error: string }>(
        await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "https://other.example.com" } }),
        400,
      );
      expect(body.error).toMatch(/linked under a different issuer/);
      expect((await prisma.appSettings.findFirstOrThrow()).oidcIssuer).toBe("https://idp.example.com");
    });

    it("refuses switching to forward-auth", async () => {
      await seedEnabled();
      await expectJson(await callRoute(PUT, { method: "PUT", body: { ssoMode: "FORWARD_AUTH" } }), 400);
      expect((await prisma.appSettings.findFirstOrThrow()).ssoMode).toBe("OIDC");
    });

    it("refuses turning SSO on when the link is under another issuer", async () => {
      const user = await seedEnabled("https://old.example.com");
      await prisma.appSettings.update({ where: { userId: user.id }, data: { ssoEnabled: false } });
      await expectJson(await callRoute(PUT, { method: "PUT", body: { ssoEnabled: true } }), 400);
      expect((await prisma.appSettings.findFirstOrThrow()).ssoEnabled).toBe(false);
    });

    it("accepts the same issuer written with a trailing slash, and a link from before issuers were stored", async () => {
      await seedEnabled();
      await expectJson(await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "https://idp.example.com/" } }), 200);

      await cleanDatabase();
      await seedEnabled(null);
      await expectJson(await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "https://other.example.com" } }), 200);
    });

    // Whitespace saves as null, so a blank client ID would store SSO as on
    // but unusable.
    it("refuses a blank client ID", async () => {
      await seedEnabled();
      await expectJson(await callRoute(PUT, { method: "PUT", body: { oidcClientId: "   " } }), 400);
      expect((await prisma.appSettings.findFirstOrThrow()).oidcClientId).toBe("client");
    });
  });

  it("refuses to disable SSO when Plex is linked but plexLoginEnabled is false", async () => {
    const user = await createTestUser({ plexId: "p1" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "abc", ssoIssuer: "https://idp.example.com", ssoEnabled: true },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
        plexLoginEnabled: false,
        localAuthEnabled: false,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { ssoEnabled: false },
    });
    await expectJson(res, 400);
  });

  // ── Snapshot semantics ────────────────────────────────────────────────

  it("captures previousSsoConfig snapshot when writable fields change", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        oidcIssuer: "https://old.example.com",
        oidcClientId: "old-client",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await callRoute(PUT, {
      method: "PUT",
      body: { oidcIssuer: "https://new.example.com", oidcClientId: "new-client" },
    });

    const row = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(row?.oidcIssuer).toBe("https://new.example.com");
    const snap = row?.previousSsoConfig as Record<string, unknown> | null;
    expect(snap?.oidcIssuer).toBe("https://old.example.com");
    expect(snap?.oidcClientId).toBe("old-client");
    // Snapshot never carries ssoEnabled=true (revert never auto-re-enables)
    expect(snap?.ssoEnabled).toBe(false);
  });

  it("does NOT overwrite an earlier snapshot on a no-op save", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        oidcIssuer: "https://current.example.com",
        oidcClientId: "current-client",
        previousSsoConfig: {
          ssoMode: "OIDC",
          oidcIssuer: "https://genuine-old.example.com",
          oidcClientId: "old-client",
        },
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    // No-op: writable fields unchanged. (ssoEnabled is excluded from the
    // comparison so toggling it doesn't itself count as a change for the
    // snapshot — but we're not toggling here either.)
    await callRoute(PUT, {
      method: "PUT",
      body: {
        oidcIssuer: "https://current.example.com",
        oidcClientId: "current-client",
      },
    });

    const row = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    const snap = row?.previousSsoConfig as Record<string, unknown> | null;
    expect(snap?.oidcIssuer).toBe("https://genuine-old.example.com");
  });
});
