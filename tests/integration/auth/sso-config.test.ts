import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
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

import { GET } from "@/app/api/auth/sso/config/route";

const prisma = getTestPrisma();

describe("GET /api/auth/sso/config — public endpoint", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns ssoEnabled=false when no AppSettings row exists", async () => {
    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{ ssoEnabled: boolean; ssoMode: string }>(res);
    expect(body.ssoEnabled).toBe(false);
    expect(body.ssoMode).toBe("OIDC");
  });

  it("reports ssoEnabled=true only when SSO is fully usable (OIDC)", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });

    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{ ssoEnabled: boolean; ssoMode: string }>(res);
    expect(body.ssoEnabled).toBe(true);
    expect(body.ssoMode).toBe("OIDC");
  });

  it("reports ssoEnabled=false when ssoEnabled is true but config is incomplete", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: null,
        oidcClientId: "client",
      },
    });

    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{ ssoEnabled: boolean }>(res);
    expect(body.ssoEnabled).toBe(false);
  });

  it("does not leak issuer URL, client ID, or header names", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "FORWARD_AUTH",
        ssoEnabled: true,
        forwardAuthUserHeader: "Custom-User",
        forwardAuthEmailHeader: "Custom-Email",
        oidcIssuer: "https://secret-idp.example.com",
        oidcClientId: "secret-client-id",
      },
    });

    const res = await callRoute(GET, { method: "GET" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ssoEnabled", "ssoMode"].sort());
  });

  it("respects SSO_DISABLE_OVERRIDE (returns ssoEnabled=false)", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });

    const original = process.env.SSO_DISABLE_OVERRIDE;
    process.env.SSO_DISABLE_OVERRIDE = "true";
    try {
      const res = await callRoute(GET, { method: "GET" });
      const body = await expectJson<{ ssoEnabled: boolean }>(res);
      expect(body.ssoEnabled).toBe(false);
    } finally {
      if (original === undefined) delete process.env.SSO_DISABLE_OVERRIDE;
      else process.env.SSO_DISABLE_OVERRIDE = original;
    }
  });
});
