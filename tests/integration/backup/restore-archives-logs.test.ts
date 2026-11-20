/**
 * A restore replaces the log table with the backup's rows (none, for a
 * config-only backup), so what the instance had logged up to that point — who
 * signed in, what was changed, the "Restoring from backup" line itself — is
 * written to the log archive first.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { gunzipSync } from "zlib";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestLogEntry } from "../../setup/test-helpers";

// Both directories are read once, at module load, so they are set before the
// services are imported dynamically below.
const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-restore-logs-backup-"));
const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-restore-logs-archive-"));
process.env.BACKUP_DIR = backupDir;
process.env.LOG_ARCHIVE_DIR = archiveDir;

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
const mockLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger, apiLogger: mockLogger, dbLogger: mockLogger }));

const { createBackup, restoreBackup } = await import("@/lib/backup/backup-service");

const prisma = getTestPrisma();

describe("restore keeps the log entries it replaces", () => {
  beforeEach(async () => {
    await cleanDatabase();
    for (const file of await fs.readdir(archiveDir)) await fs.rm(path.join(archiveDir, file));
    mockLogger.info.mockClear();
  });
  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.rm(archiveDir, { recursive: true, force: true });
  });

  it("archives the current log rows before truncating, and says where", async () => {
    await prisma.user.create({ data: { username: "admin" } });
    const filename = await createBackup(undefined, true);
    await createTestLogEntry({ level: "WARN", source: "Auth", message: "Failed sign-in (password): wrong password" });
    await createTestLogEntry({ source: "Audit", message: "Discord notification settings changed" });

    await restoreBackup(filename);

    // The config-only backup held no log rows: the table is empty now.
    expect(await prisma.logEntry.count()).toBe(0);
    const files = await fs.readdir(archiveDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^logs-\d{4}-\d{2}-\d{2}-pre-restore-\d+\.tar\.gz$/);
    const stat = await fs.stat(path.join(archiveDir, files[0]));
    expect(stat.mode & 0o777).toBe(0o600);
    const tar = gunzipSync(await fs.readFile(path.join(archiveDir, files[0]))).toString("utf-8");
    expect(tar).toContain("Failed sign-in (password): wrong password");
    expect(tar).toContain("Discord notification settings changed");
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Backup",
      `Restore completed from ${filename} — the log entries from before it are in the log archive as ${files[0]}`,
    );
  });

  it("writes no archive when there is nothing logged", async () => {
    await prisma.user.create({ data: { username: "admin" } });
    const filename = await createBackup(undefined, true);

    await restoreBackup(filename);

    expect(await fs.readdir(archiveDir)).toEqual([]);
    expect(mockLogger.info).toHaveBeenCalledWith("Backup", `Restore completed from ${filename}`);
  });
});
