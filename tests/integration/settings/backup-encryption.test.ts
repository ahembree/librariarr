import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

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
import { GET, PUT } from "@/app/api/settings/backup-encryption-password/route";

const prisma = getTestPrisma();

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/settings/backup-encryption-password
// ---------------------------------------------------------------------------
describe("GET /api/settings/backup-encryption-password", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns hasPassword true when encryption password is set", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, backupEncryptionPassword: "mysecretpassword" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ hasPassword: boolean }>(res);
    // Whether one is set, never the password itself.
    expect(body).toEqual({ hasPassword: true });
  });

  it("returns hasPassword false when no AppSettings exists", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ hasPassword: boolean }>(res);
    expect(body.hasPassword).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/backup-encryption-password
// ---------------------------------------------------------------------------
describe("PUT /api/settings/backup-encryption-password", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      // file deepcode ignore NoHardcodedPasswords/test: test file
      body: { backupEncryptionPassword: "newpassword1" },
    });
    await expectJson(res, 401);
  });

  it("sets encryption password", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupEncryptionPassword: "newpassword1" },
    });
    const body = await expectJson<{ hasPassword: boolean }>(res);
    expect(body).toEqual({ hasPassword: true });

    // Verify persisted
    const settings = await prisma.appSettings.findUnique({
      where: { userId: user.id },
    });
    expect(settings?.backupEncryptionPassword).toBe("newpassword1");
  });

  it("clears encryption password with null", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, backupEncryptionPassword: "existingpass" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupEncryptionPassword: null },
    });
    const body = await expectJson<{ hasPassword: boolean }>(res);
    expect(body.hasPassword).toBe(false);

    // Verify persisted
    const settings = await prisma.appSettings.findUnique({
      where: { userId: user.id },
    });
    expect(settings?.backupEncryptionPassword).toBeNull();
  });

  it("returns 400 for a password shorter than 8 characters, keeping the saved one", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, backupEncryptionPassword: "existingpass" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupEncryptionPassword: "short" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["backupEncryptionPassword: Password must be at least 8 characters"]);
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.backupEncryptionPassword).toBe("existingpass");
  });

  // This route chooses the passphrase of every scheduled backup: a stale
  // cookie could clear it (the next backup is written in plaintext) or set
  // its own (which opens any copy it later obtains).
  it("returns 403 reauth_required for a sign-in older than 15 minutes, changing nothing", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, backupEncryptionPassword: "existingpass" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 16 * 60 * 1000 });

    for (const backupEncryptionPassword of [null, "attackerpass1"]) {
      const res = await callRoute(PUT, { method: "PUT", body: { backupEncryptionPassword } });
      const body = await expectJson<{ code: string }>(res, 403);
      expect(body.code).toBe("reauth_required");
    }

    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.backupEncryptionPassword).toBe("existingpass");
  });

  it("refuses a session that carries no sign-in time at all", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const res = await callRoute(PUT, { method: "PUT", body: { backupEncryptionPassword: "newpassword1" } });
    await expectJson(res, 403);
    expect(await prisma.appSettings.findUnique({ where: { userId: user.id } })).toBeNull();
  });

  it("records the change, and that removing it leaves backups unencrypted — never the password", async () => {
    const { apiLogger } = await import("@/lib/logger");
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });

    await callRoute(PUT, { method: "PUT", body: { backupEncryptionPassword: "newpassword1" } });
    await callRoute(PUT, { method: "PUT", body: { backupEncryptionPassword: null } });

    expect(vi.mocked(apiLogger.info).mock.calls).toEqual([
      ["Audit", "Backup encryption password set", { address: "unknown" }],
      [
        "Audit",
        "Backup encryption password removed — scheduled backups are no longer encrypted",
        { address: "unknown" },
      ],
    ]);
    expect(JSON.stringify(vi.mocked(apiLogger.info).mock.calls)).not.toContain("newpassword1");
  });
});
