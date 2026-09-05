/**
 * A real backup → restore round trip through the actual service (every other
 * backup test mocks it), asserting the one safety property that only shows up
 * end-to-end.
 *
 * Restore `TRUNCATE`s every table in `TABLE_ORDER` — `MediaItem` and
 * `WatchHistory` included — and then re-inserts only what the file holds. A
 * **config-only** backup, which is the default, holds neither. So a restore
 * empties both and refills neither: the media comes back on the next sync, and
 * the watch history comes back only when a Tracearr archive walk or a native
 * full replace refills it.
 *
 * In the window between those two, every item is present with an empty
 * `WatchHistory` — and `watchedByUser`'s negative forms compile to
 * `watchHistory: { none: … }`, which is trivially TRUE for every item against
 * an empty relation. On a DELETE rule set that is the whole library, restored
 * moments earlier from a backup taken to protect it.
 *
 * A Tracearr-mapped server is the sharper case: its `MediaServer` row is
 * restored VERBATIM, so `tracearrBackfillComplete` comes back `true` over an
 * empty table — the flag vouching for history that no longer exists.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";

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

const { createBackup, restoreBackup } = await import("@/lib/backup/backup-service");
const { checkWatchHistoryCompleteness } = await import("@/lib/lifecycle/evaluability");

async function seed(tracearrMapped: boolean) {
  const prisma = getTestPrisma();
  const user = await prisma.user.create({
    data: { username: `restore-${Math.random().toString(36).slice(2)}`, passwordHash: "x" },
  });
  const server = await prisma.mediaServer.create({
    data: {
      userId: user.id,
      name: "Plex",
      type: "PLEX",
      url: "http://plex:32400",
      accessToken: "x",
      machineId: `restore-${Math.random().toString(36).slice(2)}`,
      // A synced server, so the pre-restore sanity check is meaningful.
      watchHistorySyncedAt: new Date(),
      ...(tracearrMapped
        ? { tracearrServerId: "trc-server", tracearrBackfillComplete: true }
        : {}),
    },
  });
  const library = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
  });
  const item = await prisma.mediaItem.create({
    data: { libraryId: library.id, ratingKey: "k1", title: "A Movie", type: "MOVIE" },
  });
  await prisma.watchHistory.create({
    data: {
      mediaItemId: item.id,
      mediaServerId: server.id,
      serverUsername: "roommate",
      watchedAt: new Date("2025-06-01T00:00:00Z"),
    },
  });
  return { userId: user.id, serverId: server.id };
}

describe("restoring a config-only backup", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await disconnectTestDb();
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it("leaves the restored server un-evidenced, so play-activity rules stay paused", async () => {
    const { userId, serverId } = await seed(false);
    const prisma = getTestPrisma();

    // Sanity: the guard is happy before the restore, so the assertion below is
    // about the restore rather than about the fixture.
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({
      complete: true,
    });

    const filename = await createBackup(undefined, true);
    await restoreBackup(filename);

    // The config-only backup carried no plays, so there are none to come back.
    expect(await prisma.watchHistory.count()).toBe(0);
    // The server itself did come back — which is exactly the danger: present,
    // syncable, and holding no evidence of anything ever being watched.
    expect(await prisma.mediaServer.count()).toBe(1);

    await expect(
      checkWatchHistoryCompleteness(userId, [serverId]),
    ).resolves.toMatchObject({ complete: false });
  });

  it("does not let a restored tracearrBackfillComplete flag vouch for an empty history", async () => {
    // The `MediaServer` row is restored verbatim, so the flag survives while
    // the rows it describes do not. The restore withdraws the evidence marker,
    // so the guard refuses regardless of what the stale flag claims.
    const { userId, serverId } = await seed(true);
    const prisma = getTestPrisma();

    const filename = await createBackup(undefined, true);
    await restoreBackup(filename);

    const server = await prisma.mediaServer.findUniqueOrThrow({
      where: { id: serverId },
      select: { tracearrBackfillComplete: true, watchHistorySyncedAt: true },
    });
    expect(server.tracearrBackfillComplete).toBe(true);
    expect(server.watchHistorySyncedAt).toBeNull();

    await expect(
      checkWatchHistoryCompleteness(userId, [serverId]),
    ).resolves.toMatchObject({ complete: false });
  });

  it("restores the TracearrInstance rather than destroying it", async () => {
    // `TRUNCATE "User" CASCADE` takes `TracearrInstance` with it, so a table
    // missing from `TABLE_ORDER` is silently destroyed and never restored —
    // leaving servers mapped to an instance that no longer exists, which the
    // sync then skips outright rather than falling back to native history.
    const prisma = getTestPrisma();
    const { userId } = await seed(true);
    await prisma.tracearrInstance.create({
      data: { userId, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k", enabled: true },
    });

    const filename = await createBackup(undefined, true);
    await restoreBackup(filename);

    const instances = await prisma.tracearrInstance.findMany();
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe("http://tracearr:8080");
  });
});
