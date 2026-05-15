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

import { POST, DELETE } from "@/app/api/settings/sso/link/route";

const prisma = getTestPrisma();

describe("POST /api/settings/sso/link — manual subject link", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(POST, {
      method: "POST",
      body: { ssoSubject: "abc" },
    });
    await expectJson(res, 401);
  });

  it("returns 400 when no settings exist (issuer unknown)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(POST, {
      method: "POST",
      body: { ssoSubject: "abc" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/Configure SSO mode and issuer/);
  });

  it("links the subject and captures the current OIDC issuer", async () => {
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

    const res = await callRoute(POST, {
      method: "POST",
      body: { ssoSubject: "abc-sub" },
    });
    const body = await expectJson<{ ssoSubject: string; ssoEnabled: boolean }>(res);
    expect(body.ssoSubject).toBe("abc-sub");
    expect(body.ssoEnabled).toBe(true);

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.ssoSubject).toBe("abc-sub");
    expect(refreshed?.ssoIssuer).toBe("https://idp.example.com");
    expect(refreshed?.ssoEnabled).toBe(true);
  });

  it("normalizes the issuer (strips trailing slashes) at link time", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com/",
        oidcClientId: "client",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await callRoute(POST, {
      method: "POST",
      body: { ssoSubject: "abc-sub" },
    });
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.ssoIssuer).toBe("https://idp.example.com");
  });

  it("uses 'forward-auth' as the issuer sentinel in forward-auth mode", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "FORWARD_AUTH",
        forwardAuthUserHeader: "Remote-User",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await callRoute(POST, {
      method: "POST",
      body: { ssoSubject: "alice" },
    });
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.ssoIssuer).toBe("forward-auth");
  });

  it("trims the submitted subject", async () => {
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

    await callRoute(POST, {
      method: "POST",
      body: { ssoSubject: "  abc  " },
    });
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.ssoSubject).toBe("abc");
  });

  it("returns 400 when the trimmed subject is empty", async () => {
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

    const res = await callRoute(POST, {
      method: "POST",
      body: { ssoSubject: "   " },
    });
    // Zod's .min(1) catches this — validation rejects before our trim check
    await expectJson(res, 400);
  });

  it("bumps sessionVersion to invalidate other sessions", async () => {
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

    const initial = user.sessionVersion;
    await callRoute(POST, {
      method: "POST",
      body: { ssoSubject: "abc" },
    });
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.sessionVersion).toBe(initial + 1);
  });
});

describe("DELETE /api/settings/sso/link — unlink + lockout guard", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(DELETE, { method: "DELETE" });
    await expectJson(res, 401);
  });

  it("rejects unlink when there's no usable Plex AND no usable local", async () => {
    // SSO-only setup: linked but no fallback method exists. Unlinking would
    // leave the admin with nothing.
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
        localAuthEnabled: false,
        ssoEnabled: true,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(DELETE, { method: "DELETE" });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/Cannot unlink SSO without another working login method/);

    // Verify nothing was actually changed
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.ssoSubject).toBe("abc");
    expect(refreshed?.ssoEnabled).toBe(true);
  });

  it("rejects unlink when Plex is linked but plexLoginEnabled is false (button hidden)", async () => {
    // Plex linked but the toggle hides it → it's not actually a usable
    // fallback. The lockout guard must honor plexLoginEnabled, not just
    // plexId existence.
    const user = await createTestUser({ plexId: "p1" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        plexLoginEnabled: false,
        localAuthEnabled: false,
        ssoEnabled: true,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(DELETE, { method: "DELETE" });
    await expectJson(res, 400);
  });

  it("allows unlink and auto-disables global SSO when Plex is the fallback", async () => {
    const user = await createTestUser({ plexId: "p1" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        plexLoginEnabled: true,
        ssoEnabled: true,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(DELETE, { method: "DELETE" });
    const body = await expectJson<{
      ssoSubject: string | null;
      ssoEnabled: boolean;
      globalSsoDisabled: boolean;
    }>(res);

    expect(body.ssoSubject).toBeNull();
    expect(body.ssoEnabled).toBe(false);
    expect(body.globalSsoDisabled).toBe(true);

    // Both the user link AND global SSO should be off after unlink — they
    // happen in a single transaction so neither half can be stale.
    const refreshedUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshedUser?.ssoSubject).toBeNull();
    expect(refreshedUser?.ssoIssuer).toBeNull();
    expect(refreshedUser?.ssoEnabled).toBe(false);

    const refreshedSettings = await prisma.appSettings.findFirst();
    expect(refreshedSettings?.ssoEnabled).toBe(false);
  });

  it("allows unlink when local credentials are the fallback", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        plexId: null,
        plexToken: null,
        localUsername: "alice",
        passwordHash: "h",
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        localAuthEnabled: true,
        ssoEnabled: true,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(DELETE, { method: "DELETE" });
    const body = await expectJson<{ globalSsoDisabled: boolean }>(res);
    expect(body.globalSsoDisabled).toBe(true);
  });

  it("rejects when local credentials exist but localAuthEnabled is false", async () => {
    // passwordHash is set but the toggle is off → not actually usable.
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        plexId: null,
        plexToken: null,
        localUsername: "alice",
        passwordHash: "h",
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        localAuthEnabled: false, // toggle off — local isn't a usable fallback
        ssoEnabled: true,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(DELETE, { method: "DELETE" });
    await expectJson(res, 400);
  });

  it("does NOT auto-disable global SSO when it was already off", async () => {
    // Edge case: unlink while ssoEnabled is already false. The transaction
    // shouldn't include the second update — globalSsoDisabled should reflect
    // "no, we didn't have to flip it."
    const user = await createTestUser({ plexId: "p1" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        plexLoginEnabled: true,
        ssoEnabled: false, // already off
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(DELETE, { method: "DELETE" });
    const body = await expectJson<{ globalSsoDisabled: boolean }>(res);
    expect(body.globalSsoDisabled).toBe(false);
  });

  it("bumps user.sessionVersion on unlink", async () => {
    const user = await createTestUser({ plexId: "p1" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        plexLoginEnabled: true,
        ssoEnabled: true,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const initial = user.sessionVersion;
    await callRoute(DELETE, { method: "DELETE" });
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.sessionVersion).toBe(initial + 1);
  });
});
