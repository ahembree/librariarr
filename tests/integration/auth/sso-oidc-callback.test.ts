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

vi.mock("@/lib/sso/oidc-client", async (importOriginal) => ({
  // Pure: reads the claims out of the token the mocked exchange returns.
  readIdTokenClaims: (await importOriginal<typeof import("@/lib/sso/oidc-client")>()).readIdTokenClaims,
  discoverOidc: mockDiscover,
  exchangeCodeForToken: mockExchange,
  fetchUserInfo: mockFetchUserInfo,
  resolveRedirectUri: mockResolveRedirectUri,
  // The route doesn't use these but other tests in the same import graph might.
  invalidateOidcDiscoveryCache: vi.fn(),
}));

// Reserved as the callback starts and given back when it signs someone in,
// links or confirms (login-lockout.test.ts runs the real limiter).
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

/** An ID token as the token endpoint returns it (the signature is never read). */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
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
  // The provider signed the user in just now, as `prompt=login` asks.
  mockExchange.mockResolvedValue({
    access_token: "at",
    token_type: "Bearer",
    id_token: idToken({ sub: info.sub ?? "user-sub-1", auth_time: Math.floor(Date.now() / 1000) }),
  });
  mockFetchUserInfo.mockResolvedValue({ sub: info.sub ?? "user-sub-1", ...info });
}

