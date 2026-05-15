import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession, getMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

const {
  mockDiscover,
  mockBuildAuthUrl,
  mockGeneratePkce,
  mockGenerateState,
  mockResolveRedirectUri,
} = vi.hoisted(() => ({
  mockDiscover: vi.fn(),
  mockBuildAuthUrl: vi.fn(),
  mockGeneratePkce: vi.fn(),
  mockGenerateState: vi.fn(),
  mockResolveRedirectUri: vi.fn().mockReturnValue("http://localhost:3000/api/auth/sso/oidc/callback"),
}));

vi.mock("@/lib/sso/oidc-client", () => ({
  discoverOidc: mockDiscover,
  buildAuthorizationUrl: mockBuildAuthUrl,
  generatePkce: mockGeneratePkce,
  generateState: mockGenerateState,
  resolveRedirectUri: mockResolveRedirectUri,
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

import { POST } from "@/app/api/settings/sso/link/oidc/start/route";

const prisma = getTestPrisma();

describe("POST /api/settings/sso/link/oidc/start — verify-and-link init", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockGeneratePkce.mockReturnValue({ verifier: "v", challenge: "c" });
    mockGenerateState.mockReturnValue("s");
    mockBuildAuthUrl.mockReturnValue("https://idp.example.com/auth");
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(POST, { method: "POST" });
    await expectJson(res, 401);
  });

  it("returns 400 when SSO mode is not OIDC", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, ssoMode: "FORWARD_AUTH" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(POST, { method: "POST" });
    await expectJson(res, 400);
  });

  it("returns 400 when issuer or client_id is missing", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, ssoMode: "OIDC", oidcIssuer: null },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(POST, { method: "POST" });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/Save the OIDC issuer URL/);
  });

  it("returns authorizationUrl and stashes link-flow state on success", async () => {
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
    mockDiscover.mockResolvedValue({
      issuer: "https://idp.example.com",
      authorization_endpoint: "https://idp.example.com/auth",
      token_endpoint: "https://idp.example.com/token",
    });

    const res = await callRoute(POST, { method: "POST" });
    const body = await expectJson<{ authorizationUrl: string }>(res);
    expect(body.authorizationUrl).toBe("https://idp.example.com/auth");

    // The link flag is what tells the callback to take the link path instead
    // of treating this as a login.
    const session = getMockSession();
    expect(session.oidcFlow).toBe("link");
    expect(session.oidcState).toBe("s");
    expect(session.oidcVerifier).toBe("v");
  });

  it("returns 500 when discovery fails", async () => {
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
    mockDiscover.mockRejectedValue(new Error("ENOTFOUND"));

    const res = await callRoute(POST, { method: "POST" });
    await expectJson(res, 500);
  });
});
