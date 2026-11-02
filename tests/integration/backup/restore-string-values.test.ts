/**
 * Restore types a value by its field, never by its shape.
 *
 * A backup stores a Date as the ISO string JSON.stringify writes. Restore used
 * to turn every string that looked like a timestamp back into a Date, so a
 * String column whose whole value was one — a title, a rule set name — came
 * back as a Date, Prisma refused the batch ("Expected String, provided
 * DateTime") and the backup could not be restored at all. It now passes the
 * string on and lets Prisma's DateTime input read it, for DateTime fields only.
 *
 * Real createBackup → restoreBackup against the test database.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestServer,
  createTestUser,
} from "../../setup/test-helpers";

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-restore-strings-"));
process.env.BACKUP_DIR = backupDir;

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createBackup, restoreBackup } = await import("@/lib/backup/backup-service");
const prisma = getTestPrisma();

const TIMESTAMP = "2024-01-01T00:00:00Z";

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
  await fs.rm(backupDir, { recursive: true, force: true });
});

describe("restore of string values", () => {
  it("keeps a String column whose whole value is a timestamp, and restores DateTime fields as dates", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({ data: { userId: user.id } });
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    const addedAt = new Date("2023-05-06T07:08:09.123Z");
    const item = await createTestMediaItem(library.id, { title: TIMESTAMP, addedAt });
    const ruleSet = await createTestRuleSet(user.id, { name: TIMESTAMP });

    const filename = await createBackup(undefined, false);
    await restoreBackup(filename);

    const restoredItem = await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(restoredItem.title).toBe(TIMESTAMP);
    expect(restoredItem.addedAt).toEqual(addedAt);
    const restoredRuleSet = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } });
    expect(restoredRuleSet.name).toBe(TIMESTAMP);
    expect(restoredRuleSet.createdAt).toEqual(ruleSet.createdAt);
  });
});
