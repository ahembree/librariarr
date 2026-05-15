import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession, getMockSession } from "../../setup/mock-session";
import { callRoute, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  checkAuthRateLimit: () => null,
  authRateLimiter: { check: () => ({ limited: false }) },
  getClientIp: () => "127.0.0.1",
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/auth/sso/forward/route";

const prisma = getTestPrisma();

// Same-origin Referer satisfies the strict CSRF check the route uses.
const SAME_ORIGIN_HEADERS = { Referer: "http://localhost:3000/login" };

async function seedForwardAuth(userId: string, overrides: Partial<{
  ssoEnabled: boolean;
  forwardAuthUserHeader: string;
  forwardAuthEmailHeader: string;
  forwardAuthNameHeader: string;
}> = {}) {
  return prisma.appSettings.create({
    data: {
      userId,
      ssoMode: "FORWARD_AUTH",
      ssoEnabled: overrides.ssoEnabled ?? true,
      forwardAuthUserHeader: overrides.forwardAuthUserHeader ?? "Remote-User",
      forwardAuthEmailHeader: overrides.forwardAuthEmailHeader ?? "Remote-Email",
      forwardAuthNameHeader: overrides.forwardAuthNameHeader ?? "Remote-Name",
    },
  });
}

describe("GET /api/auth/sso/forward — strict CSRF + manual link", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("rejects requests with no Origin and no Referer (strict CSRF)", async () => {
    const user = await createTestUser();
    await seedForwardAuth(user.id);

    const res = await callRoute(GET, { method: "GET" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("csrf_blocked");
  });

  it("rejects cross-origin requests", async () => {
    const user = await createTestUser();
    await seedForwardAuth(user.id);

    const res = await callRoute(GET, {
      method: "GET",
      headers: { Origin: "https://evil.example.com" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("csrf_blocked");
  });

  it("redirects with sso_not_configured when SSO is disabled", async () => {
    const user = await createTestUser();
    await seedForwardAuth(user.id, { ssoEnabled: false });

    const res = await callRoute(GET, { method: "GET", headers: SAME_ORIGIN_HEADERS });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("sso_not_configured");
  });

  it("redirects with sso_not_configured when mode is OIDC, not FORWARD_AUTH", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoMode: "OIDC",
        ssoEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client",
      },
    });

    const res = await callRoute(GET, { method: "GET", headers: SAME_ORIGIN_HEADERS });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("sso_not_configured");
  });

  it("redirects with missing_user_header when the configured header is absent", async () => {
    const user = await createTestUser();
    await seedForwardAuth(user.id);

    const res = await callRoute(GET, { method: "GET", headers: SAME_ORIGIN_HEADERS });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("missing_user_header");
  });

  it("trims whitespace from the user header before matching", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: "forward-auth", ssoEnabled: true },
    });
    await seedForwardAuth(user.id);

    const res = await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "Remote-User": "  alice  " },
    });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("rejects when subject header doesn't match any linked user", async () => {
    const user = await createTestUser();
    await seedForwardAuth(user.id);

    const res = await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "Remote-User": "nobody" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("not_linked");
  });

  it("rejects when matching row has ssoEnabled=false", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: "forward-auth", ssoEnabled: false },
    });
    await seedForwardAuth(user.id);

    const res = await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "Remote-User": "alice" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("not_linked");
  });

  it("rejects when the linked user's ssoIssuer is OIDC, not forward-auth", async () => {
    // Same subject from a different mode must not let someone in.
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "alice",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await seedForwardAuth(user.id);

    const res = await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "Remote-User": "alice" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("not_linked");
  });

  it("backfills ssoIssuer for legacy rows with null issuer", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: null, ssoEnabled: true },
    });
    await seedForwardAuth(user.id);

    await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "Remote-User": "alice" },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.ssoIssuer).toBe("forward-auth");
  });

  it("syncs email and name headers into the User record", async () => {
    const user = await createTestUser({ username: "OldName", email: "old@example.com" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: "forward-auth", ssoEnabled: true },
    });
    await seedForwardAuth(user.id);

    await callRoute(GET, {
      method: "GET",
      headers: {
        ...SAME_ORIGIN_HEADERS,
        "Remote-User": "alice",
        "Remote-Email": "alice@example.com",
        "Remote-Name": "Alice Liddell",
      },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.email).toBe("alice@example.com");
    expect(refreshed?.username).toBe("Alice Liddell");
  });

  it("attaches plexToken to the new session when present", async () => {
    const user = await createTestUser({ plexToken: "kept-token" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: "forward-auth", ssoEnabled: true },
    });
    await seedForwardAuth(user.id);

    await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "Remote-User": "alice" },
    });

    const session = getMockSession();
    expect(session.isLoggedIn).toBe(true);
    expect(session.userId).toBe(user.id);
    expect(session.plexToken).toBe("kept-token");
  });

  it("respects custom forwardAuthUserHeader names", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: "forward-auth", ssoEnabled: true },
    });
    await seedForwardAuth(user.id, { forwardAuthUserHeader: "X-Authentik-Username" });

    const res = await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "X-Authentik-Username": "alice" },
    });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  // ── Identity-claim sanitization ─────────────────────────────────────
  //
  // The reverse proxy is an external trust boundary. The route runs
  // Remote-Email and Remote-Name through the shared sanitizer. Control
  // bytes and CRLF in header values are rejected by the fetch Headers
  // API before they can reach this route, so those cases are unit-tested
  // in tests/unit/sso/identity-claims.test.ts instead. Here we cover
  // what a misbehaving proxy CAN actually send: oversize values and
  // bogus email shapes.

  it("ignores oversize email/name header values", async () => {
    const user = await createTestUser({ username: "Keep", email: "keep@example.com" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: "forward-auth", ssoEnabled: true },
    });
    await seedForwardAuth(user.id);

    await callRoute(GET, {
      method: "GET",
      headers: {
        ...SAME_ORIGIN_HEADERS,
        "Remote-User": "alice",
        "Remote-Email": `${"a".repeat(1000)}@example.com`,
        "Remote-Name": "x".repeat(5000),
      },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.username).toBe("Keep");
    expect(refreshed?.email).toBe("keep@example.com");
  });

  it("ignores bogus email shapes from the proxy", async () => {
    const user = await createTestUser({ email: "keep@example.com" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: "forward-auth", ssoEnabled: true },
    });
    await seedForwardAuth(user.id);

    await callRoute(GET, {
      method: "GET",
      headers: {
        ...SAME_ORIGIN_HEADERS,
        "Remote-User": "alice",
        "Remote-Email": "not-an-email",
      },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.email).toBe("keep@example.com");
  });
});
