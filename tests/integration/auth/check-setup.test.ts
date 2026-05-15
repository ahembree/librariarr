import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

// Import route handler AFTER mocks
import { GET } from "@/app/api/auth/check-setup/route";

describe("GET /api/auth/check-setup", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns setupRequired true when no users exist", async () => {
    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(true);
  });

  it("returns setupRequired false when a user exists", async () => {
    await createTestUser();

    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(false);
  });

  it("returns localAuthEnabled true when AppSettings has it enabled", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, localAuthEnabled: true },
    });

    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(false);
    expect(body.localAuthEnabled).toBe(true);
  });

  it("returns localAuthEnabled false when no AppSettings exist", async () => {
    // User exists but no AppSettings row
    await createTestUser();

    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(false);
    expect(body.localAuthEnabled).toBe(false);
  });

  it("returns localAuthEnabled false when no users exist (skips AppSettings query)", async () => {
    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(true);
    // localAuthEnabled defaults to false when setupRequired is true
    expect(body.localAuthEnabled).toBe(false);
  });
});

// The login page consumes the SSO/Plex toggle state from this endpoint to
// decide which methods to render. Bugs here strand users at a login screen
// missing the buttons that would actually let them in, so the full toggle
// matrix needs explicit coverage.
type CheckSetupBody = {
  setupRequired: boolean;
  localAuthEnabled: boolean;
  plexLoginEnabled: boolean;
  ssoEnabled: boolean;
  ssoMode: "OIDC" | "FORWARD_AUTH";
};

