/**
 * A restore of a full backup taken before Plex's per-provider ratings existed
 * queues its Plex movies and episodes for the next full sync to read again.
 *
 * Their rows come back with the ratings empty and their old `serverUpdatedAt`,
 * which a full sync reads as "unchanged" and never fetches — on a fresh
 * install the upgrade's migration had no rows to clear, so the ratings stayed
 * empty for good. The real backup and restore against the real database.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { gunzipSync, gzipSync } from "zlib";
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

const prisma = getTestPrisma();
const READ = new Date("2025-06-01T00:00:00.000Z");
const PROVIDER_COLUMNS = ["imdbRating", "tmdbRating", "rtCriticRating", "rtAudienceRating"];

async function seed() {
  const user = await createTestUser();
  const plex = await createTestServer(user.id, { type: "PLEX" });
  const jelly = await createTestServer(user.id, { type: "JELLYFIN" });
  const stored = async (libraryId: string, type: "MOVIE" | "MUSIC") => {
    const row = await createTestMediaItem(libraryId, { type });
    return prisma.mediaItem.update({ where: { id: row.id }, data: { serverUpdatedAt: READ } });
  };
  const plexMovie = await stored((await createTestLibrary(plex.id, { type: "MOVIE" })).id, "MOVIE");
  const plexTrack = await stored((await createTestLibrary(plex.id, { type: "MUSIC" })).id, "MUSIC");
  const jellyMovie = await stored((await createTestLibrary(jelly.id, { type: "MOVIE" })).id, "MOVIE");
  return { plexMovie, plexTrack, jellyMovie };
}

/** Rewrites a backup file as the version before the ratings wrote it: no rating columns. */
async function stripRatingColumns(filename: string) {
  const file = path.join(backupDir, filename);
  const backup = JSON.parse(gunzipSync(await fs.readFile(file)).toString("utf-8"));
  for (const row of backup.data.mediaItem) for (const column of PROVIDER_COLUMNS) delete row[column];
  await fs.writeFile(file, gzipSync(Buffer.from(JSON.stringify(backup), "utf-8")));
}

const stamp = async (row: { id: string }) =>
  (await prisma.mediaItem.findUniqueOrThrow({ where: { id: row.id } })).serverUpdatedAt;

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
  await fs.rm(backupDir, { recursive: true, force: true });
});

describe("restoring a full backup taken before the per-provider ratings", () => {
  it("queues the restored Plex movies for the next full sync, and nothing else", async () => {
    const { plexMovie, plexTrack, jellyMovie } = await seed();
    const filename = await createBackup(undefined, false);
    await stripRatingColumns(filename);

    await restoreBackup(filename);

    expect(await stamp(plexMovie)).toBeNull();
    expect(await stamp(plexTrack)).toEqual(READ);
    expect(await stamp(jellyMovie)).toEqual(READ);
  });

  it("restores a backup that holds the ratings as it is", async () => {
    const { plexMovie } = await seed();
    await prisma.mediaItem.update({ where: { id: plexMovie.id }, data: { imdbRating: 7.4 } });
    const filename = await createBackup(undefined, false);

    await restoreBackup(filename);

    const row = await prisma.mediaItem.findUniqueOrThrow({ where: { id: plexMovie.id } });
    expect(row.serverUpdatedAt).toEqual(READ);
    expect(row.imdbRating).toBe(7.4);
  });
});
