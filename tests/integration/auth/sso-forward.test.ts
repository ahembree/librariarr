import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { isSsoUsable, getSsoSettings } from "@/lib/sso/config";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession, getMockSession } from "../../setup/mock-session";
import { callRoute, createTestUser } from "../../setup/test-helpers";

// Reserved before the headers are trusted and given back on a sign-in that
// succeeds (login-lockout.test.ts runs the real limiter).
const { mockReserve, mockSucceeded } = vi.hoisted(() => {
  const mockSucceeded = vi.fn();
  return {
    mockReserve: vi.fn(
      (): { refused: Response } | { refused: null; succeeded: () => void } => ({ refused: null, succeeded: mockSucceeded }),
    ),
    mockSucceeded,
  };
});
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  reserveAuthAttempt: mockReserve,
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
const REFERER = { Referer: "http://localhost:3000/login" };
// Forward-auth is not usable without `FORWARD_AUTH_SECRET` (forward-secret.ts),
// so the file runs with one set and the proxy sending it; the block at the end
// covers an install that has not set it.
const secret = "proxy-only-5f3a9c";
const SAME_ORIGIN_HEADERS = { ...REFERER, "X-Librariarr-Proxy-Secret": secret };
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.FORWARD_AUTH_SECRET;
  process.env.FORWARD_AUTH_SECRET = secret;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.FORWARD_AUTH_SECRET;
  else process.env.FORWARD_AUTH_SECRET = previousSecret;
});

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

/** The admin, linked to the forward-auth subject "alice". */
async function linkedAlice() {
  const user = await createTestUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { ssoSubject: "alice", ssoIssuer: "forward-auth", ssoEnabled: true },
  });
  await seedForwardAuth(user.id);
  return user;
}

