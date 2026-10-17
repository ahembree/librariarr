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
    // mockReset: one test's discovery answer must not reach the next.
    mockDiscover.mockReset();
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
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("returns 400 for an issuer URL that doesn't start with http(s)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(POST, {
      method: "POST",
      body: { oidcIssuer: "ftp://wrong.example.com" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["oidcIssuer: Issuer must be a URL starting with https://"]);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  // Over plain HTTP whoever is on the path to the IdP answers for it; the
  // test is not even attempted against such an issuer.
  it("returns 400 for an http:// issuer off loopback", async () => {
    const original = process.env.OIDC_ALLOW_INSECURE_HTTP;
    delete process.env.OIDC_ALLOW_INSECURE_HTTP;
    try {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const res = await callRoute(POST, {
        method: "POST",
        body: { oidcIssuer: "http://idp.lan" },
      });
      const body = await expectJson<{ error: string; details: string[] }>(res, 400);
      expect(body.details).toHaveLength(1);
      expect(body.details[0]).toMatch(/^oidcIssuer: Issuer must use https:\/\//);
      expect(mockDiscover).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.OIDC_ALLOW_INSECURE_HTTP;
      else process.env.OIDC_ALLOW_INSECURE_HTTP = original;
    }
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

    expect(body).toEqual({
      ok: true,
      issuer: "https://idp.example.com",
      authorizationEndpoint: "https://idp.example.com/auth",
      tokenEndpoint: "https://idp.example.com/token",
      userinfoEndpoint: "https://idp.example.com/userinfo",
      scopesSupported: ["openid", "profile", "email"],
    });
  });

  it("forces skipCache so admins see live results, not stale caches", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    mockDiscover.mockResolvedValue({
      issuer: "https://idp.example.com",
      authorization_endpoint: "https://idp.example.com/auth",
      token_endpoint: "https://idp.example.com/token",
    });

    const body = await expectJson<{ userinfoEndpoint: string | null; scopesSupported: string[] | null }>(
      await callRoute(POST, {
        method: "POST",
        body: { oidcIssuer: "https://idp.example.com" },
      }),
    );
    // Optional discovery fields the IdP left out come back as null.
    expect(body.userinfoEndpoint).toBeNull();
    expect(body.scopesSupported).toBeNull();

    expect(mockDiscover).toHaveBeenCalledWith(
      "https://idp.example.com",
      expect.objectContaining({ skipCache: true })
    );
  });

  it("returns ok=false (200) with sanitized error when discovery fails", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    // The error can name a private address; it is scrubbed before it is sent.
    mockDiscover.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:443"));

    const res = await callRoute(POST, {
      method: "POST",
      body: { oidcIssuer: "https://idp.example.com" },
    });
    const body = await expectJson<{ ok: boolean; error: string }>(res, 200);
    expect(body).toEqual({ ok: false, error: "Error: connect ECONNREFUSED [internal]:443" });
  });
});