describe("GET /api/auth/check-setup — SSO and Plex toggles", () => {
  const originalOverride = process.env.SSO_DISABLE_OVERRIDE;

  beforeEach(async () => {
    await cleanDatabase();
    delete process.env.SSO_DISABLE_OVERRIDE;
  });

  afterAll(async () => {
    if (originalOverride === undefined) {
      delete process.env.SSO_DISABLE_OVERRIDE;
    } else {
      process.env.SSO_DISABLE_OVERRIDE = originalOverride;
    }
    await disconnectTestDb();
  });

  it("hides Plex login when the admin has no plexId linked", async () => {
    // User exists but plexId is null (local-first setup). Even if the
    // plexLoginEnabled toggle is on in DB, the button should stay hidden
    // because clicking it would immediately fail with "not linked."
    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: { username: "alice", localUsername: "alice", passwordHash: "h" },
    });
    await prisma.appSettings.create({
      data: { userId: user.id, plexLoginEnabled: true, localAuthEnabled: true },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    expect(body.plexLoginEnabled).toBe(false);
    expect(body.localAuthEnabled).toBe(true);
  });

  it("shows Plex login when both plexId is set and the toggle is on", async () => {
    await createTestUser();
    const prisma = getTestPrisma();
    const settings = await prisma.appSettings.findFirst();
    if (settings) {
      await prisma.appSettings.update({
        where: { id: settings.id },
        data: { plexLoginEnabled: true },
      });
    } else {
      const u = await prisma.user.findFirst();
      await prisma.appSettings.create({
        data: { userId: u!.id, plexLoginEnabled: true },
      });
    }

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    expect(body.plexLoginEnabled).toBe(true);
  });

  it("hides Plex login when admin has plexId but disabled the toggle", async () => {
    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: { username: "alice", plexId: "p1", plexToken: "t" },
    });
    await prisma.appSettings.create({
      data: { userId: user.id, plexLoginEnabled: false },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    expect(body.plexLoginEnabled).toBe(false);
  });

  it("forces localAuthEnabled false when SSO is usable (SSO replaces local form)", async () => {
    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: {
        username: "alice",
        localUsername: "alice",
        passwordHash: "h",
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        localAuthEnabled: true,
        ssoEnabled: true,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client-1",
      },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    expect(body.ssoEnabled).toBe(true);
    expect(body.ssoMode).toBe("OIDC");
    expect(body.localAuthEnabled).toBe(false);
  });

  it("does NOT force localAuthEnabled false when ssoEnabled is true but config is incomplete", async () => {
    // ssoEnabled=true but no oidcIssuer/oidcClientId → isSsoUsable=false →
    // SSO doesn't actually replace local. The form should stay visible if
    // the admin enabled it in DB.
    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: { username: "alice", localUsername: "alice", passwordHash: "h" },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        localAuthEnabled: true,
        ssoEnabled: true,
        ssoMode: "OIDC",
        // oidcIssuer and oidcClientId left null
      },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    expect(body.ssoEnabled).toBe(false);
    expect(body.localAuthEnabled).toBe(true);
  });

  it("with SSO_DISABLE_OVERRIDE active: forces SSO off and re-surfaces local form when passwordHash exists", async () => {
    process.env.SSO_DISABLE_OVERRIDE = "true";

    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: {
        username: "alice",
        localUsername: "alice",
        passwordHash: "h",
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        localAuthEnabled: false, // admin had disabled it because SSO was hiding the form
        ssoEnabled: true,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client-1",
      },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    expect(body.ssoEnabled).toBe(false);
    // Even though localAuthEnabled is false in DB, the override re-surfaces
    // the form because the user has a passwordHash.
    expect(body.localAuthEnabled).toBe(true);
  });

  it("with SSO_DISABLE_OVERRIDE active: keeps local form hidden when no passwordHash", async () => {
    process.env.SSO_DISABLE_OVERRIDE = "true";

    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: {
        username: "alice",
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        localAuthEnabled: false,
        ssoEnabled: true,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client-1",
      },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    // Override can only re-surface credentials that exist. No passwordHash
    // means no way to log in via local form → form stays hidden.
    expect(body.localAuthEnabled).toBe(false);
  });

  it("with SSO_DISABLE_OVERRIDE active: re-surfaces Plex button when plexId is linked", async () => {
    process.env.SSO_DISABLE_OVERRIDE = "true";

    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: {
        username: "alice",
        plexId: "p1",
        plexToken: "t",
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        // Admin disabled the Plex login toggle (e.g. for SSO-only login)
        plexLoginEnabled: false,
      },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    // Override re-surfaces it because plexId is set.
    expect(body.plexLoginEnabled).toBe(true);
  });

  it("with SSO_DISABLE_OVERRIDE active: keeps Plex button hidden when no plexId", async () => {
    process.env.SSO_DISABLE_OVERRIDE = "true";

    await createTestUser({ username: "alice" });
    const prisma = getTestPrisma();
    const u = await prisma.user.findFirst();
    await prisma.user.update({
      where: { id: u!.id },
      data: { plexId: null, plexToken: null },
    });
    await prisma.appSettings.create({
      data: { userId: u!.id, plexLoginEnabled: true },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    expect(body.plexLoginEnabled).toBe(false);
  });

  it("SSO_DISABLE_OVERRIDE doesn't activate when env var is set to a falsy value", async () => {
    process.env.SSO_DISABLE_OVERRIDE = "false";

    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: {
        username: "alice",
        ssoSubject: "abc",
        ssoIssuer: "https://idp.example.com",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoEnabled: true,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client-1",
      },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    // Override NOT active — SSO is usable and hiding local form.
    expect(body.ssoEnabled).toBe(true);
  });

  it("returns ssoMode 'FORWARD_AUTH' when configured for forward-auth mode", async () => {
    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: {
        username: "alice",
        ssoSubject: "alice",
        ssoIssuer: "forward-auth",
        ssoEnabled: true,
      },
    });
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        ssoEnabled: true,
        ssoMode: "FORWARD_AUTH",
        forwardAuthUserHeader: "Remote-User",
      },
    });

    const body = await expectJson<CheckSetupBody>(
      await callRoute(GET, { url: "/api/auth/check-setup" })
    );
    expect(body.ssoEnabled).toBe(true);
    expect(body.ssoMode).toBe("FORWARD_AUTH");
  });
});
