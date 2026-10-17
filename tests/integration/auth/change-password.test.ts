import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// Mock bcrypt
const mockBcrypt = vi.hoisted(() => ({
  hash: vi.fn(async (pw: string) => `hashed_${pw}`),
  compare: vi.fn(async (pw: string, hash: string) => hash === `hashed_${pw}`),
}));

vi.mock("bcryptjs", () => ({
  default: mockBcrypt,
}));

// Mock rate limiter: a wrong current password is charged to the shared
// password-confirmation bucket (password-confirm-limit.test.ts runs the real
// one). The limiter's in-memory state would otherwise persist across tests.
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
  PASSWORD_CONFIRM_BUCKET: "password-confirm",
  peekAuthRateLimit: mockPeek,
  reserveAuthAttempt: mockReserve,
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
import { POST } from "@/app/api/auth/local/change-password/route";

describe("POST /api/auth/local/change-password", () => {
  const prisma = getTestPrisma();

  /** Password sign-in on: the only state in which the password is proof. */
  const enablePasswordSignIn = (userId: string) =>
    prisma.appSettings.create({ data: { userId, localAuthEnabled: true } });

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockBcrypt.hash.mockClear();
    mockBcrypt.compare.mockClear();
    mockBcrypt.hash.mockImplementation(async (pw: string) => `hashed_${pw}`);
    mockBcrypt.compare.mockImplementation(
      async (pw: string, hash: string) => hash === `hashed_${pw}`
    );
    // Default: not rate limited
    vi.clearAllMocks();
    mockPeek.mockReturnValue(null);
    mockReserve.mockReturnValue({ refused: null, succeeded: mockSucceeded });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when neither newPassword nor newUsername provided", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Provide a new password or username");
  });

  it("returns 400 for password shorter than 8 characters", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "short" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["newPassword: Password must be at least 8 characters"]);
  });

  it("returns 400 for username shorter than 3 characters", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newUsername: "ab" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["newUsername: Username must be at least 3 characters"]);
  });

  it("changes password successfully when user has existing password", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_oldpassword" },
    });
    await enablePasswordSignIn(user.id);

    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      // file deepcode ignore NoHardcodedPasswords/test: test file
      body: { currentPassword: "oldpassword", newPassword: "newpassword123" },
    });
    const body = await expectJson<{ success: boolean }>(response, 200);
    expect(body.success).toBe(true);
    expect(mockBcrypt.hash).toHaveBeenCalledWith("newpassword123", 12);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.passwordHash).toBe("hashed_newpassword123");
    // Reserved in the shared bucket and given back: a right password costs nothing.
    expect(mockReserve).toHaveBeenCalledWith(expect.anything(), "password-confirm");
    expect(mockSucceeded).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when currentPassword is wrong", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_correctpassword" },
    });
    await enablePasswordSignIn(user.id);

    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { currentPassword: "wrongpassword", newPassword: "newpassword123" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Current password is incorrect");
    // Charged to the bucket the other password confirmations share: one guess
    // budget across them, not one per route.
    expect(mockReserve).toHaveBeenCalledWith(expect.anything(), "password-confirm");
    expect(mockSucceeded).not.toHaveBeenCalled();
    const unchanged = await prisma.user.findUnique({ where: { id: user.id } });
    expect(unchanged?.passwordHash).toBe("hashed_correctpassword");
    expect(unchanged?.sessionVersion).toBe(user.sessionVersion);
  });

  it("stops before comparing when the attempt cannot be reserved", async () => {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: "hashed_correctpassword" } });
    await enablePasswordSignIn(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });
    mockReserve.mockReturnValue({
      refused: new Response(JSON.stringify({ error: "Too many attempts" }), { status: 429 }),
    });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { currentPassword: "correctpassword", newPassword: "newpassword123" },
    });
    expect(response.status).toBe(429);
    expect(mockBcrypt.compare).not.toHaveBeenCalled();
    const unchanged = await prisma.user.findUnique({ where: { id: user.id } });
    expect(unchanged?.passwordHash).toBe("hashed_correctpassword");
  });

  // Charged before the session check, anyone could drain the budget and keep
  // the admin from changing their credentials.
  it("never charges a request that is not signed in", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { currentPassword: "x", newPassword: "newpassword123" },
    });
    expect(response.status).toBe(401);
    expect(mockPeek).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it("requires currentPassword when user already has a password", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_existing" },
    });
    await enablePasswordSignIn(user.id);

    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Current password is required");
    expect(mockBcrypt.compare).not.toHaveBeenCalled();
    const unchanged = await prisma.user.findUnique({ where: { id: user.id } });
    expect(unchanged?.passwordHash).toBe("hashed_existing");
  });

  it("allows setting password without currentPassword when no existing password", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });
    const body = await expectJson<{ success: boolean }>(response, 200);
    expect(body.success).toBe(true);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.passwordHash).toBe("hashed_newpassword123");
  });

  // A first password is a lasting way in that the API-key step-up also
  // accepts, so a stolen cookie must not be able to set one.
  it.each([
    ["a sign-in older than 15 minutes", Date.now() - 16 * 60 * 1000],
    ["a session with no sign-in time", undefined],
  ])("refuses to set a first password on %s", async (_label, authenticatedAt) => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });
    const body = await expectJson<{ error: string; code: string }>(response, 403);
    expect(body.code).toBe("reauth_required");
    expect(body.error).toMatch(/sign-in from the last 15 minutes/);
    // The settings page offers these to confirm in place.
    expect((body as unknown as { methods: string[] }).methods).toEqual(["plex"]);

    const unchanged = await prisma.user.findUnique({ where: { id: user.id } });
    expect(unchanged?.passwordHash).toBeNull();
    expect(unchanged?.sessionVersion).toBe(user.sessionVersion);
  });

  it("still changes an existing password on an old sign-in when the current password is right", async () => {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: "hashed_oldpassword1" } });
    await enablePasswordSignIn(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() - 60 * 60 * 1000 });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { currentPassword: "oldpassword1", newPassword: "newpassword123" },
    });
    await expectJson(response, 200);
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.passwordHash).toBe("hashed_newpassword123");
  });

  // Password sign-in off (local login off, or SSO replacing it): the
  // password is accepted for nothing, so it is never compared, and a
  // credential change needs a recent sign-in by another method instead.
  describe("with password sign-in turned off", () => {
    const withPassword = async (settings: Record<string, unknown>) => {
      const user = await createTestUser();
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: "hashed_oldpassword1" } });
      await prisma.appSettings.create({ data: { userId: user.id, ...settings } });
      return user;
    };
    const ssoOn = {
      localAuthEnabled: true,
      ssoEnabled: true,
      ssoMode: "OIDC",
      oidcIssuer: "https://idp.example.com",
      oidcClientId: "librariarr",
    };

    it.each([
      ["local login off", { localAuthEnabled: false }],
      ["SSO replacing the local form", ssoOn],
    ])("%s: the right current password does not stand in for a recent sign-in", async (_label, settings) => {
      const user = await withPassword(settings);
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() - 60 * 60 * 1000 });

      const response = await callRoute(POST, {
        url: "/api/auth/local/change-password",
        method: "POST",
        body: { currentPassword: "oldpassword1", newPassword: "newpassword123", newUsername: "someone" },
      });
      const body = await expectJson<{ code: string; methods: string[] }>(response, 403);
      expect(body.code).toBe("reauth_required");
      expect(body.methods).not.toContain("password");
      expect(mockBcrypt.compare).not.toHaveBeenCalled();
      const unchanged = await prisma.user.findUnique({ where: { id: user.id } });
      expect(unchanged?.passwordHash).toBe("hashed_oldpassword1");
      expect(unchanged?.localUsername).toBeNull();
    });

    it("a recent sign-in changes the credentials without the current password", async () => {
      const user = await withPassword({ localAuthEnabled: false });
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRoute(POST, {
        url: "/api/auth/local/change-password",
        method: "POST",
        body: { currentPassword: "not-even-the-password", newPassword: "newpassword123" },
      });
      await expectJson(response, 200);
      expect(mockBcrypt.compare).not.toHaveBeenCalled();
      const updated = await prisma.user.findUnique({ where: { id: user.id } });
      expect(updated?.passwordHash).toBe("hashed_newpassword123");
    });
  });

  it("changes username successfully", async () => {
    const user = await createTestUser({ username: "OldName" });
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newUsername: "NewName" },
    });
    const body = await expectJson<{ success: boolean; localUsername: string }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.localUsername).toBe("newname");

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.localUsername).toBe("newname");
    expect(updated?.username).toBe("NewName");
  });

  // A username alone is not a way in (an account with no password cannot use
  // it to sign in), so renaming needs neither a password nor a recent sign-in.
  it("renames an account with no password on a sign-in older than 15 minutes", async () => {
    const user = await createTestUser({ username: "OldName" });
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() - 60 * 60 * 1000 });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newUsername: "NewName" },
    });
    const body = await expectJson<{ success: boolean; localUsername: string }>(response, 200);
    expect(body).toEqual({ success: true, localUsername: "newname" });

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.localUsername).toBe("newname");
    expect(updated?.passwordHash).toBeNull();
  });

  it("changes both password and username at once", async () => {
    const user = await createTestUser({ username: "OldUser" });
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_oldpw" },
    });
    await enablePasswordSignIn(user.id);

    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: {
        currentPassword: "oldpw",
        newPassword: "newpassword123",
        newUsername: "NewUser",
      },
    });
    const body = await expectJson<{ success: boolean; localUsername: string }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.localUsername).toBe("newuser");

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.passwordHash).toBe("hashed_newpassword123");
    expect(updated?.localUsername).toBe("newuser");
    expect(updated?.username).toBe("NewUser");
  });

  it("increments sessionVersion to invalidate other sessions", async () => {
    const user = await createTestUser();
    const initialVersion = user.sessionVersion;
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });
    await expectJson(response, 200);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.sessionVersion).toBe(initialVersion + 1);
  });

  it("derives localUsername from display name when setting password without existing localUsername", async () => {
    const user = await createTestUser({ username: "Display Name" });
    // Ensure no localUsername is set
    expect(user.localUsername).toBeNull();

    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });
    const body = await expectJson<{ success: boolean; localUsername: string }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.localUsername).toBe("display name");

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.localUsername).toBe("display name");
  });

  it("allows user to re-set their own username (case change)", async () => {
    const user = await createTestUser({ username: "myname" });
    await prisma.user.update({
      where: { id: user.id },
      data: { localUsername: "myname" },
    });

    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newUsername: "MyName" },
    });
    const body = await expectJson<{ success: boolean; localUsername: string }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.localUsername).toBe("myname");

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.localUsername).toBe("myname");
    expect(updated?.username).toBe("MyName");
  });

  it("returns 401 when user no longer exists in DB", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    // Delete user from DB
    await prisma.user.delete({ where: { id: user.id } });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });
});
