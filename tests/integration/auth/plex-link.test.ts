import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// file deepcode ignore HardcodedNonCryptoSecret/test: Test file with hardcoded values to run validation tests

// Mock Plex auth functions
const mockCheckPlexPin = vi.hoisted(() => vi.fn());
const mockGetPlexUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/plex/auth", () => ({
  checkPlexPin: mockCheckPlexPin,
  getPlexUser: mockGetPlexUser,
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
import { POST } from "@/app/api/auth/plex/link/route";

describe("POST /api/auth/plex/link", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockCheckPlexPin.mockReset();
    mockGetPlexUser.mockReset();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: { pinId: 12345 },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 with invalid body (missing pinId)", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns linked: false when pin check has no authToken", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockCheckPlexPin.mockResolvedValue({
      id: 12345,
      code: "abc",
      authToken: null,
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: { pinId: 12345 },
    });
    const body = await expectJson<{ linked: boolean; message: string }>(
      response,
      200
    );
    expect(body.linked).toBe(false);
    expect(body.message).toBe("Plex authentication not yet completed");
  });

  it("successfully links Plex account when pin is valid", async () => {
    const user = await createTestUser({ plexId: null as unknown as string });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockCheckPlexPin.mockResolvedValue({
      id: 12345,
      code: "abc",
      authToken: "tok123",
    });
    mockGetPlexUser.mockResolvedValue({
      id: 99999,
      uuid: "plex-uuid-123",
      email: "plexuser@example.com",
      username: "PlexUser",
      authToken: "tok123",
      thumb: "https://plex.tv/thumb.jpg",
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: { pinId: 12345 },
    });
    const body = await expectJson<{ linked: boolean; plexUsername: string }>(
      response,
      200
    );
    expect(body.linked).toBe(true);
    expect(body.plexUsername).toBe("PlexUser");

    // Verify checkPlexPin was called with the pin ID
    expect(mockCheckPlexPin).toHaveBeenCalledWith(12345);
    // Verify getPlexUser was called with the auth token
    expect(mockGetPlexUser).toHaveBeenCalledWith("tok123");
  });

  it("returns 409 when Plex account is already linked to another user", async () => {
    // Create two users; user2 already has the Plex ID
    const user1 = await createTestUser({ plexId: "plex-user1" });
    await createTestUser({ plexId: "99999", username: "other" });

    setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

    mockCheckPlexPin.mockResolvedValue({
      id: 12345,
      code: "abc",
      authToken: "tok123",
    });
    mockGetPlexUser.mockResolvedValue({
      id: 99999,
      uuid: "plex-uuid-123",
      email: "plexuser@example.com",
      username: "PlexUser",
      authToken: "tok123",
      thumb: "https://plex.tv/thumb.jpg",
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: { pinId: 12345 },
    });
    const body = await expectJson<{ error: string }>(response, 409);
    expect(body.error).toBe(
      "This Plex account is already linked to another user"
    );
  });

  it("returns 500 when checkPlexPin throws an error", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockCheckPlexPin.mockRejectedValue(new Error("Plex API unavailable"));

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: { pinId: 12345 },
    });
    const body = await expectJson<{ error: string }>(response, 500);
    expect(body.error).toBe("Failed to link Plex account");
  });

  // ─── authToken-based flow (new client-side polling approach) ───

  it("successfully links Plex account when authToken is provided directly", async () => {
    const user = await createTestUser({ plexId: null as unknown as string });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockGetPlexUser.mockResolvedValue({
      id: 88888,
      uuid: "plex-uuid-direct",
      email: "direct@example.com",
      username: "DirectUser",
      authToken: "direct-token",
      thumb: "https://plex.tv/thumb.jpg",
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: { authToken: "direct-token" },
    });
    const body = await expectJson<{ linked: boolean; plexUsername: string }>(
      response,
      200
    );
    expect(body.linked).toBe(true);
    expect(body.plexUsername).toBe("DirectUser");

    // checkPlexPin should NOT be called when authToken is provided
    expect(mockCheckPlexPin).not.toHaveBeenCalled();
    expect(mockGetPlexUser).toHaveBeenCalledWith("direct-token");
  });

  it("returns 409 when authToken Plex account is already linked to another user", async () => {
    const user1 = await createTestUser({ plexId: "plex-user1" });
    await createTestUser({ plexId: "88888", username: "other" });

    setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

    mockGetPlexUser.mockResolvedValue({
      id: 88888,
      uuid: "plex-uuid-direct",
      email: "direct@example.com",
      username: "DirectUser",
      authToken: "direct-token",
      thumb: "https://plex.tv/thumb.jpg",
    });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: { authToken: "direct-token" },
    });
    const body = await expectJson<{ error: string }>(response, 409);
    expect(body.error).toBe(
      "This Plex account is already linked to another user"
    );
  });
});
