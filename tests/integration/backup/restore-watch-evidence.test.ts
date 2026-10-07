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
const { requireLibraryResync, requirePopulationResync } = await import("@/lib/media/watch-evidence");

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

  it("holds a server restored without its media until a full sync re-adds it", async () => {
    // Its items come back on the next sync as fresh rows with none of their
    // plays. A history pass that ran before that sync — a playback's realtime
    // job, a History-page Refresh — would otherwise establish the marker over
    // items that do not exist yet, and they would then read as never watched.
    const { userId, serverId } = await seed(false);
    const prisma = getTestPrisma();
    const { markWatchHistoryEstablished } = await import("@/lib/media/watch-evidence");

    const filename = await createBackup(undefined, true);
    const before = Date.now();
    await restoreBackup(filename);

    const server = await prisma.mediaServer.findUniqueOrThrow({
      where: { id: serverId },
      select: { libraryResyncRequiredAt: true, watchHistorySyncedAt: true },
    });
    expect(server.libraryResyncRequiredAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(server.watchHistorySyncedAt).toBeNull();
    // A history sync that runs now cannot vouch for it...
    await expect(markWatchHistoryEstablished([serverId])).resolves.toBe(0);
    // ...and the refusal says what will lift it.
    const verdict = await checkWatchHistoryCompleteness(userId, [serverId]);
    if (verdict.complete) throw new Error("expected a refusal");
    expect(verdict.reason).toMatch(/run Sync on it under Settings → Servers/);
  });

  it("holds no server whose media the backup brought back", async () => {
    const { serverId } = await seed(false);
    const prisma = getTestPrisma();

    const filename = await createBackup(undefined, false);
    await restoreBackup(filename);

    expect(await prisma.mediaItem.count()).toBe(1);
    const server = await prisma.mediaServer.findUniqueOrThrow({
      where: { id: serverId },
      select: { libraryResyncRequiredAt: true, watchHistorySyncedAt: true },
    });
    expect(server.libraryResyncRequiredAt).toBeNull();
    // Its plays came back with it, so the marker restored with the row stands.
    expect(server.watchHistorySyncedAt).not.toBeNull();
  });

  it("does not let a restored tracearrBackfillComplete flag vouch for an empty history", async () => {
    // The `MediaServer` row is restored verbatim, so the flag would survive
    // while the rows it describes do not. The restore withdraws the evidence
    // marker AND restarts the archive walk: the importer no longer infers
    // "stale" from "no rows" (a walk can legitimately end having stored
    // nothing), so a restored "complete" would otherwise import nothing again.
    const { userId, serverId } = await seed(true);
    const prisma = getTestPrisma();
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: {
        tracearrBackfillCursorAt: new Date("2019-01-01T00:00:00Z"),
        tracearrForwardFloorAt: new Date("2025-01-01T00:00:00Z"),
        tracearrBackfillLastWalkAt: new Date("2025-06-01T00:00:00Z"),
      },
    });

    const filename = await createBackup(undefined, true);
    const before = Date.now();
    await restoreBackup(filename);

    const server = await prisma.mediaServer.findUniqueOrThrow({
      where: { id: serverId },
      select: {
        tracearrBackfillComplete: true,
        tracearrBackfillCursorAt: true,
        tracearrForwardWatermarkAt: true,
        tracearrForwardFloorAt: true,
        tracearrBackfillLastWalkAt: true,
        watchHistorySyncedAt: true,
        libraryResyncRequiredAt: true,
      },
    });
    expect(server.tracearrBackfillComplete).toBe(false);
    // Restarted from the newest play, not resumed at the restored 2019 cursor.
    expect(server.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(server.tracearrForwardWatermarkAt).toEqual(server.tracearrBackfillCursorAt);
    expect(server.tracearrForwardFloorAt).toBeNull();
    expect(server.tracearrBackfillLastWalkAt).toBeNull();
    expect(server.watchHistorySyncedAt).toBeNull();
    // Its media did not come back either, so the walk is held until a full
    // sync re-adds it: walked first, its plays would resolve to nothing.
    expect(server.libraryResyncRequiredAt).toBeInstanceOf(Date);

    await expect(
      checkWatchHistoryCompleteness(userId, [serverId]),
    ).resolves.toMatchObject({ complete: false });
  });

  it("keeps the walk state of a server whose Tracearr rows the backup restored", async () => {
    // A full backup carries the rows the state describes, so the two still
    // agree after the restore and the walk must not start over.
    const { serverId } = await seed(true);
    const prisma = getTestPrisma();
    const item = await prisma.mediaItem.findFirstOrThrow();
    await prisma.watchHistory.create({
      data: {
        mediaItemId: item.id,
        mediaServerId: serverId,
        serverUsername: "roommate",
        watchedAt: new Date("2024-06-01T00:00:00Z"),
        source: "TRACEARR",
        sourceEventId: "chain-1",
      },
    });
    const cursor = new Date("2019-01-01T00:00:00Z");
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillCursorAt: cursor },
    });

    const filename = await createBackup(undefined, false);
    await restoreBackup(filename);

    const server = await prisma.mediaServer.findUniqueOrThrow({
      where: { id: serverId },
      select: { tracearrBackfillComplete: true, tracearrBackfillCursorAt: true, libraryResyncRequiredAt: true },
    });
    expect(server.tracearrBackfillComplete).toBe(true);
    expect(server.tracearrBackfillCursorAt).toEqual(cursor);
    expect(server.libraryResyncRequiredAt).toBeNull();
  });

  it("restarts, without holding, a server whose media came back but whose Tracearr rows did not", async () => {
    // A full backup taken while the walk had stored nothing: the items exist,
    // so the restarted walk can attach the plays as it reads them.
    const { serverId } = await seed(true);
    const prisma = getTestPrisma();
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillCursorAt: new Date("2019-01-01T00:00:00Z") },
    });

    const filename = await createBackup(undefined, false);
    const before = Date.now();
    await restoreBackup(filename);

    const server = await prisma.mediaServer.findUniqueOrThrow({
      where: { id: serverId },
      select: {
        tracearrBackfillComplete: true,
        tracearrBackfillCursorAt: true,
        tracearrForwardWatermarkAt: true,
        libraryResyncRequiredAt: true,
      },
    });
    expect(server.libraryResyncRequiredAt).toBeNull();
    expect(server.tracearrBackfillComplete).toBe(false);
    expect(server.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(server.tracearrForwardWatermarkAt).toEqual(server.tracearrBackfillCursorAt);
  });

  it("restarts a held mapped server's walk once, not twice", async () => {
    // `requireLibraryResync` restarts it; the restart for servers whose
    // Tracearr rows are missing must leave the held ones out.
    const { serverId } = await seed(true);
    const prisma = getTestPrisma();
    const { logger } = await import("@/lib/logger");
    const filename = await createBackup(undefined, true);
    vi.mocked(logger.info).mockClear();

    await restoreBackup(filename);

    expect((await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } })).libraryResyncRequiredAt).toBeInstanceOf(Date);
    const infos = vi.mocked(logger.info).mock.calls.map((call) => String(call[1]));
    expect(infos.some((line) => line.includes("Holding the play history of 1 media server(s)"))).toBe(true);
    expect(infos.some((line) => line.includes("Restarted the Tracearr history import"))).toBe(false);
  });

  it("leaves an unmapped server's (empty) Tracearr state alone", async () => {
    const { serverId } = await seed(false);
    const prisma = getTestPrisma();
    const filename = await createBackup(undefined, true);
    await restoreBackup(filename);
    const server = await prisma.mediaServer.findUniqueOrThrow({
      where: { id: serverId },
      select: { tracearrBackfillCursorAt: true, tracearrForwardWatermarkAt: true },
    });
    expect(server.tracearrBackfillCursorAt).toBeNull();
    expect(server.tracearrForwardWatermarkAt).toBeNull();
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

  it("forgets the hold requests this process noted, and every library's recorded shortfall", async () => {
    // A purge's request outlived the restore that undid it: the hold column
    // came back as the file had it (null), but the noted request kept a
    // library enabled afterwards from getting its own population hold's
    // receipt, so that hold waited for a full sync. And a shortfall recorded
    // against rows the restore replaced must not count toward a release.
    const prisma = getTestPrisma();
    const { serverId } = await seed(false);
    await prisma.library.updateMany({ where: { mediaServerId: serverId }, data: { shortPassSeenAt: new Date() } });
    const filename = await createBackup(undefined, false);
    await requireLibraryResync([serverId]);

    await restoreBackup(filename);

    expect(
      (await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } })).libraryResyncRequiredAt,
    ).toBeNull();
    await expect(requirePopulationResync(serverId, new Date())).resolves.not.toBeNull();
    expect(
      (await prisma.library.findMany({ where: { mediaServerId: serverId } })).map((l) => l.shortPassSeenAt),
    ).toEqual([null]);
  });
});