describe("GET /api/auth/sso/forward — strict CSRF + manual link", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockReserve.mockReturnValue({ refused: null, succeeded: mockSucceeded });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // Every header a real sign-in carries, so only the CSRF check stands in the way.
  it("rejects requests with no Origin and no Referer (strict CSRF)", async () => {
    await linkedAlice();

    const res = await callRoute(GET, {
      method: "GET",
      headers: { "Remote-User": "alice", "X-Librariarr-Proxy-Secret": secret },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("csrf_blocked");
    expect(getMockSession().isLoggedIn).toBe(false);
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests", async () => {
    await linkedAlice();

    const res = await callRoute(GET, {
      method: "GET",
      headers: { Origin: "https://evil.example.com", "Remote-User": "alice", "X-Librariarr-Proxy-Secret": secret },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("csrf_blocked");
    expect(getMockSession().isLoggedIn).toBe(false);
  });

  it("returns the limiter's 429 before trusting any header", async () => {
    await linkedAlice();
    mockReserve.mockReturnValue({
      refused: Response.json({ error: "Too many attempts. Try again later." }, { status: 429 }),
    });

    const res = await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "Remote-User": "alice" },
    });
    expect(res.status).toBe(429);
    expect(mockReserve).toHaveBeenCalledWith(expect.anything(), "sso-forward");
    expect(getMockSession().isLoggedIn).toBe(false);
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

  describe("the proxy secret", () => {
    // A client reaching the app's port directly can send the identity header
    // itself; it cannot send the secret only the proxy knows.
    it.each([
      ["no secret header", {}],
      ["a wrong secret", { "X-Librariarr-Proxy-Secret": "guess" }],
      ["a secret of another length", { "X-Librariarr-Proxy-Secret": `${secret}x` }],
    ])("refuses a spoofed identity header with %s", async (_label, extra: Record<string, string>) => {
      await linkedAlice();
      const res = await callRoute(GET, {
        method: "GET",
        headers: { ...REFERER, "Remote-User": "alice", ...extra },
      });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("sso_error")).toBe("untrusted_proxy");
      expect(getMockSession().isLoggedIn).toBe(false);
      // A refused sign-in stays charged.
      expect(mockSucceeded).not.toHaveBeenCalled();
    });

    it("signs in when the proxy sends the secret — and the cookie carries no Plex token", async () => {
      const user = await linkedAlice();
      const res = await callRoute(GET, {
        method: "GET",
        headers: { ...REFERER, "Remote-User": "alice", "X-Librariarr-Proxy-Secret": secret },
      });
      expect(res.headers.get("location")).toBe("http://localhost:3000/");
      expect(getMockSession()).toMatchObject({ isLoggedIn: true, userId: user.id, sessionVersion: user.sessionVersion });
      expect("plexToken" in getMockSession()).toBe(false);
      // A sign-in that succeeded is given back to the budget.
      expect(mockSucceeded).toHaveBeenCalledTimes(1);
    });

    // The secret used to be opt-in: unset, any client that reached the app's
    // port directly signed in by sending `Remote-User` itself. Now forward-auth
    // is simply not usable without it — the login page offers no SSO button,
    // and a request that reaches the route anyway is refused by name.
    describe("when FORWARD_AUTH_SECRET is unset", () => {
      beforeEach(() => {
        delete process.env.FORWARD_AUTH_SECRET;
      });
      afterAll(() => {
        process.env.FORWARD_AUTH_SECRET = secret;
      });

      it("is not usable, so the login page does not offer it", async () => {
        await linkedAlice();
        expect(isSsoUsable(await getSsoSettings())).toBe(false);
      });

      it("refuses the identity header with forward_auth_unconfigured, even with a value in the secret header", async () => {
        await linkedAlice();
        const extras: Record<string, string>[] = [{}, { "X-Librariarr-Proxy-Secret": secret }];
        for (const extra of extras) {
          const res = await callRoute(GET, {
            method: "GET",
            headers: { ...REFERER, "Remote-User": "alice", ...extra },
          });
          const loc = new URL(res.headers.get("location")!);
          expect(loc.searchParams.get("sso_error")).toBe("forward_auth_unconfigured");
          expect(getMockSession().isLoggedIn).toBe(false);
        }
      });
    });
  });

  it("redirects with missing_user_header when the configured header is absent", async () => {
    await linkedAlice();

    const res = await callRoute(GET, { method: "GET", headers: SAME_ORIGIN_HEADERS });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("missing_user_header");
    expect(getMockSession().isLoggedIn).toBe(false);
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
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    expect(getMockSession()).toMatchObject({ isLoggedIn: true, userId: user.id });
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
    expect(getMockSession().isLoggedIn).toBe(false);
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
    expect(getMockSession().isLoggedIn).toBe(false);
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
    expect(getMockSession().isLoggedIn).toBe(false);
  });

  it("backfills ssoIssuer for legacy rows with null issuer", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: null, ssoEnabled: true },
    });
    await seedForwardAuth(user.id);

    const res = await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "Remote-User": "alice" },
    });
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    expect(getMockSession()).toMatchObject({ isLoggedIn: true, userId: user.id });

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

  it("keeps a stored Plex token in the User row, never in the new session", async () => {
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
    // The Plex token stays in the User row; the cookie never carries it.
    expect("plexToken" in session).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).plexToken).toBe("kept-token");
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
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    expect(getMockSession()).toMatchObject({ isLoggedIn: true, userId: user.id });
  });

  // The proxy only overwrites the header it is configured to set; any other
  // one passes through from the client, so it must never be read.
  it("ignores the default header when a custom one is configured", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "alice", ssoIssuer: "forward-auth", ssoEnabled: true },
    });
    await seedForwardAuth(user.id, { forwardAuthUserHeader: "X-Authentik-Username" });

    const res = await callRoute(GET, {
      method: "GET",
      headers: { ...SAME_ORIGIN_HEADERS, "Remote-User": "alice" },
    });
    expect(new URL(res.headers.get("location")!).searchParams.get("sso_error")).toBe("missing_user_header");
    expect(getMockSession().isLoggedIn).toBe(false);
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
    // The sign-in itself still succeeds; only the claims are dropped.
    expect(getMockSession()).toMatchObject({ isLoggedIn: true, userId: user.id });

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
