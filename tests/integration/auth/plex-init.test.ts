import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson } from "../../setup/test-helpers";

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
const { mockCreatePlexPin, mockGetPlexAuthUrl, mockGetPlexClientId } = vi.hoisted(() => ({
  mockCreatePlexPin: vi.fn(),
  mockGetPlexAuthUrl: vi.fn(),
  mockGetPlexClientId: vi.fn(),
}));

vi.mock("@/lib/plex/auth", () => ({
  createPlexPin: mockCreatePlexPin,
  getPlexAuthUrl: mockGetPlexAuthUrl,
  getPlexClientId: mockGetPlexClientId,
  PLEX_PRODUCT: "Librariarr",
  PLEX_VERSION: "0.1.0",
}));

// Mock rate limiter
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  checkAuthRateLimit: () => null,
  authRateLimiter: { check: () => ({ limited: false }) },
  getClientIp: () => "127.0.0.1",
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/auth/plex/init/route";

describe("POST /api/auth/plex/init", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("should return pin data, auth URL, and client credentials on success", async () => {
    const expiresAt = new Date(Date.now() + 300000).toISOString();
    mockCreatePlexPin.mockResolvedValue({
      id: 12345,
      code: "test-code-abc",
      expiresAt,
    });
    mockGetPlexClientId.mockResolvedValue("test-client-id");
    mockGetPlexAuthUrl.mockResolvedValue(
      "https://app.plex.tv/auth#?clientID=test&code=test-code-abc"
    );

    const response = await callRoute(POST, {
      url: "/api/auth/plex/init",
      method: "POST",
    });

    const body = await expectJson<{
      pinId: number;
      code: string;
      clientId: string;
      product: string;
      version: string;
      authUrl: string;
      expiresAt: string;
    }>(response, 200);

    expect(body.pinId).toBe(12345);
    expect(body.code).toBe("test-code-abc");
    expect(body.clientId).toBe("test-client-id");
    expect(body.product).toBe("Librariarr");
    expect(body.version).toBe("0.1.0");
    expect(body.authUrl).toBe(
      "https://app.plex.tv/auth#?clientID=test&code=test-code-abc"
    );
    expect(body.expiresAt).toBe(expiresAt);
    expect(mockCreatePlexPin).toHaveBeenCalledOnce();
    expect(mockGetPlexAuthUrl).toHaveBeenCalledWith("test-code-abc");
  });

  it("should return 500 when createPlexPin throws", async () => {
    mockCreatePlexPin.mockRejectedValue(new Error("Plex API unreachable"));

    const response = await callRoute(POST, {
      url: "/api/auth/plex/init",
      method: "POST",
    });

    const body = await expectJson<{ error: string }>(response, 500);

    expect(body.error).toBe("Failed to initialize Plex authentication");
  });

  it("should return 500 when getPlexAuthUrl throws", async () => {
    mockCreatePlexPin.mockResolvedValue({
      id: 99999,
      code: "some-code",
      expiresAt: new Date().toISOString(),
    });
    mockGetPlexClientId.mockResolvedValue("test-client-id");
    mockGetPlexAuthUrl.mockRejectedValue(new Error("Missing client identifier"));

    const response = await callRoute(POST, {
      url: "/api/auth/plex/init",
      method: "POST",
    });

    const body = await expectJson<{ error: string }>(response, 500);

    expect(body.error).toBe("Failed to initialize Plex authentication");
  });

  it("should pass the pin code to getPlexAuthUrl", async () => {
    const pinCode = "unique-pin-code-xyz";
    mockCreatePlexPin.mockResolvedValue({
      id: 11111,
      code: pinCode,
      expiresAt: new Date().toISOString(),
    });
    mockGetPlexClientId.mockResolvedValue("test-client-id");
    mockGetPlexAuthUrl.mockResolvedValue("https://app.plex.tv/auth#?code=" + pinCode);

    await callRoute(POST, {
      url: "/api/auth/plex/init",
      method: "POST",
    });

    expect(mockGetPlexAuthUrl).toHaveBeenCalledWith(pinCode);
  });
});
