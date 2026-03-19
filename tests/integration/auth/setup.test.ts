import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// Mock bcrypt
const mockHash = vi.hoisted(() => vi.fn());

vi.mock("bcryptjs", () => ({
  default: { hash: mockHash, compare: vi.fn() },
  hash: mockHash,
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
import { POST } from "@/app/api/auth/setup/route";

describe("POST /api/auth/setup", () => {
  beforeEach(async () => {
    const prisma = getTestPrisma();
    await cleanDatabase();
    // SystemConfig is not cleaned by cleanDatabase, clean it manually
    await prisma.systemConfig.deleteMany();
    clearMockSession();
    vi.clearAllMocks();
    mockHash.mockResolvedValue("hashed_password_value");
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 403 when a user already exists", async () => {
    await createTestUser();

    const response = await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      body: { username: "newuser", password: "password123" },
    });
    const body = await expectJson<{ error: string }>(response, 403);
    expect(body.error).toBe("Setup has already been completed");
  });

  it("returns 400 when body is missing", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid JSON in request body");
  });

  it("returns 400 when username is too short", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      body: { username: "ab", password: "password123" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 when password is too short", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      body: { username: "testuser", password: "short" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("creates user and returns success on valid input", async () => {
    const prisma = getTestPrisma();

    const response = await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      body: { username: "TestAdmin", password: "securepassword123" },
    });
    const body = await expectJson<{ success: boolean; user: { id: string; username: string } }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.user.username).toBe("TestAdmin");
    expect(body.user.id).toBeDefined();

    // Verify bcrypt.hash was called with correct params
    expect(mockHash).toHaveBeenCalledWith("securepassword123", 12);

    // Verify user was created in the database
    const user = await prisma.user.findFirst();
    expect(user).not.toBeNull();
    expect(user!.localUsername).toBe("testadmin");
    expect(user!.username).toBe("TestAdmin");
    expect(user!.passwordHash).toBe("hashed_password_value");
  });

  it("creates AppSettings with localAuthEnabled on setup", async () => {
    const prisma = getTestPrisma();

    await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      body: { username: "TestAdmin", password: "securepassword123" },
    });

    const settings = await prisma.appSettings.findFirst();
    expect(settings).not.toBeNull();
    expect(settings!.localAuthEnabled).toBe(true);
  });

  it("creates SystemConfig with setupCompleted on setup", async () => {
    const prisma = getTestPrisma();

    await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      body: { username: "TestAdmin", password: "securepassword123" },
    });

    const config = await prisma.systemConfig.findUnique({
      where: { id: "singleton" },
    });
    expect(config).not.toBeNull();
    expect(config!.setupCompleted).toBe(true);
    expect(config!.plexClientId).toBeDefined();
  });
});
