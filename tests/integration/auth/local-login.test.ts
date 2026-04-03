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
});
