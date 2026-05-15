import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

const mockDiscover = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sso/oidc-client", () => ({
  discoverOidc: mockDiscover,
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

import { POST } from "@/app/api/settings/sso/test/route";

describe("POST /api/settings/sso/test", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockDiscover.mockClear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(POST, {
      method: "POST",
      body: { oidcIssuer: "https://idp.example.com" },
    });
    await expectJson(res, 401);
  });

  it("returns 400 for an issuer URL that doesn't start with http(s)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(POST, {
      method: "POST",
      body: { oidcIssuer: "ftp://wrong.example.com" },
    });
    await expectJson(res, 400);
  });

  it("returns ok=true with discovery details on success", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    mockDiscover.mockResolvedValue({
      issuer: "https://idp.example.com",
      authorization_endpoint: "https://idp.example.com/auth",
      token_endpoint: "https://idp.example.com/token",
      userinfo_endpoint: "https://idp.example.com/userinfo",
      scopes_supported: ["openid", "profile", "email"],
    });

    const res = await callRoute(POST, {
      method: "POST",
      body: { oidcIssuer: "https://idp.example.com" },
    });
    const body = await expectJson<{
      ok: boolean;
      issuer: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      userinfoEndpoint: string | null;
      scopesSupported: string[] | null;
    }>(res);

    expect(body.ok).toBe(true);
    expect(body.issuer).toBe("https://idp.example.com");
    expect(body.authorizationEndpoint).toBe("https://idp.example.com/auth");
    expect(body.userinfoEndpoint).toBe("https://idp.example.com/userinfo");
    expect(body.scopesSupported).toEqual(["openid", "profile", "email"]);
  });

  it("forces skipCache so admins see live results, not stale caches", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    mockDiscover.mockResolvedValue({
      issuer: "https://idp.example.com",
      authorization_endpoint: "https://idp.example.com/auth",
      token_endpoint: "https://idp.example.com/token",
    });

    await callRoute(POST, {
      method: "POST",
      body: { oidcIssuer: "https://idp.example.com" },
    });

    expect(mockDiscover).toHaveBeenCalledWith(
      "https://idp.example.com",
      expect.objectContaining({ skipCache: true })
    );
  });

  it("returns ok=false (200) with sanitized error when discovery fails", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    mockDiscover.mockRejectedValue(new Error("ENOTFOUND idp.example.com"));

    const res = await callRoute(POST, {
      method: "POST",
      body: { oidcIssuer: "https://idp.example.com" },
    });
    const body = await expectJson<{ ok: boolean; error: string }>(res, 200);
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });
});
