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

const mockInvalidateCache = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sso/oidc-client", () => ({
  invalidateOidcDiscoveryCache: mockInvalidateCache,
}));

import { POST } from "@/app/api/settings/sso/revert/route";

const prisma = getTestPrisma();

describe("POST /api/settings/sso/revert", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockInvalidateCache.mockClear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(POST, { method: "POST" });
    await expectJson(res, 401);
  });

  it("returns 404 when there's no previous snapshot", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, ssoMode: "OIDC" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(POST, { method: "POST" });
    const body = await expectJson<{ error: string }>(res, 404);
    expect(body.error).toMatch(/No previous SSO configuration/);
  });

  it("restores snapshot fields and clears the snapshot", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: "https://broken.example.com",
        oidcClientId: "broken-client",
        oidcClientSecret: "broken-secret",
        previousSsoConfig: {
          ssoMode: "OIDC",
          oidcIssuer: "https://working.example.com",
          oidcClientId: "working-client",
          oidcClientSecret: "working-secret",
          oidcScopes: "openid profile email",
          oidcUsernameClaim: "preferred_username",
          forwardAuthUserHeader: "Remote-User",
          forwardAuthEmailHeader: "Remote-Email",
          forwardAuthNameHeader: "Remote-Name",
        },
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await callRoute(POST, { method: "POST" });

    const row = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(row?.oidcIssuer).toBe("https://working.example.com");
    expect(row?.oidcClientId).toBe("working-client");
    expect(row?.oidcClientSecret).toBe("working-secret");
    // Revert never auto-re-enables — admin opts in via wizard step 3.
    expect(row?.ssoEnabled).toBe(false);
    // Snapshot is single-step undo, no history.
    expect(row?.previousSsoConfig).toBeNull();
  });

  it("clears the admin's user-level SSO link so the admin must re-link", async () => {
    // If we restored an SSO config with a different issuer but left the
    // user's ssoSubject/Issuer pinned to the abandoned config, login would
    // silently reject with "not_linked". Clear the link to force re-link.
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "broken-sub",
        ssoIssuer: "https://broken.example.com",
        ssoProvider: "broken-provider",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        oidcIssuer: "https://broken.example.com",
        previousSsoConfig: {
          ssoMode: "OIDC",
          oidcIssuer: "https://working.example.com",
        },
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await callRoute(POST, { method: "POST" });

    const refreshedUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshedUser?.ssoSubject).toBeNull();
    expect(refreshedUser?.ssoIssuer).toBeNull();
    expect(refreshedUser?.ssoProvider).toBeNull();
    expect(refreshedUser?.ssoEnabled).toBe(false);
    expect(refreshedUser?.sessionVersion).toBe(user.sessionVersion + 1);
  });

  it("defaults to OIDC when snapshot's ssoMode is hand-edited to garbage", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        previousSsoConfig: {
          ssoMode: "TOTAL_GARBAGE",
          oidcIssuer: "https://idp.example.com",
        },
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await callRoute(POST, { method: "POST" });

    const row = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(row?.ssoMode).toBe("OIDC");
  });

  it("preserves FORWARD_AUTH mode in the snapshot", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        previousSsoConfig: {
          ssoMode: "FORWARD_AUTH",
          forwardAuthUserHeader: "X-Forwarded-User",
          forwardAuthEmailHeader: "X-Forwarded-Email",
          forwardAuthNameHeader: "X-Forwarded-Name",
        },
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await callRoute(POST, { method: "POST" });

    const row = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(row?.ssoMode).toBe("FORWARD_AUTH");
    expect(row?.forwardAuthUserHeader).toBe("X-Forwarded-User");
  });

  it("invalidates the discovery cache after revert", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        previousSsoConfig: { ssoMode: "OIDC", oidcIssuer: "https://idp.example.com" },
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await callRoute(POST, { method: "POST" });
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
  });
});