describe("GET /api/auth/sso/oidc/callback", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // mockReset: a resolved or rejected value set by one test must not answer
    // the next one's discovery, exchange or userinfo call.
    for (const mock of [mockDiscover, mockExchange, mockFetchUserInfo]) mock.mockReset();
    mockResolveRedirectUri.mockReturnValue("http://localhost:3000/api/auth/sso/oidc/callback");
    mockReserve.mockReturnValue({ refused: null, succeeded: mockSucceeded });
  });

  it("returns the limiter's 429 before reading any setting or calling the IdP", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
    mockReserve.mockReturnValue({
      refused: Response.json({ error: "Too many attempts. Try again later." }, { status: 429 }),
    });

    const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } });
    expect(res.status).toBe(429);
    expect(mockReserve).toHaveBeenCalledWith(expect.anything(), "sso-oidc-callback");
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockExchange).not.toHaveBeenCalled();
    expect(getMockSession().isLoggedIn).toBe(false);
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

  // Everything else would sign the linked admin in: only the state check
  // stands between a forged callback and a session.
  it("redirects with state_mismatch when state differs from session", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "sub-123", ssoIssuer: ISSUER, ssoEnabled: true },
    });
    await seedOidcSettings(user.id);
    setMockSession({
      isLoggedIn: false,
      oidcStartedAt: Date.now(), oidcState: "expected-state",
      oidcVerifier: "verifier",
    });
    setupSuccessfulExchange({ sub: "sub-123" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "wrong-state" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("sso_error")).toBe("state_mismatch");
    expect(mockExchange).not.toHaveBeenCalled();
    const session = getMockSession();
    expect(session.isLoggedIn).toBe(false);
    // Single-use: a failed attempt cannot be retried against the same handshake.
    expect(session.oidcState).toBeUndefined();
    expect(session.oidcVerifier).toBeUndefined();
    expect(mockSucceeded).not.toHaveBeenCalled();
  });

  it("wipes transient handshake fields even when exchange fails", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);
    setMockSession({
      isLoggedIn: false,
      oidcStartedAt: Date.now(), oidcState: "expected-state",
      oidcVerifier: "verifier",
    });
    mockDiscover.mockRejectedValue(new Error("idp unreachable"));

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "expected-state" },
    });
    expect(new URL(res.headers.get("location")!).searchParams.get("sso_error")).toBe("token_exchange_failed");

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
      oidcStartedAt: Date.now(), oidcState: "s",
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
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
    expect(getMockSession().isLoggedIn).toBe(false);
    expect(mockSucceeded).not.toHaveBeenCalled();
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
      oidcStartedAt: Date.now(), oidcState: "s",
      oidcVerifier: "v",
    });
    setupSuccessfulExchange({ sub: "sub-123" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/");

    // The code is redeemed with the PKCE verifier this browser's handshake
    // stored, against the configured client.
    expect(mockExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "c",
        codeVerifier: "v",
        redirectUri: "http://localhost:3000/api/auth/sso/oidc/callback",
      }),
    );
    expect(mockSucceeded).toHaveBeenCalledTimes(1);

    const session = getMockSession();
    expect(session.isLoggedIn).toBe(true);
    expect(session.userId).toBe(user.id);
    expect(session.sessionVersion).toBe(user.sessionVersion);
    expect(session.oidcState).toBeUndefined();
    expect(session.oidcVerifier).toBeUndefined();
    // The Plex token stays in the User row, where server discovery reads it
    // (`getStoredPlexToken`); the cookie never carries it.
    expect("plexToken" in session).toBe(false);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.plexToken).toBe("preserved-plex-token");
  });

  it("rejects login with not_linked when no user matches the subject", async () => {
    const user = await createTestUser();
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "unknown-sub" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("not_linked");
    expect(getMockSession().isLoggedIn).toBe(false);
    expect(mockSucceeded).not.toHaveBeenCalled();
  });

  it("rejects login when user matches but ssoEnabled is false", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "sub-x", ssoIssuer: ISSUER, ssoEnabled: false },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "sub-x" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("not_linked");
    expect(getMockSession().isLoggedIn).toBe(false);
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
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "same-sub" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("sso_error")).toBe("not_linked");
    expect(getMockSession().isLoggedIn).toBe(false);
    // The other issuer's link is left as it was.
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchanged.ssoIssuer).toBe("https://other-idp.example.com");
  });

  it("backfills ssoIssuer for legacy rows with null issuer", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: "legacy-sub", ssoIssuer: null, ssoEnabled: true },
    });
    await seedOidcSettings(user.id);
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "legacy-sub" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    expect(getMockSession()).toMatchObject({ isLoggedIn: true, userId: user.id });

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
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
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
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
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
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
    setupSuccessfulExchange({ sub: "s1", name: "Display Name", preferred_username: "not-this-one" });

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
      oidcStartedAt: Date.now(), oidcState: "s",
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
      oidcStartedAt: Date.now(), oidcState: "s",
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

  it("returns a link whose admin and settings were deleted mid-flow to settings with sso_not_configured", async () => {
    const me = await createTestUser();
    await seedOidcSettings(me.id, { ssoEnabled: false });
    setMockSession({
      isLoggedIn: true,
      userId: me.id,
      oidcStartedAt: Date.now(), oidcState: "s",
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
    // Different shape of race from the test above: the admin was deleted and
    // set up again while the link was at the IdP, so the AppSettings row
    // belongs to the new admin row and the session's userId points at the
    // deleted one. The route's settings load + isLinkFlow gate pass, but the
    // final user.update throws P2025. Verify the catch returns
    // session_lost (not a generic 500).
    const admin = await createTestUser();
    await seedOidcSettings(admin.id, { ssoEnabled: false });

    setMockSession({
      isLoggedIn: true,
      userId: "deleted-cuid-not-in-db",
      oidcStartedAt: Date.now(), oidcState: "s",
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
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
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
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
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
    setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v" });
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
      oidcStartedAt: Date.now(), oidcState: "expected",
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
      oidcStartedAt: Date.now(), oidcState: "s",
      oidcVerifier: "v",
      oidcFlow: "link",
    });
    setupSuccessfulExchange({ sub: "s1" });

    const res = await callRoute(GET, {
      method: "GET",
      searchParams: { code: "c", state: "s" },
    });
    // Login flow → root, not /settings: the linked admin signs in, and no
    // link is written (the version a link would bump is untouched).
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(getMockSession()).toMatchObject({ isLoggedIn: true, userId: user.id });
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchanged.sessionVersion).toBe(user.sessionVersion);
  });
  // ── A handshake is good for ten minutes ────────────────────────────────
  //
  // Linking needs a recent sign-in to START. Without an age, an abandoned
  // start stayed in the 30-day cookie and could be FINISHED weeks later by
  // whoever held a copy of it — their account at the IdP became the admin's.
  describe("an old handshake", () => {
    const ELEVEN_MINUTES = 11 * 60 * 1000;

    it("does not complete a link, and links nothing", async () => {
      const user = await createTestUser();
      await seedOidcSettings(user.id, { ssoEnabled: false });
      setMockSession({
        isLoggedIn: true,
        userId: user.id,
        oidcStartedAt: Date.now() - ELEVEN_MINUTES,
        oidcState: "s",
        oidcVerifier: "v",
        oidcFlow: "link",
      });
      setupSuccessfulExchange({ sub: "attacker-sub" });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } });
      const loc = new URL(res.headers.get("location")!);

      expect(loc.pathname).toBe("/settings");
      expect(loc.searchParams.get("ssoLinkError")).toBe("state_mismatch");
      expect(mockExchange).not.toHaveBeenCalled();
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.ssoSubject).toBeNull();
      expect(row.sessionVersion).toBe(user.sessionVersion);
      // Single use either way.
      expect(getMockSession().oidcState).toBeUndefined();
      expect(getMockSession().oidcStartedAt).toBeUndefined();
    });

    it("does not complete a link whose start carries no time at all", async () => {
      const user = await createTestUser();
      await seedOidcSettings(user.id, { ssoEnabled: false });
      // As a cookie sealed before handshakes were timed would hold it.
      setMockSession({ isLoggedIn: true, userId: user.id, oidcFlow: "link", oidcVerifier: "v", oidcState: "s" });
      setupSuccessfulExchange({ sub: "attacker-sub" });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } });

      expect(new URL(res.headers.get("location")!).searchParams.get("ssoLinkError")).toBe("state_mismatch");
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).ssoSubject).toBeNull();
    });

    it("does not sign in", async () => {
      const user = await createTestUser();
      await seedOidcSettings(user.id);
      await prisma.user.update({
        where: { id: user.id },
        data: { ssoEnabled: true, ssoSubject: "user-sub-1", ssoIssuer: ISSUER },
      });
      setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now() - ELEVEN_MINUTES, oidcState: "s", oidcVerifier: "v" });
      setupSuccessfulExchange({ sub: "user-sub-1" });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } });
      const loc = new URL(res.headers.get("location")!);

      expect(loc.pathname).toBe("/login");
      expect(loc.searchParams.get("sso_error")).toBe("state_mismatch");
      expect(getMockSession().isLoggedIn).toBe(false);
      expect(mockSucceeded).not.toHaveBeenCalled();
    });

    it("is not one that claims to start in the future", async () => {
      const user = await createTestUser();
      await seedOidcSettings(user.id);
      setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now() + 60 * 60 * 1000, oidcState: "s", oidcVerifier: "v" });
      setupSuccessfulExchange({ sub: "user-sub-1" });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } });
      expect(new URL(res.headers.get("location")!).searchParams.get("sso_error")).toBe("state_mismatch");
    });
  });

  // ── Re-authentication flow (signed-in admin confirming identity) ──────

  describe("reauth flow", () => {
    async function seedLinked() {
      const user = await createTestUser();
      await seedOidcSettings(user.id);
      await prisma.user.update({
        where: { id: user.id },
        data: { ssoEnabled: true, ssoSubject: "linked-sub", ssoIssuer: ISSUER },
      });
      setMockSession({
        isLoggedIn: true,
        userId: user.id,
        authenticatedAt: 1,
        oidcStartedAt: Date.now(), oidcState: "s",
        oidcVerifier: "v",
        oidcFlow: "reauth",
      });
      return user;
    }

    it("stamps the sign-in time and reports success to the popup page for the linked subject", async () => {
      const user = await seedLinked();
      setupSuccessfulExchange({ sub: "linked-sub" });
      const before = Date.now();

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login/reauth");
      expect(loc.searchParams.get("status")).toBe("ok");

      const session = getMockSession();
      expect(session.userId).toBe(user.id);
      expect(session.isLoggedIn).toBe(true);
      expect(session.authenticatedAt).toBeGreaterThanOrEqual(before);
      expect(session.oidcFlow).toBeUndefined();
      expect(mockSucceeded).toHaveBeenCalledTimes(1);
      // Nothing about the account changes.
      const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
      expect(refreshed?.sessionVersion).toBe(user.sessionVersion);
    });

    // The popup page addresses its report to the attempt named in the state
    // the IdP handed back — never to whatever attempt the session holds now.
    it("hands the attempt nonce from the state to the popup page", async () => {
      const NONCE = "attempt-nonce-0123456789";
      await seedLinked();
      setMockSession({ ...getMockSession(), oidcStartedAt: Date.now(), oidcState: `abc.${NONCE}` });
      setupSuccessfulExchange({ sub: "linked-sub" });

      const ok = new URL(
        (await callRoute(GET, { method: "GET", searchParams: { code: "c", state: `abc.${NONCE}` } })).headers.get("location")!,
      );
      expect(ok.searchParams.get("status")).toBe("ok");
      expect(ok.searchParams.get("nonce")).toBe(NONCE);

      // A stale popup's state names ITS attempt, even though the check fails.
      setMockSession({ ...getMockSession(), oidcStartedAt: Date.now(), oidcState: `new.${NONCE}`, oidcVerifier: "v", oidcFlow: "reauth" });
      const stale = new URL(
        (await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "old.other-attempt-nonce-99" } })).headers.get("location")!,
      );
      expect(stale.searchParams.get("error")).toBe("state_mismatch");
      expect(stale.searchParams.get("nonce")).toBe("other-attempt-nonce-99");
    });

    // `prompt=login` travels through the browser and can be dropped from the
    // URL; a provider with a live session then answers at once. Only the ID
    // token's `auth_time`, which comes straight from the token endpoint, says
    // whether anyone signed in.
    describe("the provider must have signed the user in for this confirmation", () => {
      const withIdToken = (claims: Record<string, unknown> | null) =>
        mockExchange.mockResolvedValue({
          access_token: "at",
          token_type: "Bearer",
          ...(claims && { id_token: idToken(claims) }),
        });
      const attempt = async () =>
        new URL(
          (await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } })).headers.get("location")!,
        );
      const now = () => Math.floor(Date.now() / 1000);

      it("refuses an answer from a session that began before the confirmation did", async () => {
        await seedLinked();
        setupSuccessfulExchange({ sub: "linked-sub" });
        withIdToken({ sub: "linked-sub", auth_time: now() - 3600 });

        const loc = await attempt();

        expect(loc.pathname).toBe("/login/reauth");
        expect(loc.searchParams.get("error")).toBe("not_fresh");
        expect(getMockSession().authenticatedAt).toBe(1);
        expect(mockSucceeded).not.toHaveBeenCalled();
      });

      it.each([
        ["no ID token at all", null],
        ["an ID token without auth_time", { sub: "linked-sub" }],
        ["an auth_time that is not a number", { sub: "linked-sub", auth_time: "now" }],
      ])("refuses %s", async (_label, claims) => {
        await seedLinked();
        setupSuccessfulExchange({ sub: "linked-sub" });
        withIdToken(claims);

        const loc = await attempt();

        expect(loc.searchParams.get("error")).toBe("not_fresh");
        expect(getMockSession().authenticatedAt).toBe(1);
        expect(mockSucceeded).not.toHaveBeenCalled();
      });

      it("accepts a provider that cannot report auth_time only when the operator opted out", async () => {
        vi.stubEnv("OIDC_REAUTH_ALLOW_UNVERIFIED", "true");
        try {
          await seedLinked();
          setupSuccessfulExchange({ sub: "linked-sub" });
          withIdToken(null);
          expect((await attempt()).searchParams.get("status")).toBe("ok");

          // The opt-out covers a missing answer, never a stale one.
          await seedLinked2();
          withIdToken({ sub: "linked-sub", auth_time: now() - 3600 });
          expect((await attempt()).searchParams.get("error")).toBe("not_fresh");
        } finally {
          vi.unstubAllEnvs();
        }
      });

      it("allows for a provider clock a few minutes behind", async () => {
        await seedLinked();
        setupSuccessfulExchange({ sub: "linked-sub" });
        withIdToken({ sub: "linked-sub", auth_time: now() - 120 });
        expect((await attempt()).searchParams.get("status")).toBe("ok");
      });

      it("refuses an ID token issued for someone other than the userinfo subject", async () => {
        await seedLinked();
        setupSuccessfulExchange({ sub: "linked-sub" });
        withIdToken({ sub: "another-sub", auth_time: now() });
        expect((await attempt()).searchParams.get("error")).toBe("not_fresh");
        expect(getMockSession().authenticatedAt).toBe(1);
      });

      /** Re-arm the handshake for a second attempt in one test. */
      async function seedLinked2() {
        setMockSession({
          ...getMockSession(),
          authenticatedAt: 1,
          oidcStartedAt: Date.now(),
          oidcState: "s",
          oidcVerifier: "v",
          oidcFlow: "reauth",
        });
      }
    });

    it("refuses a different subject and leaves the sign-in time alone", async () => {
      await seedLinked();
      setupSuccessfulExchange({ sub: "someone-else" });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login/reauth");
      expect(loc.searchParams.get("error")).toBe("not_linked");
      expect(getMockSession().authenticatedAt).toBe(1);
      expect(mockSucceeded).not.toHaveBeenCalled();
    });

    it("reports a vanished account to the popup page, not the login page", async () => {
      const user = await createTestUser();
      await seedOidcSettings(user.id);
      setMockSession({
        isLoggedIn: true,
        userId: "no-such-user",
        oidcStartedAt: Date.now(), oidcState: "s",
        oidcVerifier: "v",
        oidcFlow: "reauth",
      });
      setupSuccessfulExchange({ sub: "linked-sub" });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login/reauth");
      expect(loc.searchParams.get("error")).toBe("session_lost");
    });

    // `getSession()` reads a revoked session (signed out elsewhere, password
    // changed) as signed out but keeps the handshake fields: without its own
    // branch the confirmation fell through to the login flow, and the page
    // waiting on the popup never heard back.
    it("reports a confirmation whose session was revoked meanwhile, and never signs in", async () => {
      await seedLinked();
      setMockSession({ isLoggedIn: false, oidcStartedAt: Date.now(), oidcState: "s", oidcVerifier: "v", oidcFlow: "reauth" });
      setupSuccessfulExchange({ sub: "linked-sub" });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "s" } });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login/reauth");
      expect(loc.searchParams.get("error")).toBe("session_lost");
      expect(mockExchange).not.toHaveBeenCalled();
      const session = getMockSession();
      expect(session.isLoggedIn).toBe(false);
      expect(session.oidcFlow).toBeUndefined();
      expect(session.oidcState).toBeUndefined();
    });

    // A sign-out in another tab of this browser clears the cookie while the
    // popup is out, handshake fields and all: only the returned state still
    // says this was a confirmation.
    it("reports a confirmation whose cookie was cleared meanwhile, by its state", async () => {
      const NONCE = "attempt-nonce-0123456789";
      await seedLinked();
      setMockSession({ isLoggedIn: false });
      setupSuccessfulExchange({ sub: "linked-sub" });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: `abc.${NONCE}` } });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login/reauth");
      expect(loc.searchParams.get("error")).toBe("session_lost");
      expect(loc.searchParams.get("nonce")).toBe(NONCE);
      expect(mockExchange).not.toHaveBeenCalled();
      expect(getMockSession().isLoggedIn).toBe(false);
    });

    it("reports a confirmation whose handshake is gone from a live session as expired", async () => {
      const NONCE = "attempt-nonce-0123456789";
      const user = await seedLinked();
      setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: 1 });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: `abc.${NONCE}` } });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login/reauth");
      expect(loc.searchParams.get("error")).toBe("state_mismatch");
      expect(loc.searchParams.get("nonce")).toBe(NONCE);
      expect(mockExchange).not.toHaveBeenCalled();
      expect(getMockSession().authenticatedAt).toBe(1);
    });

    // A link started since replaced the confirmation's handshake: the late
    // popup is told, and the link's handshake is left for the link's callback.
    it("leaves another flow's handshake alone when a stale confirmation returns", async () => {
      const NONCE = "attempt-nonce-0123456789";
      const user = await seedLinked();
      setMockSession({
        isLoggedIn: true,
        userId: user.id,
        authenticatedAt: 1,
        oidcStartedAt: Date.now(), oidcState: "link-state",
        oidcVerifier: "link-verifier",
        oidcFlow: "link",
      });

      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: `abc.${NONCE}` } });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login/reauth");
      expect(loc.searchParams.get("error")).toBe("state_mismatch");
      const session = getMockSession();
      expect(session.oidcFlow).toBe("link");
      expect(session.oidcState).toBe("link-state");
      expect(session.oidcVerifier).toBe("link-verifier");
    });

    it("returns failures to the popup page, not the login page", async () => {
      await seedLinked();
      const res = await callRoute(GET, { method: "GET", searchParams: { code: "c", state: "wrong" } });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login/reauth");
      expect(loc.searchParams.get("error")).toBe("state_mismatch");
      expect(getMockSession().authenticatedAt).toBe(1);
    });
  });
});
