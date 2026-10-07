import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import { FakeTracearrArchive, TRACEARR_SERVER_ID, play } from "./fake-tracearr-archive";

/**
 * Forward walks while a library-resync hold is set
 * (`MediaServer.libraryResyncRequiredAt`), end to end against real Postgres
 * with the real hold helpers and a fake Tracearr keyset.
 *
 * While the hold is set some of the server's items are known to be missing (a
 * purge, a restore, a library's first sync), so a forward walk stores everyone
 * else's plays and skips theirs as unresolved — and in doing so moves
 * `MAX(watchedAt)`, where the next forward window starts, past them. Nothing
 * else reads them again: the backfill the hold restarted walks only below the
 * cursor the restart set, and the next forward window starts an hour below the
 * new MAX. The floor the walk records before it first moves the watermark is
 * what keeps those plays owed, so it has to outlive the hold.
 */

const m = vi.hoisted(() => ({
  getHistoryPage: vi.fn(),
  listServers: vi.fn(),
  getServerAccountNames: vi.fn(),
  findOldestPlayAt: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getHistoryPage = m.getHistoryPage;
    this.listServers = m.listServers;
    this.getServerAccountNames = m.getServerAccountNames;
    this.findOldestPlayAt = m.findOldestPlayAt;
  },
}));

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import {
  _resetLibraryResyncHoldRequestsForTesting,
  releaseLibraryResyncHold,
  requireLibraryResync,
} from "@/lib/media/watch-evidence";

const prisma = getTestPrisma();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** When the hold lands. */
const T0 = new Date("2026-06-01T12:00:00.000Z").getTime();
const at = (offset: number) => new Date(T0 + offset);

let archive: FakeTracearrArchive;
let serverId: string;
let libraryId: string;
let presentItemId: string;

async function serverRow() {
  return prisma.mediaServer.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      tracearrForwardFloorAt: true,
      tracearrBackfillComplete: true,
      libraryResyncRequiredAt: true,
      watchHistorySyncedAt: true,
    },
  });
}

async function storedIds(): Promise<string[]> {
  const rows = await prisma.watchHistory.findMany({ select: { sourceEventId: true } });
  return rows.map((row) => row.sourceEventId ?? "").sort();
}

/** The full library sync that releases the hold, bringing the purged item back. */
async function releaseWithItemBack(libraryPassStartedAt: Date) {
  const item = await createTestMediaItem(libraryId, { ratingKey: "200", type: "MOVIE", title: "Heat" });
  expect(await releaseLibraryResyncHold(serverId, libraryPassStartedAt)).toBe(true);
  return item;
}

/** A walked archive with nothing stored: every play so far was of media long gone. */
async function walkedArchiveWithNoRows() {
  vi.setSystemTime(at(-DAY));
  await prisma.mediaServer.update({
    where: { id: serverId },
    data: {
      tracearrBackfillComplete: true,
      tracearrBackfillLastWalkAt: at(-DAY),
      tracearrForwardWatermarkAt: at(-DAY),
    },
  });
}

/** A play of the item that stays, in the archive and already stored. */
async function storedPlay(id: string, when: Date) {
  archive.add(play(id, when));
  await prisma.watchHistory.create({
    data: {
      mediaItemId: presentItemId,
      mediaServerId: serverId,
      serverUsername: "walter",
      watchedAt: when,
      source: "TRACEARR",
      sourceEventId: id,
      watched: true,
      state: "stopped",
    },
  });
}

/** A walked archive holding one old play of the item that stays. */
async function walkedArchiveWithRows() {
  vi.setSystemTime(at(-DAY));
  archive.add(play("old", at(-10 * DAY)));
  await prisma.watchHistory.create({
    data: {
      mediaItemId: presentItemId,
      mediaServerId: serverId,
      serverUsername: "walter",
      watchedAt: at(-10 * DAY),
      source: "TRACEARR",
      sourceEventId: "old",
      watched: true,
      state: "stopped",
    },
  });
  await prisma.mediaServer.update({
    where: { id: serverId },
    data: { tracearrBackfillComplete: true },
  });
}

