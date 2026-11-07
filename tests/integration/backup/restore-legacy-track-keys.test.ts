/**
 * A restore re-keys the tracks a backup from before the album joined the
 * track key brings back.
 *
 * Startup re-keys a legacy `music:` key (`runBackfillIfNeeded`), but a restore
 * runs long after startup: a full backup taken before the change put the old
 * keys back, and nothing re-keyed them until the next restart — so a song's
 * studio and compilation versions shared one dedup group again, and listings
 * showed one of them. The real backup and restore against the real database.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-backup-"));
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
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));

const { createBackup, restoreBackup } = await import("@/lib/backup/backup-service");
const { invalidateMediaCaches } = await import("@/lib/cache/invalidate");

const prisma = getTestPrisma();
const LEGACY_KEY = "music:queen:bohemian rhapsody";

/**
 * Two versions of one song, as the version before the album joined the key
 * stored them: one group, with the compilation hidden behind the studio cut.
 */
async function seedLegacyTracks() {
  const user = await createTestUser();
  const library = await createTestLibrary((await createTestServer(user.id)).id, { type: "MUSIC" });
  const track = async (ratingKey: string, albumTitle: string, canonical: boolean, offsetMs: number) => {
    const row = await createTestMediaItem(library.id, {
      ratingKey, type: "MUSIC", title: "Bohemian Rhapsody", parentTitle: "Queen", albumTitle,
    });
    return prisma.mediaItem.update({
      where: { id: row.id },
      data: { dedupKey: LEGACY_KEY, dedupCanonical: canonical, createdAt: new Date(Date.now() + offsetMs) },
    });
  };
  const studio = await track("a1", "A Night at the Opera", true, 0);
  const compilation = await track("a2", "Greatest Hits", false, 1_000);
  return { studio, compilation };
}

const read = (id: string) =>
  prisma.mediaItem.findUniqueOrThrow({ where: { id }, select: { dedupKey: true, dedupCanonical: true } });

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
  await fs.rm(backupDir, { recursive: true, force: true });
});

describe("restoring a full backup with track keys that predate the album", () => {
  it("re-keys the restored tracks and recomputes their canonical copies", async () => {
    const { studio, compilation } = await seedLegacyTracks();
    const filename = await createBackup(undefined, false);
    // Startup re-keyed the live rows long ago; the restore brings the file's back.
    await prisma.mediaItem.updateMany({ data: { dedupKey: "track:already:re:keyed" } });

    await restoreBackup(filename);

    expect(await read(studio.id)).toEqual({
      dedupKey: "track:queen:a night at the opera:bohemian rhapsody",
      dedupCanonical: true,
    });
    // Its own track again, and shown.
    expect(await read(compilation.id)).toEqual({
      dedupKey: "track:queen:greatest hits:bohemian rhapsody",
      dedupCanonical: true,
    });
    expect(await prisma.mediaItem.count({ where: { dedupKey: { startsWith: "music:" } } })).toBe(0);
    expect(invalidateMediaCaches).toHaveBeenCalled();
  });

  it("restores a file whose keys are current without rewriting them", async () => {
    const { studio } = await seedLegacyTracks();
    await prisma.mediaItem.update({
      where: { id: studio.id },
      data: { dedupKey: "track:queen:a night at the opera:bohemian rhapsody" },
    });
    await prisma.mediaItem.updateMany({
      where: { dedupKey: LEGACY_KEY },
      data: { dedupKey: "track:queen:greatest hits:bohemian rhapsody" },
    });
    const filename = await createBackup(undefined, false);

    await restoreBackup(filename);

    expect(invalidateMediaCaches).not.toHaveBeenCalled();
    expect((await read(studio.id)).dedupKey).toBe("track:queen:a night at the opera:bohemian rhapsody");
  });
});
