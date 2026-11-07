/**
 * A restore that leaves a Tracearr-mapped server without Tracearr plays
 * restarts its archive walk from the newest play.
 *
 * A config-only backup holds no `WatchHistory`, but it does hold the
 * `MediaServer` row — Tracearr walk state included. One taken part-way
 * through a server's first archive walk carries a cursor deep in the archive:
 * restored verbatim over no rows, the next backfill slice resumed at that
 * cursor and never read the newer stretch again, and with no rows the forward
 * pass had no watermark to catch up from. The real backup and restore, then
 * the real importer against a fake archive that honours `since`/`until` and
 * pages by cursor.
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
import type { TracearrHistoryRecord } from "@/lib/tracearr/tracearr-client";

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
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));

const T = "dddddddd-1111-2222-3333-444444444444";

const fake = vi.hoisted(() => ({
  /** Every play Tracearr holds for the server, newest first. */
  archive: [] as TracearrHistoryRecord[],
  pageSize: 2,
  requests: [] as Array<{ since?: Date; until?: Date; cursor?: string }>,
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getServerAccountNames = async () => new Map([["u1", "weingart"]]);
    this.findOldestPlayAt = async () => null;
    this.listServers = async () => [{ id: T }];
    this.getHistoryPage = async (
      _id: string,
      opts: { since?: Date; until?: Date; cursor?: string },
    ) => {
      fake.requests.push({ since: opts.since, until: opts.until, cursor: opts.cursor });
      const inWindow = fake.archive.filter((record) => {
        const at = new Date(record.started_at).getTime();
        return (!opts.since || at >= opts.since.getTime()) && (!opts.until || at <= opts.until.getTime());
      });
      const offset = opts.cursor ? Number(opts.cursor) : 0;
      const end = offset + fake.pageSize;
      return {
        records: inWindow.slice(offset, end),
        nextCursor: end < inWindow.length ? String(end) : null,
      };
    };
  },
}));

const { createBackup, restoreBackup } = await import("@/lib/backup/backup-service");
const { syncTracearrHistory } = await import("@/lib/sync/sync-tracearr-history");

const prisma = getTestPrisma();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function play(id: string, ratingKey: string, startedAt: Date): TracearrHistoryRecord {
  return {
    id,
    reference_id: id,
    server_id: T,
    state: "stopped",
    media_type: "movie",
    rating_key: ratingKey,
    grandparent_rating_key: null,
    parent_rating_key: null,
    tmdb_id: null,
    imdb_id: null,
    tvdb_id: null,
    started_at: startedAt.toISOString(),
    stopped_at: new Date(startedAt.getTime() + HOUR).toISOString(),
    watched: true,
    percent_complete: 100,
    segment_count: 1,
    user: { id: "x", server_user_id: "u1", username: "Nick W" },
  } as unknown as TracearrHistoryRecord;
}

const RATING_KEYS = ["rk-recent", "rk-spring", "rk-old"];

/**
 * A mapped server part-way through its first archive walk: the walk has read
 * down to 200 days ago, storing the two plays above that, and has the one
 * below it still to read.
 */
async function seedMidWalk(state: { tracearrBackfillComplete?: boolean } = {}) {
  const now = Date.now();
  const user = await createTestUser();
  await prisma.tracearrInstance.create({
    data: { userId: user.id, name: "T", url: "http://t", apiKey: "k" },
  });
  const server = await createTestServer(user.id, {
    type: "PLEX",
    tracearrServerId: T,
    tracearrBackfillComplete: state.tracearrBackfillComplete ?? false,
    watchHistorySyncedAt: null,
  });
  const cursorAt = new Date(now - 200 * DAY);
  await prisma.mediaServer.update({
    where: { id: server.id },
    data: { tracearrBackfillCursorAt: cursorAt },
  });
  const library = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  const items = new Map<string, string>();
  for (const ratingKey of RATING_KEYS) {
    const item = await createTestMediaItem(library.id, { ratingKey, title: ratingKey });
    items.set(ratingKey, item.id);
  }
  fake.archive = [
    play("chain-recent", "rk-recent", new Date(now - 2 * DAY)),
    play("chain-spring", "rk-spring", new Date(now - 40 * DAY)),
    play("chain-old", "rk-old", new Date(now - 300 * DAY)),
  ];
  // What the walk stored before the backup was taken.
  for (const record of fake.archive.slice(0, 2)) {
    await prisma.watchHistory.create({
      data: {
        mediaItemId: items.get(record.rating_key as string)!,
        mediaServerId: server.id,
        serverUsername: "weingart",
        watchedAt: new Date(record.started_at),
        source: "TRACEARR",
        sourceEventId: record.id,
        watched: true,
        state: "stopped",
      },
    });
  }
  return { server, library, cursorAt };
}

