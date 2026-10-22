/**
 * A restore keeps the "What's new" dialog closed for releases already seen.
 *
 * The file holds `AppSettings.lastSeenVersion` as it was when the backup was
 * taken — null in every backup from before the column — so restoring it
 * verbatim reopened the dialog for releases the admin had already read.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-restore-seen-"));
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

import { createBackup, restoreBackup } from "@/lib/backup/backup-service";

const prisma = getTestPrisma();

async function seed(lastSeenVersion: string | null) {
  const user = await prisma.user.create({ data: { username: "admin" } });
  await prisma.appSettings.create({ data: { userId: user.id, lastSeenVersion } });
  return user;
}

async function storedVersion() {
  return (await prisma.appSettings.findFirstOrThrow()).lastSeenVersion;
}

describe("restore vs the release notes already seen", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it("keeps the newer version seen since an older backup was taken", async () => {
    await seed("1.2.0");
    const filename = await createBackup(undefined, true);
    await prisma.appSettings.updateMany({ data: { lastSeenVersion: "1.4.0" } });

    await restoreBackup(filename);
    expect(await storedVersion()).toBe("1.4.0");
  });

  it("keeps the version seen when the backup predates the column", async () => {
    await seed(null);
    const filename = await createBackup(undefined, true);
    await prisma.appSettings.updateMany({ data: { lastSeenVersion: "1.4.0" } });

    await restoreBackup(filename);
    expect(await storedVersion()).toBe("1.4.0");
  });

  it("takes the file's version when it is the newer one", async () => {
    await seed("1.4.0");
    const filename = await createBackup(undefined, true);
    await prisma.appSettings.updateMany({ data: { lastSeenVersion: "1.2.0" } });

    await restoreBackup(filename);
    expect(await storedVersion()).toBe("1.4.0");
  });
});