describe("forward walks while some of the server's items are missing (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    _resetLibraryResyncHoldRequestsForTesting();
    vi.clearAllMocks();
    // Reset, not just cleared: a once-implementation a failed test never
    // consumed must not leak into the next one.
    for (const fn of Object.values(m)) fn.mockReset();
    archive = new FakeTracearrArchive();
    m.getHistoryPage.mockImplementation(async (id: string, options: object) => archive.page(id, options));
    m.findOldestPlayAt.mockImplementation(async (id: string) => archive.oldest(id));
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    const user = await createTestUser();
    const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_ID });
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    libraryId = library.id;
    presentItemId = (
      await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" })
    ).id;
    await prisma.tracearrInstance.create({
      data: { userId: user.id, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("reads a missing item's play from the hold once it is back — archive with no stored rows", async () => {
    await walkedArchiveWithNoRows();
    // A purge of the library holding rating key 200: its item is gone until
    // the next full sync, and the walk restarts from now.
    vi.setSystemTime(at(0));
    await requireLibraryResync([serverId]);
    archive.add(play("missing", at(10 * MINUTE), { rating_key: "200" }), play("present", at(3 * HOUR)));

    // A Refresh during the hold stores the play it can attribute, skips the
    // other — and the stretch it skipped stays owed.
    vi.setSystemTime(at(4 * HOUR));
    const during = await syncTracearrHistory(serverId, { passes: "forward" });
    expect(during.failed).toBeUndefined();
    expect(await storedIds()).toEqual(["present"]);
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(-HOUR));

    vi.setSystemTime(at(5 * HOUR));
    const returned = await releaseWithItemBack(at(4.5 * HOUR));

    vi.setSystemTime(at(6 * HOUR));
    archive.clearRequests();
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(archive.requests[0].since).toEqual(at(-HOUR));
    expect(await storedIds()).toEqual(["missing", "present"]);
    const missing = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "missing" } });
    expect(missing.mediaItemId).toBe(returned.id);
    expect((await serverRow()).tracearrForwardFloorAt).toBeNull();

    // And the restarted walk then completes and vouches for the history.
    const backfill = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(backfill).toMatchObject({ backfillOutcome: "exhausted", backfillPending: false });
    expect(await serverRow()).toMatchObject({
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  it("reads a missing item's play from the hold once it is back — archive with stored rows", async () => {
    await walkedArchiveWithRows();
    vi.setSystemTime(at(0));
    await requireLibraryResync([serverId]);
    archive.add(play("missing", at(10 * MINUTE), { rating_key: "200" }), play("present", at(3 * HOUR)));

    vi.setSystemTime(at(4 * HOUR));
    archive.clearRequests();
    await syncTracearrHistory(serverId, { passes: "forward" });
    // The walk's own window starts below the old play, as it always has.
    expect(archive.requests[0].since).toEqual(at(-10 * DAY - HOUR));
    expect(await storedIds()).toEqual(["old", "present"]);
    // But the floor it leaves goes no lower than an hour before the hold:
    // everything older is the restarted archive walk's to read.
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(-HOUR));

    vi.setSystemTime(at(5 * HOUR));
    const returned = await releaseWithItemBack(at(4.5 * HOUR));

    vi.setSystemTime(at(6 * HOUR));
    archive.clearRequests();
    await syncTracearrHistory(serverId, { passes: "forward" });
    // So the first walk after the release re-reads the hold, not ten days.
    expect(archive.requests[0].since).toEqual(at(-HOUR));
    const missing = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "missing" } });
    expect(missing.mediaItemId).toBe(returned.id);
    expect((await serverRow()).tracearrForwardFloorAt).toBeNull();

    // And the restarted walk reads everything below the hold.
    const backfill = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(backfill).toMatchObject({ backfillOutcome: "exhausted", backfillPending: false });
    expect(await storedIds()).toEqual(["missing", "old", "present"]);
    expect(await serverRow()).toMatchObject({
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  it("keeps a degraded walk's floor during the hold no lower than the hold either", async () => {
    await walkedArchiveWithRows();
    vi.setSystemTime(at(0));
    await requireLibraryResync([serverId]);
    archive.add(play("present", at(3 * HOUR)));

    // Tracearr's user list cannot be read: the walk stores identity labels
    // and records its floor before every page it writes.
    m.getServerAccountNames.mockRejectedValueOnce(new Error("users down"));
    vi.setSystemTime(at(4 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual(["old", "present"]);
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(-HOUR));
  });

  it("does not re-read back to the floor on every walk during the hold — only the first after it", async () => {
    await walkedArchiveWithNoRows();
    vi.setSystemTime(at(0));
    await requireLibraryResync([serverId]);
    archive.add(play("missing", at(10 * MINUTE), { rating_key: "200" }), play("present", at(3 * HOUR)));
    vi.setSystemTime(at(4 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });

    // A later playback during the same hold: the ordinary window, an hour
    // below the newest stored play — the floor cannot be paid while the item
    // is still missing, so walking down to it again would only re-read it.
    archive.add(play("present-2", at(7 * HOUR)));
    vi.setSystemTime(at(8 * HOUR));
    archive.clearRequests();
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(archive.requests[0].since).toEqual(at(2 * HOUR));
    expect(await storedIds()).toEqual(["present", "present-2"]);
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(-HOUR));

    vi.setSystemTime(at(9 * HOUR));
    await releaseWithItemBack(at(8.5 * HOUR));
    vi.setSystemTime(at(10 * HOUR));
    archive.clearRequests();
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(archive.requests[0].since).toEqual(at(-HOUR));
    expect(await storedIds()).toEqual(["missing", "present", "present-2"]);
  });

  it("keeps the floor when a walk that began during the hold finishes after its release", async () => {
    await walkedArchiveWithNoRows();
    vi.setSystemTime(at(0));
    await requireLibraryResync([serverId]);
    archive.add(play("missing", at(10 * MINUTE), { rating_key: "200" }), play("present", at(3 * HOUR)));

    // The releasing sync finishes while this walk's page is in flight: the
    // walk built its item index before the item came back, so it still skips
    // the play — and must not pay the floor that keeps it owed.
    vi.setSystemTime(at(4 * HOUR));
    m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await releaseWithItemBack(at(4 * HOUR));
      return archive.page(id, options);
    });
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual(["present"]);
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(-HOUR));

    vi.setSystemTime(at(5 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual(["missing", "present"]);
  });

  it("does not move the watermark past what a walk that began during the hold skipped", async () => {
    // Nothing stored and nothing storable during the hold, so no floor: the
    // watermark is all that keeps the skipped play owed.
    await walkedArchiveWithNoRows();
    vi.setSystemTime(at(0));
    await requireLibraryResync([serverId]);
    archive.add(play("missing", at(10 * MINUTE), { rating_key: "200" }));

    vi.setSystemTime(at(4 * HOUR));
    m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await releaseWithItemBack(at(4 * HOUR));
      return archive.page(id, options);
    });
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual([]);
    expect(
      (await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } })).tracearrForwardWatermarkAt,
    ).toEqual(at(0));

    vi.setSystemTime(at(5 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual(["missing"]);
  });

  it("does not let a walk that began before the hold pay a floor while the hold is set", async () => {
    await walkedArchiveWithRows();
    archive.add(play("present", at(-5 * MINUTE)));
    vi.setSystemTime(at(0));
    // The hold lands (with its restart) while this walk's first page is in
    // flight, and a walk run during the hold records a floor meanwhile.
    m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await requireLibraryResync([serverId]);
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrForwardFloorAt: at(-30 * MINUTE) },
      });
      return archive.page(id, options);
    });

    const result = await syncTracearrHistory(serverId, { passes: "forward" });

    expect(result.failed).toBeUndefined();
    expect(await storedIds()).toEqual(["old", "present"]);
    // Still owed: the walk read only what had started before it began.
    expect((await serverRow()).tracearrForwardFloorAt).not.toBeNull();
  });

  it("still pays a floor normally when no hold is set", async () => {
    // The positive control: the same walk without a hold clears the floor
    // it recorded, and vouches.
    await walkedArchiveWithRows();
    archive.add(play("present", at(3 * HOUR)));
    vi.setSystemTime(at(4 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual(["old", "present"]);
    expect(await serverRow()).toMatchObject({
      tracearrForwardFloorAt: null,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  it("bounds a held walk's floor by the restart cursor when the hold is newer than it", async () => {
    // The restart-shaped state an older build left — its walk restarted (cursor
    // = the restart instant) ten days ago — with a hold newer than that
    // cursor. The restarted walk resumes at the cursor, so a floor bounded by
    // the hold alone would sit above a missing item's play from five days ago
    // that neither walk reads.
    vi.setSystemTime(at(-DAY));
    await storedPlay("old", at(-30 * DAY));
    archive.add(play("missing", at(-5 * DAY), { rating_key: "200" }));
    vi.setSystemTime(at(0));
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: {
        tracearrBackfillComplete: false,
        tracearrBackfillCursorAt: at(-10 * DAY),
        tracearrForwardWatermarkAt: at(-10 * DAY),
        libraryResyncRequiredAt: at(0),
      },
    });
    archive.add(play("present", at(HOUR)));

    vi.setSystemTime(at(2 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual(["old", "present"]);
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(-10 * DAY - HOUR));

    vi.setSystemTime(at(3 * HOUR));
    const returned = await releaseWithItemBack(at(2.5 * HOUR));
    vi.setSystemTime(at(4 * HOUR));
    archive.clearRequests();
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(archive.requests[0].since).toEqual(at(-10 * DAY - HOUR));
    const missing = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "missing" } });
    expect(missing.mediaItemId).toBe(returned.id);

    archive.clearRequests();
    const backfill = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(archive.requests[0].until).toEqual(at(-10 * DAY));
    expect(backfill).toMatchObject({ backfillOutcome: "exhausted", backfillPending: false });
    expect(await serverRow()).toMatchObject({
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  for (const presentRows of [true, false]) {
    it(`bounds a held walk's floor by the LATEST restart when the hold is requested again (stored rows: ${presentRows})`, async () => {
      // A walked archive holding the purged item's old play, and the present
      // item's — or, in the second variant, nothing once the purge has run.
      vi.setSystemTime(at(-DAY));
      if (presentRows) await storedPlay("p100-old", at(-30 * DAY));
      else archive.add(play("p100-old", at(-30 * DAY)));
      const purged = await createTestMediaItem(libraryId, { ratingKey: "200", type: "MOVIE", title: "Heat" });
      archive.add(play("p200-old", at(-20 * DAY), { rating_key: "200" }));
      await prisma.watchHistory.create({
        data: {
          mediaItemId: purged.id,
          mediaServerId: serverId,
          serverUsername: "walter",
          watchedAt: at(-20 * DAY),
          source: "TRACEARR",
          sourceEventId: "p200-old",
          watched: true,
          state: "stopped",
        },
      });
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: {
          tracearrBackfillComplete: true,
          tracearrBackfillCursorAt: at(-30 * DAY),
          tracearrBackfillLastWalkAt: at(-2 * DAY),
          tracearrOldestPlayAt: at(-30 * DAY),
        },
      });

      // A purge at 0: the hold first, then the delete, which takes the play.
      vi.setSystemTime(at(0));
      await requireLibraryResync([serverId]);
      await prisma.mediaItem.delete({ where: { id: purged.id } });
      archive.add(play("p100-a", at(0.5 * HOUR)), play("p200-a", at(0.7 * HOUR), { rating_key: "200" }));
      vi.setSystemTime(at(HOUR));
      await syncTracearrHistory(serverId, { passes: "forward" });

      // Requested again five days on (another purge, a library's first sync):
      // the hold keeps its first instant; the walk restarts from now.
      vi.setSystemTime(at(5 * DAY));
      await requireLibraryResync([serverId]);
      expect((await serverRow()).libraryResyncRequiredAt).toEqual(at(0));
      archive.add(
        play("p100-b", at(5 * DAY + 0.2 * HOUR)),
        play("p200-b", at(5 * DAY + 0.4 * HOUR), { rating_key: "200" }),
      );
      vi.setSystemTime(at(5 * DAY + HOUR));
      await syncTracearrHistory(serverId, { passes: "forward" });
      // No lower than an hour below the latest restart: everything older is
      // the restarted walk's.
      expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(5 * DAY - HOUR));
      archive.add(play("p100-c", at(8 * DAY)), play("p200-c", at(8 * DAY + HOUR), { rating_key: "200" }));
      vi.setSystemTime(at(8 * DAY + 2 * HOUR));
      await syncTracearrHistory(serverId, { passes: "forward" });

      vi.setSystemTime(at(10 * DAY));
      const returned = await releaseWithItemBack(at(9.9 * DAY));
      vi.setSystemTime(at(10 * DAY + MINUTE));
      archive.clearRequests();
      await syncTracearrHistory(serverId, { passes: "forward" });
      // The first walk after the release re-reads from the latest restart, not
      // the whole ten-day hold.
      expect(archive.requests[0].since).toEqual(at(5 * DAY - HOUR));

      // And the restarted walk covers everything at or below its cursor.
      let backfill = await syncTracearrHistory(serverId, { passes: "backfill" });
      for (let i = 0; i < 3 && backfill.backfillPending; i++) {
        backfill = await syncTracearrHistory(serverId, { passes: "backfill" });
      }
      const onReturned = await prisma.watchHistory.findMany({
        where: { mediaItemId: returned.id },
        select: { sourceEventId: true },
      });
      expect(onReturned.map((row) => row.sourceEventId).sort()).toEqual([
        "p200-a",
        "p200-b",
        "p200-c",
        "p200-old",
      ]);
      expect(await serverRow()).toMatchObject({
        tracearrBackfillComplete: true,
        tracearrForwardFloorAt: null,
        watchHistorySyncedAt: expect.any(Date),
      });
    });
  }

  // The next two SIMULATE holds that `requireLibraryResync` never leaves on its
  // own — every hold restarts a mapped server's walk, which records a cursor
  // and marks the archive unfinished. Only a restart write that failed after
  // the hold was written leaves them. Where nothing below the floor is proven
  // to be walked again, it is not bounded at all.
  it("does not bound the floor of an archive already walked to its end", async () => {
    vi.setSystemTime(at(-DAY));
    await storedPlay("old", at(-10 * DAY));
    archive.add(play("missing", at(-5 * DAY), { rating_key: "200" }), play("present", at(HOUR)));
    vi.setSystemTime(at(0));
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: {
        // A walk that exhausted right after a restart keeps the restart's
        // cursor; nothing will walk below it again.
        tracearrBackfillComplete: true,
        tracearrBackfillCursorAt: at(-HOUR),
        libraryResyncRequiredAt: at(0),
      },
    });

    vi.setSystemTime(at(2 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(-10 * DAY - HOUR));

    vi.setSystemTime(at(3 * HOUR));
    const returned = await releaseWithItemBack(at(2.5 * HOUR));
    vi.setSystemTime(at(4 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    const missing = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "missing" } });
    expect(missing.mediaItemId).toBe(returned.id);
  });

  it("does not bound the floor when no resume cursor is recorded", async () => {
    vi.setSystemTime(at(-DAY));
    await storedPlay("old", at(-10 * DAY));
    archive.add(play("missing", at(-5 * DAY), { rating_key: "200" }), play("present", at(HOUR)));
    vi.setSystemTime(at(0));
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: {
        tracearrBackfillComplete: false,
        tracearrBackfillCursorAt: null,
        libraryResyncRequiredAt: at(0),
      },
    });

    vi.setSystemTime(at(2 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(-10 * DAY - HOUR));

    vi.setSystemTime(at(3 * HOUR));
    const returned = await releaseWithItemBack(at(2.5 * HOUR));
    vi.setSystemTime(at(4 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    const missing = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "missing" } });
    expect(missing.mediaItemId).toBe(returned.id);
  });
});
