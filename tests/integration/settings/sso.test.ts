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
import { MASKED_VALUE } from "@/lib/api/sanitize";
import { oidcIssuerProblem } from "@/lib/sso/issuer-url";

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
    const body = await expectJson(res);

    expect(body).toMatchObject({
      ssoEnabled: false,
      ssoMode: "OIDC",
      oidcIssuer: null,
      oidcClientId: null,
      oidcClientSecret: null,
      oidcScopes: "openid profile email",
      oidcUsernameClaim: "preferred_username",
      forwardAuthUserHeader: "Remote-User",
      forwardAuthEmailHeader: "Remote-Email",
      forwardAuthNameHeader: "Remote-Name",
      overrideActive: false,
      hasPreviousConfig: false,
    });
    // Nothing is created by a read.
    expect(await prisma.appSettings.count()).toBe(0);
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
    expect(body.oidcClientSecret).toBe(MASKED_VALUE);
    expect(JSON.stringify(body)).not.toContain("super-secret-value");
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
    expect(await prisma.appSettings.count()).toBe(0);
  });

  it("refuses a save requested from another origin", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, ssoMode: "OIDC", oidcIssuer: "https://idp.example.com", oidcClientId: "client" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });

    const res = await callRoute(PUT, {
      method: "PUT",
      headers: { Origin: "https://evil.example.com" },
      body: { oidcIssuer: "https://attacker.example" },
    });
    const body = await expectJson<{ error: string }>(res, 403);
    expect(body.error).toBe("Forbidden");
    expect((await prisma.appSettings.findFirstOrThrow()).oidcIssuer).toBe("https://idp.example.com");
  });

  // The form echoes the GET's mask back; that keeps the stored secret, it
  // is never written over it.
  it("keeps the stored client secret when the mask comes back, and replaces it with a new one", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
        oidcClientSecret: "real-secret",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const masked = await expectJson<{ oidcClientSecret: string }>(
      await callRoute(PUT, { method: "PUT", body: { oidcClientId: "client-2", oidcClientSecret: MASKED_VALUE } }),
    );
    expect(masked.oidcClientSecret).toBe(MASKED_VALUE);
    let row = await prisma.appSettings.findFirstOrThrow();
    expect(row.oidcClientSecret).toBe("real-secret");
    expect(row.oidcClientId).toBe("client-2");

    await expectJson(await callRoute(PUT, { method: "PUT", body: { oidcClientSecret: "rotated-secret" } }));
    row = await prisma.appSettings.findFirstOrThrow();
    expect(row.oidcClientSecret).toBe("rotated-secret");
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

    await expectJson(await callRoute(PUT, {
      method: "PUT",
      body: { oidcIssuer: "https://idp.example.com" },
    }));

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
    expect(body.error).toBe("OIDC issuer and client ID are required to enable SSO");
    expect(await prisma.appSettings.count()).toBe(0);
    expect(mockInvalidateCache).not.toHaveBeenCalled();
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
    expect((await prisma.appSettings.findFirstOrThrow()).ssoEnabled).toBe(false);
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
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^forwardAuthUserHeader: /);
    expect(await prisma.appSettings.count()).toBe(0);
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
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { ssoEnabled: true },
    });
    const body = await expectJson<{ ssoEnabled: boolean }>(res, 200);
    expect(body.ssoEnabled).toBe(true);
    expect((await prisma.appSettings.findFirstOrThrow()).ssoEnabled).toBe(true);
  });

  // Turning SSO on applies whatever identity settings were saved while it was
  // off, so a stale session must not be the one to do it.
  it("asks a stale session to confirm it's them before turning SSO on", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "abc", ssoIssuer: "https://idp.example.com", ssoEnabled: true },
    });
    await prisma.appSettings.create({
      data: { userId: user.id, ssoMode: "OIDC", oidcIssuer: "https://idp.example.com", oidcClientId: "client" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    const refused = await expectJson<{ code: string }>(
      await callRoute(PUT, { method: "PUT", body: { ssoEnabled: true } }),
      403,
    );
    expect(refused.code).toBe("reauth_required");
    expect((await prisma.appSettings.findFirstOrThrow()).ssoEnabled).toBe(false);
  });

  // A link made before issuers were recorded is accepted under any issuer, so
  // a stale cookie that could repoint SSO at its own IdP would answer an OIDC
  // confirmation with the admin's subject and come back with a fresh sign-in.
  it("asks a stale session to confirm it's them before changing the OIDC issuer while SSO is on", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "abc", ssoIssuer: null, ssoEnabled: true },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id, ssoEnabled: true, ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com", oidcClientId: "client", oidcClientSecret: "real-secret",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    const refused = await expectJson<{ code: string }>(
      await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "https://attacker.example" } }),
      403,
    );
    expect(refused.code).toBe("reauth_required");
    expect((await prisma.appSettings.findFirstOrThrow()).oidcIssuer).toBe("https://idp.example.com");

    // A trailing slash names the same issuer.
    await expectJson(await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "https://idp.example.com/" } }), 200);

    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });
    await expectJson(await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "https://idp2.example.com" } }), 200);
    expect((await prisma.appSettings.findFirstOrThrow()).oidcIssuer).toBe("https://idp2.example.com");
  });

  it("lets setup change the OIDC issuer while SSO is off without a recent sign-in", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, ssoMode: "OIDC", oidcIssuer: "https://idp.example.com", oidcClientId: "client" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    await expectJson(await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "https://idp2.example.com" } }), 200);
    expect((await prisma.appSettings.findFirstOrThrow()).oidcIssuer).toBe("https://idp2.example.com");
  });

  // A proxy overwrites its own identity header but passes others through from
  // the client: pointed at one of those, anyone the proxy admits could send the
  // admin's subject in it.
  it("asks a stale session to confirm it's them before changing the forward-auth user header", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, ssoMode: "FORWARD_AUTH", forwardAuthUserHeader: "Remote-User" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    for (const body of [{ forwardAuthUserHeader: "X-Passthrough-User" }, { ssoMode: "OIDC" }]) {
      const refused = await expectJson<{ code: string }>(await callRoute(PUT, { method: "PUT", body }), 403);
      expect(refused.code).toBe("reauth_required");
    }
    const stored = await prisma.appSettings.findFirstOrThrow();
    expect(stored.forwardAuthUserHeader).toBe("Remote-User");
    expect(stored.ssoMode).toBe("FORWARD_AUTH");

    // The other headers carry no identity; a recent sign-in may change the user header.
    await expectJson(await callRoute(PUT, { method: "PUT", body: { forwardAuthEmailHeader: "X-Email" } }), 200);
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });
    const body = await expectJson<{ forwardAuthUserHeader: string }>(
      await callRoute(PUT, { method: "PUT", body: { forwardAuthUserHeader: "X-Forwarded-User" } }),
      200,
    );
    expect(body.forwardAuthUserHeader).toBe("X-Forwarded-User");
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
    expect((await prisma.appSettings.findFirstOrThrow()).ssoEnabled).toBe(true);
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
    expect((await prisma.appSettings.findFirstOrThrow()).ssoEnabled).toBe(false);
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
      // The secret set, so forward-auth itself is usable: the link is what refuses.
      vi.stubEnv("FORWARD_AUTH_SECRET", "proxy-secret");
      try {
        await seedEnabled();
        const body = await expectJson<{ error: string }>(
          await callRoute(PUT, { method: "PUT", body: { ssoMode: "FORWARD_AUTH" } }),
          400,
        );
        expect(body.error).toMatch(/linked under a different issuer or mode/);
        expect((await prisma.appSettings.findFirstOrThrow()).ssoMode).toBe("OIDC");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("refuses turning SSO on when the link is under another issuer", async () => {
      const user = await seedEnabled("https://old.example.com");
      await prisma.appSettings.update({ where: { userId: user.id }, data: { ssoEnabled: false } });
      const body = await expectJson<{ error: string }>(
        await callRoute(PUT, { method: "PUT", body: { ssoEnabled: true } }),
        400,
      );
      expect(body.error).toMatch(/linked under a different issuer or mode/);
      expect((await prisma.appSettings.findFirstOrThrow()).ssoEnabled).toBe(false);
    });

    it("accepts the same issuer written with a trailing slash, and a link from before issuers were stored", async () => {
      await seedEnabled();
      await expectJson(await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "https://idp.example.com/" } }), 200);

      await cleanDatabase();
      await seedEnabled(null);
      await expectJson(await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "https://other.example.com" } }), 200);
      expect((await prisma.appSettings.findFirstOrThrow()).oidcIssuer).toBe("https://other.example.com");
    });

    // Whitespace saves as null, so a blank client ID would store SSO as on
    // but unusable.
    it("refuses a blank client ID", async () => {
      await seedEnabled();
      const body = await expectJson<{ error: string }>(
        await callRoute(PUT, { method: "PUT", body: { oidcClientId: "   " } }),
        400,
      );
      expect(body.error).toBe("OIDC issuer and client ID are required to enable SSO");
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
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/Cannot disable SSO/);
    expect((await prisma.appSettings.findFirstOrThrow()).ssoEnabled).toBe(true);
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

    await expectJson(await callRoute(PUT, {
      method: "PUT",
      body: { oidcIssuer: "https://new.example.com", oidcClientId: "new-client" },
    }));

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
    const body = await expectJson<{ hasPreviousConfig: boolean }>(await callRoute(PUT, {
      method: "PUT",
      body: {
        oidcIssuer: "https://current.example.com",
        oidcClientId: "current-client",
      },
    }));
    expect(body.hasPreviousConfig).toBe(true);

    const row = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    const snap = row?.previousSsoConfig as Record<string, unknown> | null;
    expect(snap?.oidcIssuer).toBe("https://genuine-old.example.com");
  });
});

