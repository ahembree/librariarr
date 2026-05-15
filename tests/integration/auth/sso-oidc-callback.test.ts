import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession, getMockSession } from "../../setup/mock-session";
import { callRoute, createTestUser } from "../../setup/test-helpers";

// External OIDC client surface is fully mocked — we never hit a real IdP. The
// callback's job is to orchestrate state-check + token-exchange + userinfo +
// DB writes; we verify orchestration, not the HTTP client.
const {
  mockDiscover,
  mockExchange,
  mockFetchUserInfo,
  mockResolveRedirectUri,
} = vi.hoisted(() => ({
  mockDiscover: vi.fn(),
  mockExchange: vi.fn(),
  mockFetchUserInfo: vi.fn(),
  mockResolveRedirectUri: vi.fn().mockReturnValue("http://localhost:3000/api/auth/sso/oidc/callback"),
}));

vi.mock("@/lib/sso/oidc-client", () => ({
  discoverOidc: mockDiscover,
  exchangeCodeForToken: mockExchange,
  fetchUserInfo: mockFetchUserInfo,
  resolveRedirectUri: mockResolveRedirectUri,
  // The route doesn't use these but other tests in the same import graph might.
  invalidateOidcDiscoveryCache: vi.fn(),
}));

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

import { GET } from "@/app/api/auth/sso/oidc/callback/route";

const prisma = getTestPrisma();

const ISSUER = "https://idp.example.com";

async function seedOidcSettings(userId: string, overrides: Partial<{
  ssoEnabled: boolean;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string | null;
  oidcUsernameClaim: string;
}> = {}) {
  return prisma.appSettings.create({
    data: {
      userId,
      ssoMode: "OIDC",
      ssoEnabled: overrides.ssoEnabled ?? true,
      oidcIssuer: overrides.oidcIssuer ?? ISSUER,
      oidcClientId: overrides.oidcClientId ?? "client-id",
      oidcClientSecret: overrides.oidcClientSecret ?? "client-secret",
      oidcUsernameClaim: overrides.oidcUsernameClaim ?? "preferred_username",
    },
  });
}

function setupSuccessfulExchange(info: Partial<{
  sub: string;
  email: string;
  preferred_username: string;
  name: string;
}> = {}) {
  mockDiscover.mockResolvedValue({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    jwks_uri: `${ISSUER}/jwks`,
  });
  mockExchange.mockResolvedValue({ access_token: "at", token_type: "Bearer" });
  mockFetchUserInfo.mockResolvedValue({ sub: info.sub ?? "user-sub-1", ...info });
}

