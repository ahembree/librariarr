/**
 * API keys and backups, through the real backup service.
 *
 * `ApiKey` is deliberately missing from the backup's `TABLE_ORDER`. Restore
 * truncates `User` with CASCADE, so a restore wipes every key — which is the
 * point: restoring the set a backup captured would bring back any key deleted
 * since, silently undoing a revocation. And a backup file (often kept
 * unencrypted, off the box) never carries key material, not even the hashes.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { gunzipSync } from "zlib";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestApiKey, createTestUser } from "../../setup/test-helpers";

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-apikey-backup-"));
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

describe("API keys are never backed up", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it.each([
    ["config-only", true],
    ["full", false],
  ])("a %s backup holds no key material", async (_label, configOnly) => {
    const user = await createTestUser();
    const { key, row } = await createTestApiKey(user.id, { name: "Dashboard" });

    const filename = await createBackup(undefined, configOnly);
    const raw = gunzipSync(await fs.readFile(path.join(backupDir, filename))).toString("utf-8");
    const backup = JSON.parse(raw) as { data: Record<string, unknown> };

    expect(backup.data).not.toHaveProperty("apiKey");
    expect(raw).not.toContain(row.keyHash);
    expect(raw).not.toContain(key);
    expect(raw).not.toContain("Dashboard");
  });

  it("a restore revokes every key, including ones created before the backup", async () => {
    const user = await createTestUser();
    await createTestApiKey(user.id, { name: "before backup" });
    const filename = await createBackup(undefined, true);
    await createTestApiKey(user.id, { name: "after backup" });
    expect(await prisma.apiKey.count()).toBe(2);

    await restoreBackup(filename);

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.apiKey.count()).toBe(0);
  });
});