describe("PUT /api/settings/sso — what cannot be turned on", () => {
  const originalSecret = process.env.FORWARD_AUTH_SECRET;
  const originalAllow = process.env.OIDC_ALLOW_INSECURE_HTTP;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    delete process.env.FORWARD_AUTH_SECRET;
    delete process.env.OIDC_ALLOW_INSECURE_HTTP;
  });

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.FORWARD_AUTH_SECRET;
    else process.env.FORWARD_AUTH_SECRET = originalSecret;
    if (originalAllow === undefined) delete process.env.OIDC_ALLOW_INSECURE_HTTP;
    else process.env.OIDC_ALLOW_INSECURE_HTTP = originalAllow;
    await disconnectTestDb();
  });

  async function linkedForwardAdmin() {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoEnabled: true, ssoSubject: "alice", ssoIssuer: "forward-auth" },
    });
    await prisma.appSettings.create({
      data: { userId: user.id, ssoMode: "FORWARD_AUTH", forwardAuthUserHeader: "Remote-User", plexLoginEnabled: true },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });
    return user;
  }

  // Without the secret a request cannot prove it came through the proxy, so
  // the identity header proves nothing (forward-secret.ts).
  it("refuses to turn forward-auth on while FORWARD_AUTH_SECRET is unset, and tells the UI", async () => {
    const user = await linkedForwardAdmin();
    const before = await expectJson<{ forwardAuthSecretConfigured: boolean }>(await callRoute(GET, { method: "GET" }));
    expect(before.forwardAuthSecretConfigured).toBe(false);

    const refused = await expectJson<{ error: string }>(
      await callRoute(PUT, { method: "PUT", body: { ssoEnabled: true } }),
      400,
    );
    expect(refused.error).toMatch(/FORWARD_AUTH_SECRET/);
    const row = await prisma.appSettings.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.ssoEnabled).toBe(false);

    process.env.FORWARD_AUTH_SECRET = "proxy-secret";
    const after = await expectJson<{ forwardAuthSecretConfigured: boolean }>(await callRoute(GET, { method: "GET" }));
    expect(after.forwardAuthSecretConfigured).toBe(true);
    const ok = await expectJson<{ ssoEnabled: boolean }>(await callRoute(PUT, { method: "PUT", body: { ssoEnabled: true } }));
    expect(ok.ssoEnabled).toBe(true);
  });

  // An install where forward-auth was on before the secret was required:
  // header names must stay saveable (the body carries no ssoEnabled), while
  // turning SSO on explicitly is refused.
  it("lets an already-on forward-auth config be saved without the secret, but not turned on", async () => {
    const user = await linkedForwardAdmin();
    await prisma.appSettings.update({ where: { userId: user.id }, data: { ssoEnabled: true } });

    const saved = await expectJson<{ forwardAuthEmailHeader: string; ssoEnabled: boolean }>(
      await callRoute(PUT, { method: "PUT", body: { ssoMode: "FORWARD_AUTH", forwardAuthEmailHeader: "X-Email" } }),
    );
    expect(saved.forwardAuthEmailHeader).toBe("X-Email");
    expect(saved.ssoEnabled).toBe(true);

    const refused = await expectJson<{ error: string }>(
      await callRoute(PUT, { method: "PUT", body: { ssoEnabled: true } }),
      400,
    );
    expect(refused.error).toMatch(/FORWARD_AUTH_SECRET/);
  });

  async function linkedOidcAdmin(issuer: string) {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoEnabled: true, ssoSubject: "sub-1", ssoIssuer: issuer },
    });
    await prisma.appSettings.create({
      data: { userId: user.id, ssoMode: "OIDC", oidcIssuer: issuer, oidcClientId: "client", plexLoginEnabled: true },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });
    return user;
  }

  // The OIDC client relies on TLS to authenticate the issuer (issuer-url.ts).
  it("refuses an http:// issuer off loopback, saved or merely turned on", async () => {
    const user = await linkedOidcAdmin("https://idp.example.com");
    const saved = await expectJson<{ error: string; details: string[] }>(
      await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "http://idp.lan" } }),
      400,
    );
    expect(saved.details).toEqual([`oidcIssuer: ${oidcIssuerProblem("http://idp.lan")}`]);
    expect((await prisma.appSettings.findUniqueOrThrow({ where: { userId: user.id } })).oidcIssuer).toBe(
      "https://idp.example.com",
    );

    // An http:// issuer stored under the older rule: turning SSO on against
    // it would put a button on the login page that cannot be honoured.
    await prisma.appSettings.update({ where: { userId: user.id }, data: { oidcIssuer: "http://idp.lan" } });
    await prisma.user.update({ where: { id: user.id }, data: { ssoIssuer: "http://idp.lan" } });
    const turnedOn = await expectJson<{ error: string }>(
      await callRoute(PUT, { method: "PUT", body: { ssoEnabled: true } }),
      400,
    );
    expect(turnedOn.error).toMatch(/^SSO cannot be turned on: the OIDC issuer URL is not accepted: Issuer must use https:\/\//);
    expect((await prisma.appSettings.findUniqueOrThrow({ where: { userId: user.id } })).ssoEnabled).toBe(false);
  });

  it("accepts http:// on loopback, and anywhere under OIDC_ALLOW_INSECURE_HTTP", async () => {
    await linkedOidcAdmin("http://localhost:9000");
    const loop = await expectJson<{ oidcIssuer: string; ssoEnabled: boolean }>(
      await callRoute(PUT, { method: "PUT", body: { oidcIssuer: "http://localhost:9000", ssoEnabled: true } }),
    );
    expect(loop.ssoEnabled).toBe(true);
    expect(loop.oidcIssuer).toBe("http://localhost:9000");

    process.env.OIDC_ALLOW_INSECURE_HTTP = "true";
    await cleanDatabase();
    await linkedOidcAdmin("http://idp.lan");
    const lan = await expectJson<{ ssoEnabled: boolean }>(
      await callRoute(PUT, { method: "PUT", body: { ssoEnabled: true } }),
    );
    expect(lan.ssoEnabled).toBe(true);
  });
});
