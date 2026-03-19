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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ hasPassword: boolean }>(res);
    expect(body.hasPassword).toBe(true);
  });

  it("returns hasPassword false when no AppSettings exists", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

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
      body: { backupEncryptionPassword: "newpassword1" },
    });
    await expectJson(res, 401);
  });

  it("sets encryption password", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupEncryptionPassword: "newpassword1" },
    });
    const body = await expectJson<{ hasPassword: boolean }>(res);
    expect(body.hasPassword).toBe(true);

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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

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
});
