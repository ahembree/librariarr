/**
 * Collections and TRaSH assignments through a real backup → restore round trip.
 *
 * Neither table was in the backup's TABLE_ORDER. Restore truncates `User` with
 * CASCADE, so both were destroyed by every restore and never refilled — and
 * because `RuleSet.collectionId` references `Collection`, inserting the backed-
 * up rule sets then hit the foreign key, failing (and rolling back) the whole
 * restore whenever any rule set was assigned to a Plex collection.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { gzipSync } from "zlib";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestCollection,
  createTestRuleSet,
  createTestSonarrInstance,
  createTestUser,
} from "../../setup/test-helpers";

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-collections-backup-"));
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

describe("backup restore — collections and TRaSH assignments", () => {
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.collection.deleteMany();
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.collection.deleteMany();
    await disconnectTestDb();
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it("restores a rule set with its collection, and TRaSH assignments", async () => {
    const user = await createTestUser();
    const collection = await createTestCollection(user.id, { name: "Leaving soon" });
    const ruleSet = await createTestRuleSet(user.id, { name: "Old movies" });
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { collectionId: collection.id } });
    const sonarr = await createTestSonarrInstance(user.id);
    await prisma.trashManagedResource.create({
      data: {
        userId: user.id,
        serviceType: "SONARR",
        sonarrInstanceId: sonarr.id,
        resourceType: "CUSTOM_FORMAT",
        trashId: "abc123",
        name: "x265 (HD)",
      },
    });

    const filename = await createBackup(undefined, true);
    await restoreBackup(filename);

    const restoredRuleSet = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } });
    expect(restoredRuleSet.collectionId).toBe(collection.id);
    const restoredCollection = await prisma.collection.findUniqueOrThrow({ where: { id: collection.id } });
    expect(restoredCollection.name).toBe("Leaving soon");
    const managed = await prisma.trashManagedResource.findMany();
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({ trashId: "abc123", sonarrInstanceId: sonarr.id });
  });

  it("still restores an older backup that has no collection table, detaching the rule set", async () => {
    const user = await createTestUser();
    const collection = await createTestCollection(user.id, { name: "Gone" });
    const ruleSet = await createTestRuleSet(user.id, { name: "Kept rules" });
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { collectionId: collection.id } });

    // Take a real backup, then strip the tables older versions never wrote.
    const filename = await createBackup(undefined, true);
    const filepath = path.join(backupDir, filename);
    const { gunzipSync } = await import("zlib");
    const backup = JSON.parse(gunzipSync(await fs.readFile(filepath)).toString("utf-8")) as {
      metadata: unknown;
      data: Record<string, unknown>;
    };
    delete backup.data.collection;
    delete backup.data.trashManagedResource;
    const legacyName = filename.replace(".json.gz", "-legacy.json.gz");
    await fs.writeFile(path.join(backupDir, legacyName), gzipSync(Buffer.from(JSON.stringify(backup))));

    await restoreBackup(legacyName);

    const restored = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } });
    expect(restored.name).toBe("Kept rules");
    expect(restored.collectionId).toBeNull();
    expect(await prisma.collection.count()).toBe(0);
  });
});