/** What the next sync does after a config-only restore: bring the media back. */
async function resyncMedia(libraryId: string) {
  for (const ratingKey of RATING_KEYS) {
    await createTestMediaItem(libraryId, { ratingKey, title: ratingKey });
  }
}

const readServer = (id: string) => prisma.mediaServer.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await cleanDatabase();
  fake.archive = [];
  fake.requests = [];
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
  await fs.rm(backupDir, { recursive: true, force: true });
});

describe("restoring a backup taken during a server's first Tracearr import", () => {
  it("walks the archive again from the newest play, landing the newer stretch", async () => {
    const { server, library } = await seedMidWalk();
    const filename = await createBackup(undefined, true);
    const restoredAt = Date.now();

    await restoreBackup(filename);
    // The config-only file carried no plays.
    expect(await prisma.watchHistory.count()).toBe(0);

    await resyncMedia(library.id);
    const result = await syncTracearrHistory(server.id, { passes: "backfill" });

    const rows = await prisma.watchHistory.findMany({
      where: { mediaServerId: server.id },
      select: { sourceEventId: true },
      orderBy: { watchedAt: "desc" },
    });
    expect(rows.map((row) => row.sourceEventId)).toEqual([
      "chain-recent",
      "chain-spring",
      "chain-old",
    ]);
    // The walk started above the newest play, not at the restored cursor.
    expect(fake.requests[0].until!.getTime()).toBeGreaterThanOrEqual(restoredAt);
    expect(result.backfillPending).toBe(false);
  });

  it("restarts the walk state the file carried along with the plays it did not", async () => {
    const { server } = await seedMidWalk();
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrForwardResumeAt: new Date(Date.now() - 5 * DAY) },
    });
    const filename = await createBackup(undefined, true);
    const restoredAt = Date.now();

    await restoreBackup(filename);

    const restored = await readServer(server.id);
    expect(restored.tracearrBackfillComplete).toBe(false);
    expect(restored.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(restoredAt);
    expect(restored.tracearrForwardResumeAt).toBeNull();
  });

  it("restarts a walk the file records as finished, too", async () => {
    const { server } = await seedMidWalk({ tracearrBackfillComplete: true });
    const filename = await createBackup(undefined, true);
    const restoredAt = Date.now();

    await restoreBackup(filename);

    const restored = await readServer(server.id);
    expect(restored.tracearrBackfillComplete).toBe(false);
    expect(restored.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(restoredAt);
  });

  it("restarts a server whose restored history holds only native plays", async () => {
    // A full backup, but the server's rows in it say nothing about how far a
    // Tracearr walk got.
    const { server, cursorAt } = await seedMidWalk();
    await prisma.watchHistory.updateMany({
      where: { mediaServerId: server.id },
      data: { source: "NATIVE", sourceEventId: null },
    });
    const filename = await createBackup(undefined, false);
    const restoredAt = Date.now();

    await restoreBackup(filename);

    const restored = await readServer(server.id);
    expect(await prisma.watchHistory.count({ where: { mediaServerId: server.id } })).toBe(2);
    expect(restored.tracearrBackfillCursorAt!.getTime()).not.toBe(cursorAt.getTime());
    expect(restored.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(restoredAt);
  });

  it("keeps the walk state of a server whose restored history holds Tracearr plays", async () => {
    // A full backup carries the rows the cursor was measured against, so the
    // walk resumes where it stood.
    const { server, cursorAt } = await seedMidWalk();
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrForwardResumeAt: new Date(Date.now() - 5 * DAY) },
    });
    const before = await readServer(server.id);
    const filename = await createBackup(undefined, false);

    await restoreBackup(filename);

    const restored = await readServer(server.id);
    expect(await prisma.watchHistory.count({ where: { mediaServerId: server.id } })).toBe(2);
    expect(restored.tracearrBackfillComplete).toBe(false);
    expect(restored.tracearrBackfillCursorAt).toEqual(cursorAt);
    expect(restored.tracearrForwardResumeAt).toEqual(before.tracearrForwardResumeAt);
  });

  it("leaves a server without a Tracearr mapping alone", async () => {
    const { server, cursorAt } = await seedMidWalk();
    await prisma.mediaServer.update({ where: { id: server.id }, data: { tracearrServerId: null } });
    const filename = await createBackup(undefined, true);

    await restoreBackup(filename);

    expect((await readServer(server.id)).tracearrBackfillCursorAt).toEqual(cursorAt);
  });
});
