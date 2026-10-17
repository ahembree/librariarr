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

// Mock rate limiter: the route only starts a flow, so it is charged on every
// call (see `checkAuthRateLimit`). The real limiter's state would persist.
const mockCheckAuthRateLimit = vi.hoisted(() => vi.fn((): Response | null => null));
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  checkAuthRateLimit: mockCheckAuthRateLimit,
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/auth/plex/init/route";

describe("POST /api/auth/plex/init", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    // mockReset: a `mockResolvedValue` set by one test must not answer the next.
    for (const mock of [mockCreatePlexPin, mockGetPlexAuthUrl, mockGetPlexClientId]) mock.mockReset();
    mockCheckAuthRateLimit.mockReset().mockReturnValue(null);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("should return pin data, auth URL, and client credentials on success", async () => {
    const expiresAt = new Date(Date.now() + 1800000).toISOString();
    // The shape plex.tv answers `POST /api/v2/pins` (strong) with.
    mockCreatePlexPin.mockResolvedValue({
      id: 1854039224,
      code: "test-code-abc",
      product: "Librariarr",
      clientIdentifier: "test-client-id",
      expiresIn: 1800,
      createdAt: new Date().toISOString(),
      expiresAt,
      authToken: null,
    });
    mockGetPlexClientId.mockResolvedValue("test-client-id");
    mockGetPlexAuthUrl.mockResolvedValue(
      "https://app.plex.tv/auth#?clientID=test-client-id&code=test-code-abc"
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

    expect(body).toEqual({
      pinId: 1854039224,
      code: "test-code-abc",
      clientId: "test-client-id",
      product: "Librariarr",
      version: "0.1.0",
      authUrl: "https://app.plex.tv/auth#?clientID=test-client-id&code=test-code-abc",
      expiresAt,
    });
    expect(mockCreatePlexPin).toHaveBeenCalledOnce();
    expect(mockGetPlexAuthUrl).toHaveBeenCalledWith("test-code-abc");
    expect(mockCheckAuthRateLimit).toHaveBeenCalledWith(expect.anything(), "plex-init");
  });

  it("returns the limiter's 429 without asking plex.tv for a PIN", async () => {
    mockCheckAuthRateLimit.mockReturnValue(
      Response.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    );

    const response = await callRoute(POST, {
      url: "/api/auth/plex/init",
      method: "POST",
    });

    const body = await expectJson<{ error: string }>(response, 429);
    expect(body.error).toBe("Too many attempts. Try again later.");
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mockCreatePlexPin).not.toHaveBeenCalled();
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
      id: 1854039225,
      code: "some-code",
      product: "Librariarr",
      clientIdentifier: "test-client-id",
      expiresIn: 1800,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      authToken: null,
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
});
