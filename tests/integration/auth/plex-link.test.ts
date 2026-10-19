import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

const prisma = getTestPrisma();

/** An admin with no Plex account linked yet (the factory always fills one in). */
async function createUserWithoutPlex() {
  const user = await createTestUser();
  return prisma.user.update({ where: { id: user.id }, data: { plexId: null, plexToken: null } });
}

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

  // A linked Plex account is a way to sign in that outlives the session, and
  // any Plex account can be linked, so a stolen cookie must not be enough.
  it("refuses to link without a sign-in from the last 15 minutes", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: { authToken: "attacker-token" },
    });
    const body = await expectJson<{ error: string; code: string }>(response, 403);
    expect(body.code).toBe("reauth_required");
    expect((body as unknown as { methods: string[] }).methods).toEqual(["plex"]);
    expect(mockGetPlexUser).not.toHaveBeenCalled();
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchanged.plexId).toBe(user.plexId);
    expect(unchanged.plexToken).toBe(user.plexToken);
  });

  it("returns 400 with invalid body (missing pinId)", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([": Either pinId or authToken must be provided"]);
  });

  it("returns linked: false when pin check has no authToken", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

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
    expect(mockGetPlexUser).not.toHaveBeenCalled();
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchanged.plexId).toBe(user.plexId);
  });

  it("successfully links Plex account when pin is valid", async () => {
    const user = await createUserWithoutPlex();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

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

    const linked = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(linked.plexId).toBe("99999");
    expect(linked.plexToken).toBe("tok123");
    expect(linked.email).toBe("plexuser@example.com");
  });

  it("returns 500 when checkPlexPin throws an error", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    mockCheckPlexPin.mockRejectedValue(new Error("Plex API unavailable"));

    const response = await callRoute(POST, {
      url: "/api/auth/plex/link",
      method: "POST",
      body: { pinId: 12345 },
    });
    const body = await expectJson<{ error: string }>(response, 500);
    expect(body.error).toBe("Failed to link Plex account");
  });

  it("reports whether Plex login is on, so the page can offer to turn it on", async () => {
    // Linking never changes the setting, and a password setup leaves it off.
    const user = await createUserWithoutPlex();
    await prisma.appSettings.create({ data: { userId: user.id, plexLoginEnabled: false } });
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });
    mockGetPlexUser.mockResolvedValue({
      id: 77777, uuid: "u", email: "x@example.com", username: "Linker", authToken: "t", thumb: "",
    });

    const response = await callRoute(POST, { url: "/api/auth/plex/link", method: "POST", body: { authToken: "t" } });
    const body = await expectJson<{ linked: boolean; plexLoginEnabled: boolean }>(response, 200);
    expect(body).toMatchObject({ linked: true, plexLoginEnabled: false });
    const settings = await prisma.appSettings.findUniqueOrThrow({ where: { userId: user.id } });
    expect(settings.plexLoginEnabled).toBe(false);
  });

  // ─── authToken-based flow (new client-side polling approach) ───

  it("successfully links Plex account when authToken is provided directly", async () => {
    const user = await createUserWithoutPlex();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

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

    const linked = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(linked.plexId).toBe("88888");
    expect(linked.plexToken).toBe("direct-token");
  });
});
