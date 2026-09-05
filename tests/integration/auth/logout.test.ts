import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

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

// Import route handlers AFTER mocks
import { POST, GET } from "@/app/api/auth/logout/route";

const prisma = getTestPrisma();

describe("POST /api/auth/logout", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("should destroy session and return success", async () => {
    setMockSession({
      userId: "user-123",
      plexToken: "plex-token-abc",
      isLoggedIn: true,
    });

    const response = await callRoute(POST, {
      url: "/api/auth/logout",
      method: "POST",
    });

    const body = await expectJson<{ success: boolean }>(response, 200);

    expect(body.success).toBe(true);
  });

  it("should succeed even when no session is active", async () => {
    // Session is already cleared (not logged in)
    const response = await callRoute(POST, {
      url: "/api/auth/logout",
      method: "POST",
    });

    const body = await expectJson<{ success: boolean }>(response, 200);

    expect(body.success).toBe(true);
  });

  it("revokes every outstanding session by bumping sessionVersion", async () => {
    // The cookie is stateless: clearing it locally leaves a copied cookie
    // valid. Logging out must make `getSession` refuse it everywhere.
    const user = await createTestUser();
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    setMockSession({ userId: user.id, isLoggedIn: true, sessionVersion: before });

    const response = await callRoute(POST, { url: "/api/auth/logout", method: "POST" });
    await expectJson(response, 200);

    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    expect(after).toBe(before + 1);
  });

  it("does not touch any user when the session is anonymous", async () => {
    const user = await createTestUser();
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;

    await callRoute(POST, { url: "/api/auth/logout", method: "POST" });

    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    expect(after).toBe(before);
  });

  it("still clears the cookie when the user row is gone", async () => {
    setMockSession({ userId: "no-such-user", isLoggedIn: true, sessionVersion: 1 });
    const response = await callRoute(POST, { url: "/api/auth/logout", method: "POST" });
    const body = await expectJson<{ success: boolean }>(response, 200);
    expect(body.success).toBe(true);
  });

  it("GET logout also revokes every outstanding session", async () => {
    const user = await createTestUser();
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    setMockSession({ userId: user.id, isLoggedIn: true, sessionVersion: before });

    const response = await callRoute(GET, { url: "/api/auth/logout", method: "GET" });
    expect(response.status).toBe(307);

    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    expect(after).toBe(before + 1);
  });
});

describe("GET /api/auth/logout", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("should destroy session and redirect to /login", async () => {
    setMockSession({
      userId: "user-456",
      plexToken: "plex-token-def",
      isLoggedIn: true,
    });

    const response = await callRoute(GET, {
      url: "/api/auth/logout",
      method: "GET",
    });

    // NextResponse.redirect returns a 307 by default
    expect(response.status).toBe(307);

    const locationHeader = response.headers.get("location");
    expect(locationHeader).toBeDefined();
    expect(locationHeader).toContain("/login");
  });

  it("should redirect to /login even when no session is active", async () => {
    const response = await callRoute(GET, {
      url: "/api/auth/logout",
      method: "GET",
    });

    expect(response.status).toBe(307);

    const locationHeader = response.headers.get("location");
    expect(locationHeader).toBeDefined();
    expect(locationHeader).toContain("/login");
  });
});
