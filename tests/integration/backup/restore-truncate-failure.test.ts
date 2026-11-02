/**
 * A TRUNCATE that fails fails the restore, with its own error.
 *
 * Restore clears every table inside one interactive transaction. It used to
 * swallow a failed TRUNCATE and carry on, but in Postgres a failed statement
 * aborts the transaction: every later statement then fails with "current
 * transaction is aborted", so the restore reported a later table — or, with
 * nothing to insert, committed an aborted transaction as a success — and the
 * real cause was lost. Here a test trigger refuses the TRUNCATE of one table.
 *
 * Real createBackup → restoreBackup against the test database.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser } from "../../setup/test-helpers";

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-restore-truncate-"));
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

async function dropTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS restore_test_refuse_truncate ON "SavedQuery"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS restore_test_refuse_truncate()`);
}

beforeEach(async () => {
  await dropTrigger();
  await cleanDatabase();
});

// Dropped before anything else truncates: the trigger would refuse the
// cleanup too.
afterEach(async () => {
  await dropTrigger();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
  await fs.rm(backupDir, { recursive: true, force: true });
});

describe("restore when a TRUNCATE fails", () => {
  it("fails naming the table and the database's reason, and leaves the data as it was", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({ data: { userId: user.id } });
    const filename = await createBackup(undefined, true);

    // State the restore would wipe: the first table it clears, and the user.
    await prisma.logEntry.create({ data: { level: "INFO", source: "test", message: "kept" } });
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION restore_test_refuse_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'truncate refused by test trigger'; END $$`,
    );
    // SavedQuery is cleared second (after LogEntry), so the restore has
    // already run one TRUNCATE in the transaction when this one fails.
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER restore_test_refuse_truncate BEFORE TRUNCATE ON "SavedQuery"
       FOR EACH STATEMENT EXECUTE FUNCTION restore_test_refuse_truncate()`,
    );

    const failure = await restoreBackup(filename).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^Failed to clear table savedQuery: [\s\S]*truncate refused by test trigger/);
    expect((failure as Error).message).not.toMatch(/current transaction is aborted/);

    // Rolled back whole: the TRUNCATE that ran before it is undone too.
    expect(await prisma.logEntry.count()).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect(await prisma.appSettings.count()).toBe(1);
  });
});
