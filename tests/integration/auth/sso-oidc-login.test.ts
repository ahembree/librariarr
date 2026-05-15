import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession, getMockSession } from "../../setup/mock-session";
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

const mockCheckAuthRateLimit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  checkAuthRateLimit: mockCheckAuthRateLimit,
  authRateLimiter: { check: () => ({ limited: false }) },
  getClientIp: () => "127.0.0.1",
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

import { GET } from "@/app/api/auth/sso/oidc/login/route";

const prisma = getTestPrisma();

describe("GET /api/auth/sso/oidc/login", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockCheckAuthRateLimit.mockReturnValue(null);
    mockGeneratePkce.mockReturnValue({ verifier: "test-verifier", challenge: "test-challenge" });
    mockGenerateState.mockReturnValue("test-state");
    mockBuildAuthUrl.mockReturnValue("https://idp.example.com/auth?state=test-state");
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("rejects when SSO is not configured", async () => {
    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/not configured/);
  });

  it("rejects when mode is FORWARD_AUTH (this route is OIDC-only)", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "FORWARD_AUTH",
        ssoEnabled: true,
        forwardAuthUserHeader: "Remote-User",
      },
    });

    const res = await callRoute(GET, { method: "GET" });
    await expectJson(res, 400);
  });

  it("redirects to the IdP authorization endpoint and stashes state+verifier", async () => {
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
    mockDiscover.mockResolvedValue({
      issuer: "https://idp.example.com",
      authorization_endpoint: "https://idp.example.com/auth",
      token_endpoint: "https://idp.example.com/token",
    });

    const res = await callRoute(GET, { method: "GET" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://idp.example.com/auth?state=test-state"
    );

    // PKCE verifier + state are written to session so callback can verify.
    const session = getMockSession();
    expect(session.oidcState).toBe("test-state");
    expect(session.oidcVerifier).toBe("test-verifier");
  });

  it("returns 500 when discovery fails", async () => {
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
    mockDiscover.mockRejectedValue(new Error("ENOTFOUND"));

    const res = await callRoute(GET, { method: "GET" });
    const body = await expectJson<{ error: string }>(res, 500);
    expect(body.error).toMatch(/Failed to initiate/);
  });

  it("honors rate limiting", async () => {
    mockCheckAuthRateLimit.mockReturnValue(
      Response.json({ error: "Too many attempts" }, { status: 429 })
    );

    const res = await callRoute(GET, { method: "GET" });
    expect(res.status).toBe(429);
  });
});
