import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession, getMockSession } from "../../setup/mock-session";
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
      isLoggedIn: true,
    });

    const response = await callRoute(POST, {
      url: "/api/auth/logout",
      method: "POST",
    });

    const body = await expectJson<{ success: boolean }>(response, 200);

    expect(body.success).toBe(true);
    expect(getMockSession()).toEqual({ isLoggedIn: false });
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

    const response = await callRoute(POST, { url: "/api/auth/logout", method: "POST" });
    await expectJson(response, 200);

    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    expect(after).toBe(before);
  });

  it("still clears the cookie when the user row is gone", async () => {
    setMockSession({ userId: "no-such-user", isLoggedIn: true, sessionVersion: 1 });
    const response = await callRoute(POST, { url: "/api/auth/logout", method: "POST" });
    const body = await expectJson<{ success: boolean }>(response, 200);
    expect(body.success).toBe(true);
    expect(getMockSession()).toEqual({ isLoggedIn: false });
  });

  // SameSite=Lax already keeps the cookie off most cross-site POSTs; the
  // origin check is the defence where a browser's enforcement is not.
  it("refuses a POST from another origin and signs nobody out", async () => {
    const user = await createTestUser();
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    setMockSession({ userId: user.id, isLoggedIn: true, sessionVersion: before });

    const response = await callRoute(POST, {
      url: "/api/auth/logout",
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    const body = await expectJson<{ error: string }>(response, 403);
    expect(body.error).toBe("Forbidden");

    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    expect(after).toBe(before);
    expect(getMockSession().isLoggedIn).toBe(true);
  });

  it("GET logout also revokes every outstanding session", async () => {
    const user = await createTestUser();
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    setMockSession({ userId: user.id, isLoggedIn: true, sessionVersion: before });

    const response = await callRoute(GET, {
      url: "/api/auth/logout",
      method: "GET",
      headers: { Referer: "http://localhost:3000/settings" },
    });
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
      isLoggedIn: true,
    });

    const response = await callRoute(GET, {
      url: "/api/auth/logout",
      method: "GET",
      headers: { Referer: "http://localhost:3000/" },
    });

    // NextResponse.redirect returns a 307 by default
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(getMockSession()).toEqual({ isLoggedIn: false });
  });

  it("should redirect to /login even when no session is active", async () => {
    const response = await callRoute(GET, {
      url: "/api/auth/logout",
      method: "GET",
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });

  // `<img src="/api/auth/logout">` on another site sends its own Origin.
  it("signs nobody out for a request from another origin", async () => {
    const user = await createTestUser();
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    setMockSession({ userId: user.id, isLoggedIn: true, sessionVersion: before });

    const response = await callRoute(GET, {
      url: "/api/auth/logout",
      method: "GET",
      headers: { Referer: "https://evil.example/page" },
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");

    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    expect(after).toBe(before);
    expect(getMockSession().isLoggedIn).toBe(true);
  });

  // A link on another site with rel=noreferrer sends neither Origin nor
  // Referer; the browser still marks the navigation as cross-site.
  it.each(["cross-site", "same-site"])(
    "signs nobody out for a %s navigation that carries no Origin or Referer",
    async (fetchSite) => {
      const user = await createTestUser();
      const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
      setMockSession({ userId: user.id, isLoggedIn: true, sessionVersion: before });

      const response = await callRoute(GET, {
        url: "/api/auth/logout",
        method: "GET",
        headers: { "Sec-Fetch-Site": fetchSite },
      });
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("http://localhost:3000/login");

      const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
      expect(after).toBe(before);
      expect(getMockSession().isLoggedIn).toBe(true);
    },
  );

  // Over plain http the browser sends no Sec-Fetch-Site at all, so a page
  // anywhere that navigates here with `Referrer-Policy: no-referrer` arrives
  // exactly like this: the Lax cookie and nothing else.
  it("leaves a valid session alone when the request shows nothing about where it came from", async () => {
    const user = await createTestUser();
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    setMockSession({ userId: user.id, isLoggedIn: true, sessionVersion: before });

    const response = await callRoute(GET, { url: "/api/auth/logout", method: "GET" });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    expect(after).toBe(before);
    expect(getMockSession().isLoggedIn).toBe(true);
  });

  // The layout redirects here, with no headers, for a session `getSession()`
  // has already refused: the stale cookie is still cleared.
  it("clears the cookie of a session that is no longer valid, with no headers", async () => {
    setMockSession({ isLoggedIn: false, oidcState: "left-over" });

    const response = await callRoute(GET, { url: "/api/auth/logout", method: "GET" });

    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(getMockSession()).toEqual({ isLoggedIn: false });
  });

  it("logs out for a navigation from the app's own page", async () => {
    const user = await createTestUser();
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    setMockSession({ userId: user.id, isLoggedIn: true, sessionVersion: before });

    const response = await callRoute(GET, {
      url: "/api/auth/logout",
      method: "GET",
      headers: { Referer: "http://localhost:3000/settings" },
    });

    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    expect(after).toBe(before + 1);
    expect(getMockSession().isLoggedIn).toBe(false);
  });

  it.each(["same-origin", "none"])("still logs out for a %s navigation", async (fetchSite) => {
    const user = await createTestUser();
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    setMockSession({ userId: user.id, isLoggedIn: true, sessionVersion: before });

    const response = await callRoute(GET, {
      url: "/api/auth/logout",
      method: "GET",
      headers: { "Sec-Fetch-Site": fetchSite },
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");

    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    expect(after).toBe(before + 1);
    expect(getMockSession()).toEqual({ isLoggedIn: false });
  });
});
