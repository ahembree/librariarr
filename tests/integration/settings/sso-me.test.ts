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

import { GET } from "@/app/api/settings/sso/me/route";

const prisma = getTestPrisma();

describe("GET /api/settings/sso/me", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET, { method: "GET" });
    await expectJson(res, 401);
  });

  it("returns 401 when session references a deleted user", async () => {
    setMockSession({ isLoggedIn: true, userId: "nonexistent-id" });
    const res = await callRoute(GET, { method: "GET" });
    await expectJson(res, 401);
  });

  it("returns the user's SSO link state (unlinked default)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{
      ssoSubject: string | null;
      ssoProvider: string | null;
      ssoEnabled: boolean;
    }>(res);
    expect(body.ssoSubject).toBeNull();
    expect(body.ssoProvider).toBeNull();
    expect(body.ssoEnabled).toBe(false);
  });

  it("returns the linked subject + provider when present", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "sub-123",
        ssoIssuer: "https://idp.example.com",
        ssoProvider: "authentik",
        ssoEnabled: true,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{
      ssoSubject: string | null;
      ssoProvider: string | null;
      ssoEnabled: boolean;
    }>(res);
    expect(body.ssoSubject).toBe("sub-123");
    expect(body.ssoProvider).toBe("authentik");
    expect(body.ssoEnabled).toBe(true);
  });
});
