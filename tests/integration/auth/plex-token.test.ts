import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession, getMockSession } from "../../setup/mock-session";
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

// Mock rate limiter. A bare Plex token signs in, so the route is charged like
// the local login: reserved before the token is checked and given back on a
// sign-in that succeeds (login-lockout.test.ts runs the real limiter).
const { mockPeek, mockReserve, mockSucceeded } = vi.hoisted(() => {
  const mockSucceeded = vi.fn();
  return {
    mockPeek: vi.fn((): Response | null => null),
    mockReserve: vi.fn(
      (): { refused: Response } | { refused: null; succeeded: () => void } => ({ refused: null, succeeded: mockSucceeded }),
    ),
    mockSucceeded,
  };
});
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  peekAuthRateLimit: mockPeek,
  reserveAuthAttempt: mockReserve,
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/auth/plex/token/route";

describe("POST /api/auth/plex/token", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockGetPlexUser.mockReset();
    vi.clearAllMocks();
    mockPeek.mockReturnValue(null);
    mockReserve.mockReturnValue({ refused: null, succeeded: mockSucceeded });
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
    expect(mockGetPlexUser).toHaveBeenCalledWith("plex-auth-token");

    // Verify user was created in the database
    const prisma = getTestPrisma();
    const dbUser = await prisma.user.findUnique({
      where: { plexId: "99001" },
    });
    expect(dbUser).not.toBeNull();
    expect(dbUser!.id).toBe(body.user.id);
    expect(dbUser!.username).toBe("newplexuser");
    expect(dbUser!.email).toBe("newuser@example.com");
    expect(dbUser!.plexToken).toBe("plex-auth-token");
    // The settings row is created with the admin (local login off: they
    // signed up with Plex).
    const settings = await prisma.appSettings.findUnique({ where: { userId: dbUser!.id } });
    expect(settings?.localAuthEnabled).toBe(false);

    // Signed in, and the budget given back. The token stays in the User row,
    // never in the cookie.
    const session = getMockSession();
    expect(session).toMatchObject({ userId: dbUser!.id, isLoggedIn: true, sessionVersion: 0 });
    expect("plexToken" in session).toBe(false);
    expect(mockSucceeded).toHaveBeenCalledTimes(1);
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

    const session = getMockSession();
    expect(session).toMatchObject({
      userId: existingUser.id,
      isLoggedIn: true,
      sessionVersion: existingUser.sessionVersion,
    });
    expect("plexToken" in session).toBe(false);
    expect(mockSucceeded).toHaveBeenCalledTimes(1);
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
    expect(body.error).toBe(
      "This Plex account is not linked to the admin user. Use Settings > Authentication to link your Plex account.",
    );
    // Single admin: no second user, no sign-in, and the attempt stays charged.
    expect(await getTestPrisma().user.count()).toBe(1);
    expect(getMockSession().isLoggedIn).toBe(false);
    expect(mockSucceeded).not.toHaveBeenCalled();
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

    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["authToken: Invalid input: expected string, received undefined"]);
    // A malformed body is not an attempt.
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockGetPlexUser).not.toHaveBeenCalled();
  });

  it("returns the limiter's 429 without asking plex.tv who the token belongs to", async () => {
    mockPeek.mockReturnValue(
      Response.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": "60" } }),
    );

    const response = await callRoute(POST, {
      url: "/api/auth/plex/token",
      method: "POST",
      body: { authToken: "plex-auth-token" },
    });

    const body = await expectJson<{ error: string }>(response, 429);
    expect(body.error).toBe("Too many attempts. Try again later.");
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockGetPlexUser).not.toHaveBeenCalled();
  });

  it("returns 429 when the attempt cannot be reserved, without checking the token", async () => {
    await createTestUser({ plexId: "77001" });
    mockReserve.mockReturnValue({
      refused: Response.json({ error: "Too many attempts. Try again later." }, { status: 429 }),
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/token",
      method: "POST",
      body: { authToken: "plex-auth-token" },
    });

    await expectJson(response, 429);
    expect(mockGetPlexUser).not.toHaveBeenCalled();
    expect(getMockSession().isLoggedIn).toBe(false);
  });

  // ── plexLoginEnabled gate ─────────────────────────────────────────
  //
  // The /api/auth/plex/token route refuses logins when the admin has
  // disabled the Plex button (plexLoginEnabled=false). Direct POSTs to
  // this route must be rejected just like a UI submission would be.

  it("returns 403 when plexLoginEnabled=false post-setup", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser({ plexId: "55001" });
    await prisma.appSettings.create({
      data: { userId: user.id, plexLoginEnabled: false },
    });

    mockGetPlexUser.mockResolvedValue({
      id: 55001,
      uuid: "uuid-55001",
      email: "u@example.com",
      username: "u",
      authToken: "tok",
      thumb: "",
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/token",
      method: "POST",
      body: { authToken: "tok" },
    });
    const body = await expectJson<{ error: string }>(response, 403);
    expect(body.error).toBe("Plex login is disabled by the administrator.");
    // Refused before the account is touched or anyone is signed in.
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchanged.plexToken).toBe(user.plexToken);
    expect(getMockSession().isLoggedIn).toBe(false);
    expect(mockSucceeded).not.toHaveBeenCalled();
  });

  it("allows login when plexLoginEnabled=false but SSO_DISABLE_OVERRIDE is set", async () => {
    // Override is a recovery mode — the login page surfaces the Plex button
    // under it, so the server must honor the login or the UI would lie.
    const prisma = getTestPrisma();
    const user = await createTestUser({ plexId: "55002" });
    await prisma.appSettings.create({
      data: { userId: user.id, plexLoginEnabled: false },
    });

    mockGetPlexUser.mockResolvedValue({
      id: 55002,
      uuid: "uuid-55002",
      email: "u2@example.com",
      username: "u2",
      authToken: "tok2",
      thumb: "",
    });

    const original = process.env.SSO_DISABLE_OVERRIDE;
    process.env.SSO_DISABLE_OVERRIDE = "true";
    try {
      const response = await callRoute(POST, {
        url: "/api/auth/plex/token",
        method: "POST",
        body: { authToken: "tok2" },
      });
      const body = await expectJson<{ authenticated: boolean; user: { id: string } }>(response, 200);
      expect(body.user.id).toBe(user.id);
      expect(getMockSession()).toMatchObject({ userId: user.id, isLoggedIn: true });
    } finally {
      if (original === undefined) delete process.env.SSO_DISABLE_OVERRIDE;
      else process.env.SSO_DISABLE_OVERRIDE = original;
    }
  });
});
