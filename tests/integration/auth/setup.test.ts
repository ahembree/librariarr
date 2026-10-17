import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession, getMockSession } from "../../setup/mock-session";
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

// The real limiter is exercised in tests/integration/auth/setup-rate-limit.test.ts;
// here it would make the eleventh request of the file a 429.
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  SETUP_BUCKET: "setup",
  checkAuthRateLimit: () => null,
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
    // Single admin: no second user, and no bcrypt cost paid for the refusal.
    expect(await getTestPrisma().user.count()).toBe(1);
    expect(mockHash).not.toHaveBeenCalled();
    expect(getMockSession().isLoggedIn).toBe(false);
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
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["username: Username must be at least 3 characters"]);
    expect(await getTestPrisma().user.count()).toBe(0);
  });

  it("returns 400 when password is too short", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      body: { username: "testuser", password: "short" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["password: Password must be at least 8 characters"]);
    expect(mockHash).not.toHaveBeenCalled();
    expect(await getTestPrisma().user.count()).toBe(0);
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

    // Verify bcrypt.hash was called with correct params
    expect(mockHash).toHaveBeenCalledWith("securepassword123", 12);

    // Verify user was created in the database
    const user = await prisma.user.findFirst();
    expect(user).not.toBeNull();
    expect(user!.id).toBe(body.user.id);
    expect(user!.localUsername).toBe("testadmin");
    expect(user!.username).toBe("TestAdmin");
    expect(user!.passwordHash).toBe("hashed_password_value");

    // The new admin is signed in.
    expect(getMockSession()).toMatchObject({ userId: user!.id, isLoggedIn: true, sessionVersion: 0 });
  });

  it("creates AppSettings with localAuthEnabled on setup", async () => {
    const prisma = getTestPrisma();

    const response = await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      // file deepcode ignore NoHardcodedPasswords/test: test file
      body: { username: "TestAdmin", password: "securepassword123" },
    });
    await expectJson(response, 200);

    const settings = await prisma.appSettings.findFirst();
    expect(settings).not.toBeNull();
    expect(settings!.localAuthEnabled).toBe(true);
    // No Plex account is linked yet, so the Plex button starts off.
    expect(settings!.plexLoginEnabled).toBe(false);
  });

  it("creates SystemConfig with setupCompleted on setup", async () => {
    const prisma = getTestPrisma();

    const response = await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      body: { username: "TestAdmin", password: "securepassword123" },
    });
    await expectJson(response, 200);

    const config = await prisma.systemConfig.findUnique({
      where: { id: "singleton" },
    });
    expect(config).not.toBeNull();
    expect(config!.setupCompleted).toBe(true);
    expect(config!.plexClientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  // The Plex client identifier is what plex.tv knows this install by; setup
  // marks the existing row complete rather than minting a new identity.
  it("keeps an existing Plex client identifier", async () => {
    const prisma = getTestPrisma();
    await prisma.systemConfig.create({
      data: { id: "singleton", plexClientId: "existing-client-id", setupCompleted: false },
    });

    const response = await callRoute(POST, {
      url: "/api/auth/setup",
      method: "POST",
      body: { username: "TestAdmin", password: "securepassword123" },
    });
    await expectJson(response, 200);

    const config = await prisma.systemConfig.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(config.plexClientId).toBe("existing-client-id");
    expect(config.setupCompleted).toBe(true);
  });
});