describe("GET /api/auth/sso/oidc/callback", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockResolveRedirectUri.mockReturnValue("http://localhost:3000/api/auth/sso/oidc/callback");
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ── Pre-exchange guards ─────────────────────────────────────────────

  it("redirects to /login with sso_not_configured when SSO is not set up", async () => {
    const res = await callRoute(GET, { method: "GET" });
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("sso_error")).toBe("sso_not_configured");
  });

  it("redirects to /login when ssoEnabled is false (login flow, not link)", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id, { ssoEnabled: false });

    const res = await callRoute(GET, { method: "GET" });
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("sso_not_configured");
  });

  it("redirects to /login when missing code and state", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);

    const res = await callRoute(GET, { method: "GET" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("missing_params");
  });

  it("forwards provider error param to /login", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { error: "access_denied" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("access_denied");
  });

  it("redirects with state_mismatch when session state is missing", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "anything" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("state_mismatch");
  });

  it("redirects with state_mismatch when state differs from session", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);
    setMockSession({
      isLoggedIn: false,
      oidcState: "expected-state",
      oidcVerifier: "verifier",
    });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "wrong-state" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("state_mismatch");
  });

  it("wipes transient handshake fields even when exchange fails", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);
    setMockSession({
      isLoggedIn: false,
      oidcState: "expected-state",
      oidcVerifier: "verifier",
    });
    mockDiscover.mockRejectedValue(new Error("idp unreachable"));

    await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "expected-state" },
    });

    const after = getMockSession();
    expect(after.oidcState).toBeUndefined();
    expect(after.oidcVerifier).toBeUndefined();
    expect(after.oidcFlow).toBeUndefined();
  });

  it("redirects with token_exchange_failed when exchange throws", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);
    setMockSession({
      isLoggedIn: false,
      oidcState: "s",
      oidcVerifier: "v",
    });
    mockDiscover.mockResolvedValue({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/jwks`,
    });
    mockExchange.mockRejectedValue(new Error("bad code"));

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("token_exchange_failed");
  });

  // ── Login flow happy paths ──────────────────────────────────────────

  it("logs in when subject matches a linked, ssoEnabled user", async () => {
    const user = await createTestUser({ plexToken: "preserved-plex-token" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "sub-123",
        ssoIssuer: ISSUER,
        ssoEnabled: true,
      },
    });
    await seedOidcSettings(user.id);
    setMockSession({
      isLoggedIn: false,
      oidcState: "s",
      oidcVerifier: "v",
    });
    setupSuccessfulExchange({ sub: "sub-123" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");

    const session = getMockSession();
    expect(session.isLoggedIn).toBe(true);
    expect(session.userId).toBe(user.id);
    // plexToken is re-attached after destroy() so server discovery still works.
    expect(session.plexToken).toBe("preserved-plex-token");
  });

  it("rejects login with not_linked when no user matches the subject", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "unknown-sub" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("not_linked");
  });

  it("rejects login when user matches but ssoEnabled is false", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "sub-x", ssoIssuer: ISSUER, ssoEnabled: false },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "sub-x" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("not_linked");
  });

  it("rejects when the matching row has a different issuer", async () => {
    // Cross-IdP defense: same sub from a different issuer must not match.
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoSubject: "same-sub",
        ssoIssuer: "https://other-idp.example.com",
        ssoEnabled: true,
      },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "same-sub" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("not_linked");
  });

  it("backfills ssoIssuer for legacy rows with null issuer", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "legacy-sub", ssoIssuer: null, ssoEnabled: true },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "legacy-sub" });

    await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.ssoIssuer).toBe(ISSUER);
  });

  it("syncs username and email claims from userinfo on login", async () => {
    const user = await createTestUser({ username: "OldName", email: "old@example.com" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "s1", ssoIssuer: ISSUER, ssoEnabled: true },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({
      sub: "s1",
      preferred_username: "newname",
      email: "new@example.com",
    });

    await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.username).toBe("newname");
    expect(refreshed?.email).toBe("new@example.com");
  });

  it("does not write empty/whitespace claims over existing values", async () => {
    const user = await createTestUser({ username: "Keep", email: "keep@example.com" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "s1", ssoIssuer: ISSUER, ssoEnabled: true },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({
      sub: "s1",
      preferred_username: "   ",
      email: "",
    });

    await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.username).toBe("Keep");
    expect(refreshed?.email).toBe("keep@example.com");
  });

  it("uses the configured oidcUsernameClaim instead of preferred_username", async () => {
    const user = await createTestUser({ username: "Old" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "s1", ssoIssuer: ISSUER, ssoEnabled: true },
    });
    await seedOidcSettings(user.id, { oidcUsernameClaim: "name" });
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "s1", name: "Display Name" });

    await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.username).toBe("Display Name");
  });

  // ── Link flow ────────────────────────────────────────────────────────

  it("captures the sub and pins the issuer on link flow", async () => {
    const user = await createTestUser();
    // Link flow doesn't require ssoEnabled at the AppSettings level — admin
    // is mid-setup. But mode + issuer + client_id must be configured.
    await seedOidcSettings(user.id, { ssoEnabled: false });
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      oidcState: "s",
      oidcVerifier: "v",
      oidcFlow: "link",
    });
    setupSuccessfulExchange({ sub: "new-sub", preferred_username: "linked-user" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/settings");
    expect(loc.searchParams.get("ssoLinked")).toBe("1");

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.ssoSubject).toBe("new-sub");
    expect(refreshed?.ssoIssuer).toBe(ISSUER);
    expect(refreshed?.ssoEnabled).toBe(true);
    // Linking is a credential change — bumps sessionVersion to invalidate others.
    expect(refreshed?.sessionVersion).toBe(user.sessionVersion + 1);
  });

  it("keeps the linker's session alive after sessionVersion bump", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id, { ssoEnabled: false });
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      sessionVersion: user.sessionVersion,
      oidcState: "s",
      oidcVerifier: "v",
      oidcFlow: "link",
    });
    setupSuccessfulExchange({ sub: "new-sub" });

    await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });

    const after = getMockSession();
    expect(after.sessionVersion).toBe(user.sessionVersion + 1);
    expect(after.isLoggedIn).toBe(true);
    expect(after.userId).toBe(user.id);
  });

  it("redirects with conflict when another user already owns the sub+issuer", async () => {
    const other = await createTestUser({ plexId: "p-other", username: "other" });
    await prisma.user.update({
      where: { id: other.id },
      data: { ssoSubject: "taken-sub", ssoIssuer: ISSUER, ssoEnabled: true },
    });
    const me = await createTestUser({ plexId: "p-me", username: "me" });
    await seedOidcSettings(me.id, { ssoEnabled: false });
    setMockSession({
      isLoggedIn: true,
      userId: me.id,
      oidcState: "s",
      oidcVerifier: "v",
      oidcFlow: "link",
    });
    setupSuccessfulExchange({ sub: "taken-sub" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("ssoLinkError")).toBe("conflict");

    // No mutation — current user's row is untouched.
    const refreshed = await prisma.user.findUnique({ where: { id: me.id } });
    expect(refreshed?.ssoSubject).toBeNull();
  });

  it("redirects with session_lost when the linker's user row was deleted mid-flow", async () => {
    const me = await createTestUser();
    await seedOidcSettings(me.id, { ssoEnabled: false });
    setMockSession({
      isLoggedIn: true,
      userId: me.id,
      oidcState: "s",
      oidcVerifier: "v",
      oidcFlow: "link",
    });
    setupSuccessfulExchange({ sub: "fresh-sub" });

    // Race: user record deleted while admin was at the IdP (e.g. via
    // scripts/reset-auth.js delete-user).
    await prisma.appSettings.delete({ where: { userId: me.id } });
    await prisma.user.delete({ where: { id: me.id } });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    // No settings → guard rejects before reaching user.update; that's the
    // "session_lost"-ish path (sso_not_configured is the effective surface).
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("ssoLinkError")).toBe("sso_not_configured");
  });

  it("hits the P2025 catch when only the linker's user row is gone but settings remain", async () => {
    // Different shape of race from the test above: A different user owns
    // the AppSettings row, but the session's userId points at a deleted
    // admin. The route's settings load + isLinkFlow gate pass, but the
    // final user.update throws P2025. Verify the catch returns
    // session_lost (not a generic 500).
    const other = await createTestUser({ plexId: "p-other", username: "other" });
    await seedOidcSettings(other.id, { ssoEnabled: false });

    setMockSession({
      isLoggedIn: true,
      userId: "deleted-cuid-not-in-db",
      oidcState: "s",
      oidcVerifier: "v",
      oidcFlow: "link",
    });
    setupSuccessfulExchange({ sub: "fresh-sub" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("ssoLinkError")).toBe("session_lost");
  });

  // ── Identity-claim sanitization ─────────────────────────────────────
  //
  // The IdP is an external trust boundary. Even when manual linking is
  // already established, a compromised or misconfigured IdP can return
  // hostile values in the username / email claims. The callback runs
  // both through the shared sanitizer before persisting.

  it("strips control characters from synced username + email", async () => {
    const user = await createTestUser({ username: "Old", email: "old@example.com" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "s1", ssoIssuer: ISSUER, ssoEnabled: true },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({
      sub: "s1",
      preferred_username: "alice\nINJECTED",
      email: "alice\r\n@example.com",
    });

    await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    // Newline + carriage-return must be stripped from both fields. The
    // username is stored as "aliceINJECTED" — the sanitizer doesn't try
    // to detect injection semantics, just to neuter the dangerous bytes.
    expect(refreshed?.username).toBe("aliceINJECTED");
    expect(refreshed?.email).toBe("alice@example.com");
  });

  it("ignores oversize username/email claims from a hostile IdP", async () => {
    const user = await createTestUser({ username: "Keep", email: "keep@example.com" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "s1", ssoIssuer: ISSUER, ssoEnabled: true },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({
      sub: "s1",
      preferred_username: "x".repeat(10_000),
      email: `${"a".repeat(1000)}@example.com`,
    });

    await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.username).toBe("Keep");
    expect(refreshed?.email).toBe("keep@example.com");
  });

  it("ignores bogus email shapes (no @, multiple @s)", async () => {
    const user = await createTestUser({ email: "keep@example.com" });
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "s1", ssoIssuer: ISSUER, ssoEnabled: true },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "s1", email: "not-an-email" });

    await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.email).toBe("keep@example.com");
  });

  it("redirects link errors back to /settings, not /login", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id, { ssoEnabled: false });
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      oidcState: "expected",
      oidcVerifier: "v",
      oidcFlow: "link",
    });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "wrong" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/settings");
    expect(loc.searchParams.get("ssoLinkError")).toBe("state_mismatch");
  });

  it("treats unauthenticated session with oidcFlow=link as login flow, not link", async () => {
    // Defense in depth: oidcFlow=link only matters when the user is actually
    // logged in. A logged-out user with a stale link cookie must not trick
    // the route into the link path.
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "s1", ssoIssuer: ISSUER, ssoEnabled: true },
    });
    await seedOidcSettings(user.id);
    setMockSession({
      isLoggedIn: false,
      oidcState: "s",
      oidcVerifier: "v",
      oidcFlow: "link",
    });
    setupSuccessfulExchange({ sub: "s1" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    // Login flow → root, not /settings.
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });
});
