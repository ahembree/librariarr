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

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockBcrypt.hash.mockClear();
    mockBcrypt.compare.mockClear();
    mockBcrypt.hash.mockImplementation(async (pw: string) => `hashed_${pw}`);
    mockBcrypt.compare.mockImplementation(
      async (pw: string, hash: string) => hash === `hashed_${pw}`
    );
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
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "short" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 for username shorter than 3 characters", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newUsername: "ab" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("changes password successfully when user has existing password", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_oldpassword" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
  });

  it("returns 401 when currentPassword is wrong", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_correctpassword" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { currentPassword: "wrongpassword", newPassword: "newpassword123" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Current password is incorrect");
  });

  it("requires currentPassword when user already has a password", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_existing" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Current password is required");
  });

  it("allows setting password without currentPassword when no existing password", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

  it("changes username successfully", async () => {
    const user = await createTestUser({ username: "OldName" });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

  it("returns 409 when new username is already taken by another user", async () => {
    const user1 = await createTestUser({ plexId: "u1", username: "User1" });
    const user2 = await createTestUser({ plexId: "u2", username: "User2" });
    await prisma.user.update({
      where: { id: user2.id },
      data: { localUsername: "takenname" },
    });

    setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newUsername: "TakenName" },
    });
    const body = await expectJson<{ error: string }>(response, 409);
    expect(body.error).toBe("Username is already taken");
  });

  it("changes both password and username at once", async () => {
    const user = await createTestUser({ username: "OldUser" });
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_oldpw" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.sessionVersion).toBe(initialVersion + 1);
  });

  it("derives localUsername from display name when setting password without existing localUsername", async () => {
    const user = await createTestUser({ username: "Display Name" });
    // Ensure no localUsername is set
    expect(user.localUsername).toBeNull();

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newUsername: "MyName" },
    });
    const body = await expectJson<{ success: boolean; localUsername: string }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.localUsername).toBe("myname");
  });

  it("returns 401 when user no longer exists in DB", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
