import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// Mock bcrypt
const mockCompare = vi.hoisted(() => vi.fn());

vi.mock("bcryptjs", () => ({
  default: { compare: mockCompare },
  compare: mockCompare,
}));

// Mock rate limiter
const mockCheckAuthRateLimit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  checkAuthRateLimit: mockCheckAuthRateLimit,
  authRateLimiter: { check: vi.fn().mockReturnValue({ limited: false }) },
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/auth/local/login/route";

describe("POST /api/auth/local/login", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // Default: not rate limited
    mockCheckAuthRateLimit.mockReturnValue(null);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 400 on invalid body (missing fields)", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 on empty username", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      body: { username: "", password: "somepassword" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 401 when user is not found", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      body: { username: "nonexistent", password: "password123" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Invalid username or password");
  });

  it("returns 401 when user has no password hash", async () => {
    // Create a user without a passwordHash (Plex-only user)
    await createTestUser({ username: "plexuser" });

    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      body: { username: "plexuser", password: "password123" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Invalid username or password");
  });

  it("returns 401 when password does not match", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser({ username: "localuser" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        localUsername: "localuser",
        passwordHash: "hashed_correctpassword",
      },
    });
    // The route now gates on AppSettings.localAuthEnabled before doing the
    // bcrypt check (an auth-bypass-prevention measure for the case where
    // the admin disabled local login but a direct POST would otherwise
    // still authenticate). Tests that exercise the credential-check path
    // must opt into local auth.
    await prisma.appSettings.create({
      data: { userId: user.id, localAuthEnabled: true },
    });

    mockCompare.mockResolvedValue(false);

    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      // file deepcode ignore NoHardcodedPasswords/test: test file
      body: { username: "localuser", password: "wrongpassword" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Invalid username or password");
    expect(mockCompare).toHaveBeenCalledWith("wrongpassword", "hashed_correctpassword");
  });

  it("returns 200 on valid credentials", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser({ username: "localuser" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        localUsername: "localuser",
        passwordHash: "hashed_password",
      },
    });
    await prisma.appSettings.create({
      data: { userId: user.id, localAuthEnabled: true },
    });

    mockCompare.mockResolvedValue(true);

    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      body: { username: "localuser", password: "correctpassword" },
    });
    const body = await expectJson<{ authenticated: boolean; user: { id: string; username: string } }>(response, 200);
    expect(body.authenticated).toBe(true);
    expect(body.user.id).toBe(user.id);
    expect(body.user.username).toBe("localuser");
    expect(mockCompare).toHaveBeenCalledWith("correctpassword", "hashed_password");
  });

  it("handles case-insensitive username lookup", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser({ username: "LocalUser" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        localUsername: "localuser",
        passwordHash: "hashed_password",
      },
    });
    await prisma.appSettings.create({
      data: { userId: user.id, localAuthEnabled: true },
    });

    mockCompare.mockResolvedValue(true);

    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      body: { username: "LocalUser", password: "correctpassword" },
    });
    const body = await expectJson<{ authenticated: boolean }>(response, 200);
    expect(body.authenticated).toBe(true);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckAuthRateLimit.mockReturnValue(
      Response.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { "Retry-After": "60" } }
      )
    );

    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      body: { username: "anyuser", password: "anypassword" },
    });
    const body = await expectJson<{ error: string }>(response, 429);
    expect(body.error).toBe("Too many attempts. Try again later.");
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  // ── Auth-bypass-prevention gate ─────────────────────────────────────
  //
  // The login page hides the local form when the admin disables local auth
  // OR when SSO is active. Without these server-side checks, a direct POST
  // would still authenticate anyone with valid credentials — an auth-bypass
  // for the toggles the admin thought they had control over.

  it("returns 401 with generic error when localAuthEnabled is false (form hidden)", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser({ username: "localuser" });
    await prisma.user.update({
      where: { id: user.id },
      data: { localUsername: "localuser", passwordHash: "hashed_correct" },
    });
    await prisma.appSettings.create({
      data: { userId: user.id, localAuthEnabled: false },
    });
    mockCompare.mockResolvedValue(true);

    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      body: { username: "localuser", password: "correct" },
    });

    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Invalid username or password");
    // Bcrypt must NOT be reached — the gate rejects before credential check.
    expect(mockCompare).not.toHaveBeenCalled();
  });

  it("returns 401 with generic error when SSO is usable (SSO replaces local)", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser({ username: "localuser" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        localUsername: "localuser",
        passwordHash: "hashed_correct",
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
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client-1",
      },
    });
    mockCompare.mockResolvedValue(true);

    const response = await callRoute(POST, {
      url: "/api/auth/local/login",
      method: "POST",
      body: { username: "localuser", password: "correct" },
    });

    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Invalid username or password");
    expect(mockCompare).not.toHaveBeenCalled();
  });

  it("bypasses the localAuthEnabled gate when SSO_DISABLE_OVERRIDE is active", async () => {
    const originalOverride = process.env.SSO_DISABLE_OVERRIDE;
    process.env.SSO_DISABLE_OVERRIDE = "true";
    try {
      const prisma = getTestPrisma();
      const user = await createTestUser({ username: "localuser" });
      await prisma.user.update({
        where: { id: user.id },
        data: { localUsername: "localuser", passwordHash: "hashed_correct" },
      });
      // Toggle off in DB — but override should bypass.
      await prisma.appSettings.create({
        data: { userId: user.id, localAuthEnabled: false },
      });
      mockCompare.mockResolvedValue(true);

      const response = await callRoute(POST, {
        url: "/api/auth/local/login",
        method: "POST",
        body: { username: "localuser", password: "correct" },
      });

      const body = await expectJson<{ authenticated: boolean }>(response, 200);
      expect(body.authenticated).toBe(true);
      expect(mockCompare).toHaveBeenCalled();
    } finally {
      if (originalOverride === undefined) {
        delete process.env.SSO_DISABLE_OVERRIDE;
      } else {
        process.env.SSO_DISABLE_OVERRIDE = originalOverride;
      }
    }
  });
});
