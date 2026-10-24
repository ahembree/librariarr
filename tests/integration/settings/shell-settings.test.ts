import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { createTestUser, createTestServer, createTestLibrary } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import AFTER mocks
import { getRequestSession, loadShellSettings } from "@/lib/settings/shell-settings";

const prisma = getTestPrisma();

describe("loadShellSettings", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.2.0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns null for a user that does not exist", async () => {
    expect(await loadShellSettings("missing-user")).toBeNull();
  });

  it("reads the defaults for a user with no settings row", async () => {
    const user = await createTestUser({ username: "admin" });
    expect(await loadShellSettings(user.id)).toEqual({
      accentColor: "default",
      user: { username: "admin", authMethod: "Plex" },
      chipColors: null,
      columnPreferences: null,
      columnPreferencesRevision: 0,
      cardDisplayPreferences: null,
      dashboardLayout: null,
      dashboardLayoutRevision: 0,
      // No version seen yet: the running one's notes are owed once.
      whatsNewDue: true,
      libraryTypes: { types: [], allTypes: [] },
      maintenanceActive: false,
    });
  });

  it("reads every saved display setting", async () => {
    const user = await createTestUser({ plexId: null, username: "local-admin" });
    const chipColors = { resolution: { "4K": "#ff0000" } };
    const columnPreferences = { MOVIE: ["title", "year"] };
    const cardDisplayPreferences = { MOVIE: { badges: { resolution: false }, metadata: {}, servers: true } };
    const dashboardLayout = { main: [{ id: "stats" }] };
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        accentColor: "violet",
        chipColors,
        columnPreferences,
        cardDisplayPreferences,
        dashboardLayout,
        dashboardLayoutRevision: 6,
        columnPreferencesRevision: 2,
        lastSeenVersion: "1.2.0",
      },
    });

    expect(await loadShellSettings(user.id)).toEqual({
      accentColor: "violet",
      user: { username: "local-admin", authMethod: "Local" },
      chipColors,
      columnPreferences,
      columnPreferencesRevision: 2,
      cardDisplayPreferences,
      dashboardLayout,
      dashboardLayoutRevision: 6,
      whatsNewDue: false,
      libraryTypes: { types: [], allTypes: [] },
      maintenanceActive: false,
    });
  });

  it("owes the What's new dialog only when the running version is newer than the last seen", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({ data: { userId: user.id, lastSeenVersion: "1.1.0" } });
    expect((await loadShellSettings(user.id))?.whatsNewDue).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "unknown");
    expect((await loadShellSettings(user.id))?.whatsNewDue).toBe(false);
  });

  it("reads the library types and whether maintenance mode is on", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { type: "MOVIE", key: "1" });
    await createTestLibrary(server.id, { type: "MUSIC", key: "2", enabled: false });
    const off = await createTestServer(user.id, { name: "Off" });
    await prisma.mediaServer.update({ where: { id: off.id }, data: { enabled: false } });
    await createTestLibrary(off.id, { type: "SERIES", key: "3" });
    await prisma.appSettings.create({ data: { userId: user.id, maintenanceMode: true } });

    const settings = await loadShellSettings(user.id);
    expect(settings?.libraryTypes).toEqual({ types: ["MOVIE"], allTypes: expect.arrayContaining(["MOVIE", "MUSIC"]) });
    expect(settings?.libraryTypes.allTypes).toHaveLength(2);
    expect(settings?.maintenanceActive).toBe(true);
  });

  it("names the linked SSO provider as the sign-in method", async () => {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { ssoEnabled: true, ssoProvider: "Authentik" } });
    expect((await loadShellSettings(user.id))?.user).toEqual({ username: "testuser", authMethod: "Authentik" });
  });

  it("never returns a credential from the settings row", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, oidcClientSecret: "oidc-secret", aiApiKey: "ai-key", backupEncryptionPassword: "backup-passphrase" },
    });
    const body = JSON.stringify(await loadShellSettings(user.id));
    expect(body).not.toContain("oidc-secret");
    expect(body).not.toContain("ai-key");
    expect(body).not.toContain("backup-passphrase");
    expect(body).not.toContain("test-plex-token");
  });
});

describe("getRequestSession", () => {
  it("returns the request's session", async () => {
    setMockSession({ isLoggedIn: true, userId: "user-1" });
    const session = await getRequestSession();
    expect(session.isLoggedIn).toBe(true);
    expect(session.userId).toBe("user-1");
  });
});
