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
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockBcrypt.hash.mockClear();
    mockBcrypt.compare.mockClear();
    // Restore default implementations
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

  it("changes password successfully", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    // Set an existing password hash so the route requires currentPassword
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_oldpassword" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: {
        currentPassword: "oldpassword",
        newPassword: "newpassword123",
      },
    });
    const body = await expectJson<{ success: boolean }>(response, 200);
    expect(body.success).toBe(true);

    // Verify bcrypt.hash was called with the new password
    expect(mockBcrypt.hash).toHaveBeenCalledWith("newpassword123", 12);

    // Verify the password was updated in the database
    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    expect(updatedUser?.passwordHash).toBe("hashed_newpassword123");
  });

  it("changes username successfully", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser({ username: "OldName" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newUsername: "NewName" },
    });
    const body = await expectJson<{ success: boolean; localUsername: string }>(
      response,
      200
    );
    expect(body.success).toBe(true);
    expect(body.localUsername).toBe("newname");

    // Verify the username was updated in the database
    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    expect(updatedUser?.localUsername).toBe("newname");
    expect(updatedUser?.username).toBe("NewName");
  });

  it("returns 401 when currentPassword is wrong", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed_correctpassword" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: {
        // file deepcode ignore NoHardcodedPasswords/test: test file
        currentPassword: "wrongpassword",
        newPassword: "newpassword123",
      },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Current password is incorrect");
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

  it("requires currentPassword when user already has a password", async () => {
    const prisma = getTestPrisma();
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

  it("allows setting password without currentPassword when user has no existing password", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    // User has no passwordHash set (null by default)

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/local/change-password",
      method: "POST",
      body: { newPassword: "newpassword123" },
    });
    const body = await expectJson<{ success: boolean }>(response, 200);
    expect(body.success).toBe(true);

    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    expect(updatedUser?.passwordHash).toBe("hashed_newpassword123");
  });

  it("returns 409 when new username is already taken by another user", async () => {
    const prisma = getTestPrisma();
    const user1 = await createTestUser({ plexId: "u1", username: "User1" });
    const user2 = await createTestUser({ plexId: "u2", username: "User2" });
    // Give user2 a localUsername
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
});
