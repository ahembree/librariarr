import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// file deepcode ignore HardcodedNonCryptoSecret/test: Test file with hardcoded values to run validation tests

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

// Mock Plex auth functions
const mockGetPlexUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/plex/auth", () => ({
  getPlexUser: mockGetPlexUser,
}));

// Mock rate limiter
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  checkAuthRateLimit: () => null,
  authRateLimiter: { check: () => ({ limited: false }) },
  getClientIp: () => "127.0.0.1",
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/auth/plex/token/route";

describe("POST /api/auth/plex/token", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockGetPlexUser.mockReset();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("should create a new user when no users exist (first user setup)", async () => {
    mockGetPlexUser.mockResolvedValue({
      id: 99001,
      uuid: "user-uuid-123",
      email: "newuser@example.com",
      username: "newplexuser",
      authToken: "plex-auth-token",
      thumb: "https://plex.tv/users/thumb.png",
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/token",
      method: "POST",
      body: { authToken: "plex-auth-token" },
    });

    const body = await expectJson<{
      authenticated: boolean;
      user: { id: string; username: string };
    }>(response, 200);

    expect(body.authenticated).toBe(true);
    expect(body.user.username).toBe("newplexuser");

    // Verify user was created in the database
    const prisma = getTestPrisma();
    const dbUser = await prisma.user.findUnique({
      where: { plexId: "99001" },
    });
    expect(dbUser).not.toBeNull();
    expect(dbUser!.username).toBe("newplexuser");
    expect(dbUser!.email).toBe("newuser@example.com");
    expect(dbUser!.plexToken).toBe("plex-auth-token");
  });

  it("should update an existing user on re-authentication", async () => {
    const existingUser = await createTestUser({
      plexId: "88001",
      plexToken: "old-token",
      username: "oldname",
      email: "old@example.com",
    });

    mockGetPlexUser.mockResolvedValue({
      id: 88001,
      uuid: "user-uuid-existing",
      email: "updated@example.com",
      username: "updatedname",
      authToken: "new-plex-token",
      thumb: "https://plex.tv/users/updated.png",
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/token",
      method: "POST",
      body: { authToken: "new-plex-token" },
    });

    const body = await expectJson<{
      authenticated: boolean;
      user: { id: string; username: string };
    }>(response, 200);

    expect(body.authenticated).toBe(true);
    expect(body.user.username).toBe("updatedname");
    expect(body.user.id).toBe(existingUser.id);

    // Verify user was updated
    const prisma = getTestPrisma();
    const dbUser = await prisma.user.findUnique({
      where: { plexId: "88001" },
    });
    expect(dbUser!.username).toBe("updatedname");
    expect(dbUser!.email).toBe("updated@example.com");
    expect(dbUser!.plexToken).toBe("new-plex-token");

    // No duplicate users
    const userCount = await prisma.user.count();
    expect(userCount).toBe(1);
  });

  it("should return 403 when Plex account is not linked to admin", async () => {
    // Create an existing user with a different Plex ID
    await createTestUser({ plexId: "11111" });

    mockGetPlexUser.mockResolvedValue({
      id: 99999,
      uuid: "unknown-uuid",
      email: "unknown@example.com",
      username: "unknownuser",
      authToken: "unknown-token",
      thumb: "https://plex.tv/thumb.png",
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/token",
      method: "POST",
      body: { authToken: "unknown-token" },
    });

    const body = await expectJson<{ error: string }>(response, 403);
    expect(body.error).toContain("not linked to the admin user");
  });

  it("should return 500 when getPlexUser throws", async () => {
    mockGetPlexUser.mockRejectedValue(new Error("Plex API error"));

    const response = await callRoute(POST, {
      url: "/api/auth/plex/token",
      method: "POST",
      body: { authToken: "valid-token" },
    });

    const body = await expectJson<{ error: string }>(response, 500);
    expect(body.error).toBe("Authentication failed");
  });

  it("should return 400 when authToken is missing", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/plex/token",
      method: "POST",
      body: {},
    });

    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("should call getPlexUser with the provided auth token", async () => {
    mockGetPlexUser.mockResolvedValue({
      id: 10001,
      uuid: "uuid-10001",
      email: "test@example.com",
      username: "testuser",
      authToken: "specific-token-xyz",
      thumb: "https://plex.tv/thumb.png",
    });

    await callRoute(POST, {
      url: "/api/auth/plex/token",
      method: "POST",
      body: { authToken: "specific-token-xyz" },
    });

    expect(mockGetPlexUser).toHaveBeenCalledWith("specific-token-xyz");
  });
});
