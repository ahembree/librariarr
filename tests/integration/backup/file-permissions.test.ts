/**
 * A backup file holds every integration's API key and the Plex token
 * (encrypted only when a passphrase is set), so it is written owner-only
 * rather than with whatever the container's umask allows.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { createTestUser } from "../../setup/test-helpers";

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-backup-mode-"));
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

const { createBackup } = await import("@/lib/backup/backup-service");

describe("backup file permissions", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it.each([
    ["an unencrypted", undefined],
    ["an encrypted", "correct horse battery"],
  ])("writes %s backup readable by its owner only", async (_label, passphrase) => {
    await createTestUser();
    const previous = process.umask(0o022);
    try {
      const filename = await createBackup(passphrase, true);
      const { mode } = await fs.stat(path.join(backupDir, filename));
      expect(mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });
});
