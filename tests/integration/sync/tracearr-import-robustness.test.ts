import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

/** The Tracearr importer's failure modes that only real Postgres can show. */

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
import { TRACEARR_SERVER_ID, play as record } from "./fake-tracearr-archive";
import {
  invalidateWatchHistoryEvidence,
  restartTracearrBackfill,
} from "@/lib/media/watch-evidence";

const prisma = getTestPrisma();
const HOUR = 60 * 60 * 1000;

let serverId: string;
let mediaItemId: string;

const serverRow = () => prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });

/** A finished archive whose newest stored play is `max`. */
async function finishedArchive(max: Date, data: Prisma.MediaServerUpdateInput = {}) {
  await prisma.watchHistory.create({
    data: {
      mediaItemId,
      mediaServerId: serverId,
      serverUsername: "walter",
      watchedAt: max,
      source: "TRACEARR",
      sourceEventId: "stored",
      watched: true,
      state: "stopped",
    },
  });
  await prisma.mediaServer.update({
    where: { id: serverId },
    data: { tracearrBackfillComplete: true, ...data },
  });
}

describe("Tracearr importer robustness (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    m.getHistoryPage.mockReset();
    const user = await createTestUser();
    serverId = (await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_ID })).id;
    const library = await createTestLibrary(serverId, { type: "MOVIE" });
    mediaItemId = (
      await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" })
    ).id;
    await prisma.tracearrInstance.create({
      data: { userId: user.id, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    m.findOldestPlayAt.mockResolvedValue(null);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("a page the database refuses", () => {
    afterEach(async () => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS poison_tracearr ON "WatchHistory"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS poison_tracearr()`);
    });

    it("is an error the task backs off on, not a resumable stop it re-queues at once", async () => {
      // A record whose INSERT fails on every attempt.
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION poison_tracearr() RETURNS trigger AS $$
        BEGIN
          IF NEW."sourceEventId" = 'poison' THEN
            RAISE EXCEPTION 'refused';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER poison_tracearr BEFORE INSERT ON "WatchHistory"
        FOR EACH ROW EXECUTE FUNCTION poison_tracearr()`);
      m.getHistoryPage.mockResolvedValue({
        records: [record("poison", "2024-01-01T00:00:00.000Z")],
        nextCursor: "c2",
      });

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await syncTracearrHistory(serverId, { passes: "backfill" });
        expect(result).toMatchObject({ backfillOutcome: "errored", backfillPending: true });
      }

      const after = await serverRow();
      // Nothing committed, so nothing moved, and no walk is recorded.
      expect(after.tracearrBackfillCursorAt).toBeNull();
      expect(after.tracearrBackfillLastWalkAt).toBeNull();
      expect(await prisma.watchHistory.count()).toBe(0);
    });

    it("stores out-of-range integers as null and strips NUL characters instead of failing the page", async () => {
      // int64 upstream vs `integer` here; Postgres refuses NUL in text and JSON.
      m.getHistoryPage.mockResolvedValueOnce({
        records: [
          {
            ...record("bad", "2024-01-01T00:00:00.000Z"),
            progress_ms: "9999999999",
            duration_ms: 3_000_000_000,
            bitrate: 12_000,
            device: "Living\u0000 Room",
            transcode_info: { reason: "bad\u0000value", ["k\u0000ey"]: 1 },
          },
        ],
        nextCursor: null,
      });

      const result = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(result.backfillOutcome).toBe("exhausted");
      const row = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "bad" } });
      expect(row.progressMs).toBeNull();
      expect(row.durationMs).toBeNull();
      expect(row.bitrate).toBe(12_000);
      expect(row.deviceName).toBe("Living Room");
      expect(row.transcodeInfo).toEqual({ reason: "badvalue", key: 1 });
    });
  });

  describe("walk state with no rows behind it is trusted", () => {
    it("keeps walking down an archive whose newest slice held nothing storable", async () => {
      // The first slice's cursor has no rows behind it; it is not reset.
      m.getHistoryPage.mockResolvedValueOnce({
        records: [record("gone-1", "2026-09-30T00:00:00.000Z", { rating_key: "missing" })],
        nextCursor: "c2",
      });
      const first = await syncTracearrHistory(serverId, {
        passes: "backfill",
        deadlineMs: Date.now() - 1,
      });
      expect(first.backfillOutcome).toBe("stopped");
      const cursor = (await serverRow()).tracearrBackfillCursorAt;
      expect(cursor).toEqual(new Date("2026-09-30T00:00:00.000Z"));
      expect((await serverRow()).tracearrBackfillLastWalkAt).toBeInstanceOf(Date);

      m.getHistoryPage.mockReset();
      m.getHistoryPage.mockResolvedValueOnce({
        records: [record("old", "2023-01-01T00:00:00.000Z")],
        nextCursor: null,
      });
      await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(m.getHistoryPage.mock.calls[0][1].until).toEqual(cursor);
      const after = await serverRow();
      expect(after.tracearrBackfillComplete).toBe(true);
      expect(await prisma.watchHistory.count({ where: { sourceEventId: "old" } })).toBe(1);
    });

    it("does not re-walk an archive that ended having stored nothing", async () => {
      m.getHistoryPage.mockResolvedValueOnce({
        records: [record("gone-1", "2026-09-30T00:00:00.000Z", { rating_key: "missing" })],
        nextCursor: null,
      });
      const first = await syncTracearrHistory(serverId, { passes: "backfill" });
      expect(first.backfillPending).toBe(false);
      const after = await serverRow();
      expect(after.tracearrBackfillComplete).toBe(true);
      expect(await prisma.watchHistory.count()).toBe(0);

      // The next slice is a no-op, not a restart from the top.
      m.getHistoryPage.mockClear();
      const second = await syncTracearrHistory(serverId, { passes: "backfill" });
      expect(second).toEqual({ count: 0, backfillPending: false });
      expect(m.getHistoryPage).not.toHaveBeenCalled();

      // And the forward pass still has a watermark to catch new plays from.
      m.getHistoryPage.mockResolvedValueOnce({
        records: [record("new", new Date().toISOString())],
        nextCursor: null,
      });
      await syncTracearrHistory(serverId, { passes: "forward" });
      const since = m.getHistoryPage.mock.calls[0][1].since as Date;
      expect(since.getTime()).toBeLessThanOrEqual(after.tracearrBackfillLastWalkAt!.getTime());
      expect(await prisma.watchHistory.count({ where: { sourceEventId: "new" } })).toBe(1);
    });
  });

  describe("an archive walk into an empty library", () => {
    // Completing over an empty history would leave the synced library reading
    // as never watched, with no walk left to run.
    const archive = [
      record("old-1", "2023-01-01T00:00:00.000Z"),
      record("old-2", "2024-06-01T00:00:00.000Z"),
    ];

    it("does not complete or vouch for the history while only a disabled library holds items", async () => {
      await prisma.library.updateMany({ where: { mediaServerId: serverId }, data: { enabled: false } });
      await prisma.mediaServer.update({ where: { id: serverId }, data: { watchHistorySyncedAt: null } });
      m.getHistoryPage.mockResolvedValue({ records: archive, nextCursor: null });

      const first = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(first).toEqual({
        count: 0,
        backfillPending: true,
        backfillOutcome: "exhausted",
        heldReason: "no-library-items",
      });
      expect(m.getHistoryPage).not.toHaveBeenCalled();
      const before = await serverRow();
      expect(before.tracearrBackfillComplete).toBe(false);
      expect(before.watchHistorySyncedAt).toBeNull();
      expect(before.tracearrBackfillCursorAt).toBeNull();
      expect(before.tracearrBackfillLastWalkAt).toBeNull();

      // Once a library sync brings the items in, the walk imports them.
      await prisma.library.updateMany({ where: { mediaServerId: serverId }, data: { enabled: true } });
      const second = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(second).toMatchObject({ count: 2, backfillPending: false, backfillOutcome: "exhausted" });
      expect(await prisma.watchHistory.count({ where: { mediaItemId } })).toBe(2);
      const after = await serverRow();
      expect(after.tracearrBackfillComplete).toBe(true);
      expect(after.watchHistorySyncedAt).toBeInstanceOf(Date);
    });

    it("does not re-establish a withdrawn marker or move the forward watermark while empty", async () => {
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: {
          tracearrBackfillComplete: true,
          tracearrBackfillLastWalkAt: new Date("2026-01-01T00:00:00.000Z"),
          tracearrForwardWatermarkAt: new Date("2026-01-02T00:00:00.000Z"),
          watchHistorySyncedAt: null,
        },
      });
      await prisma.mediaItem.deleteMany({});
      m.getHistoryPage.mockResolvedValue({ records: archive, nextCursor: null });

      const result = await syncTracearrHistory(serverId, { passes: "forward" });

      expect(result).toEqual({ count: 0, backfillPending: false });
      expect(m.getHistoryPage).not.toHaveBeenCalled();
      const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });
      expect(after.watchHistorySyncedAt).toBeNull();
      expect(after.tracearrForwardWatermarkAt).toEqual(new Date("2026-01-02T00:00:00.000Z"));
      expect(after.tracearrBackfillLastWalkAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    });
  });

  describe("a degraded forward run's rows are re-labelled by the next healthy one", () => {
    const OLD_MAX = new Date("2025-07-10T12:00:00.000Z");
    const SINCE = new Date(OLD_MAX.getTime() - HOUR);
    const window = [
      record("newest", "2025-07-20T09:00:00.000Z"),
      record("between", "2025-07-15T09:00:00.000Z"),
    ];

    it("keeps the floor at the degraded walk's since until a healthy walk re-delivers them", async () => {
      await finishedArchive(OLD_MAX);
      // Degraded: the account map is down, and the walk exhausts its window.
      m.getServerAccountNames.mockRejectedValueOnce(new Error("users down"));
      m.getHistoryPage.mockResolvedValueOnce({ records: window, nextCursor: null });
      await syncTracearrHistory(serverId, { passes: "forward" });

      let row = await serverRow();
      // Recorded and NOT cleared by the degraded walk's own exhaustion.
      expect(row.tracearrForwardFloorAt).toEqual(SINCE);
      expect(row.watchHistorySyncedAt).toBeNull();
      expect(
        (await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "between" } }))
          .serverUsername,
      ).toBe("Walter W");

      // Healthy: the floor reaches "between", and the bridged name overwrites.
      m.getHistoryPage.mockReset();
      m.getHistoryPage.mockResolvedValueOnce({ records: window, nextCursor: null });
      await syncTracearrHistory(serverId, { passes: "forward" });

      expect(m.getHistoryPage.mock.calls[0][1].since).toEqual(SINCE);
      const names = await prisma.watchHistory.findMany({
        where: { sourceEventId: { in: ["newest", "between"] } },
        select: { serverUsername: true },
      });
      expect(names.map((n) => n.serverUsername)).toEqual(["walter", "walter"]);
      row = await serverRow();
      expect(row.tracearrForwardFloorAt).toBeNull();
      expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
    });

    it("records the floor even when the degraded page does not move the watermark", async () => {
      await finishedArchive(OLD_MAX);
      m.getServerAccountNames.mockRejectedValueOnce(new Error("users down"));
      m.getHistoryPage.mockResolvedValueOnce({
        records: [record("overlap", "2025-07-10T11:30:00.000Z")],
        nextCursor: null,
      });

      await syncTracearrHistory(serverId, { passes: "forward" });

      expect((await serverRow()).tracearrForwardFloorAt).toEqual(SINCE);
    });
  });

  describe("the forward floor and the native cleanup, in SQL", () => {
    const OLD_MAX = new Date("2025-07-10T12:00:00.000Z");
    const failingWalk = () =>
      m.getHistoryPage
        .mockResolvedValueOnce({ records: [record("new", "2025-07-20T09:00:00.000Z")], nextCursor: "c2" })
        .mockRejectedValueOnce(new Error("socket hang up"));

    it("resumes an interrupted forward walk from the old watermark, then clears the floor", async () => {
      await finishedArchive(OLD_MAX, { watchHistorySyncedAt: new Date("2025-07-10") });
      // Run 1 commits the newest page, then Tracearr fails.
      failingWalk();
      const first = await syncTracearrHistory(serverId, { passes: "forward" });
      expect(first.failed).toMatch(/could not be reached/i);
      const originalSince = new Date(OLD_MAX.getTime() - HOUR);
      expect((await serverRow()).tracearrForwardFloorAt).toEqual(originalSince);

      // Run 2 still reaches the old watermark, clears the floor and
      // re-establishes the server.
      m.getHistoryPage.mockReset();
      m.getHistoryPage.mockResolvedValue({ records: [], nextCursor: null });
      const syncedBefore = (await serverRow()).watchHistorySyncedAt;
      await syncTracearrHistory(serverId, { passes: "forward" });

      expect(m.getHistoryPage.mock.calls[0][1].since).toEqual(originalSince);
      const after = await serverRow();
      expect(after.tracearrForwardFloorAt).toBeNull();
      expect(after.watchHistorySyncedAt!.getTime()).toBeGreaterThan(syncedBefore!.getTime());
    });

    it("only ever moves the floor earlier", async () => {
      const OLDER = new Date("2025-06-01T00:00:00.000Z");
      await finishedArchive(OLD_MAX, { tracearrForwardFloorAt: OLDER });
      // Without the account map the walk keeps to the ordinary, newer window.
      m.getServerAccountNames.mockRejectedValue(new Error("users down"));
      failingWalk();

      await syncTracearrHistory(serverId, { passes: "forward" });

      expect((await serverRow()).tracearrForwardFloorAt).toEqual(OLDER);
    });

    it("does not delete native history once the server has been unlinked", async () => {
      // Unlink + native refill land after the page commits, hooked on the
      // completion write that runs before the cleanup.
      m.getHistoryPage.mockResolvedValueOnce({
        records: [record("newest", "2026-10-01T00:00:00.000Z")],
        nextCursor: null,
      });
      const realUpdateMany = prisma.mediaServer.updateMany.bind(prisma.mediaServer);
      const spy = vi
        .spyOn(prisma.mediaServer, "updateMany")
        .mockImplementation((async (args: Parameters<typeof realUpdateMany>[0]) => {
          const out = await realUpdateMany(args);
          if ((args.data as Record<string, unknown>).tracearrBackfillComplete === true) {
            await prisma.mediaServer.update({ where: { id: serverId }, data: { tracearrServerId: null } });
            await prisma.watchHistory.create({
              data: {
                mediaItemId,
                mediaServerId: serverId,
                serverUsername: "walter",
                watchedAt: new Date("2026-10-02T00:00:00.000Z"),
              },
            });
          }
          return out;
        }) as never);

      try {
        await syncTracearrHistory(serverId, { passes: "backfill" });
      } finally {
        spy.mockRestore();
      }

      expect(await prisma.watchHistory.count({ where: { source: "NATIVE" } })).toBe(1);
    });
  });

  describe("the evidence marker is never written over a withdrawal made mid-run", () => {
    // A degraded Refresh (or a purge) withdraws while this run is paging; the
    // null case is a withdrawal that changes no column.
    it.each([
      ["set", new Date("2025-07-10")],
      ["already null", null],
    ])("a healthy forward run does not re-establish a marker withdrawn while it walked (%s)", async (_, marker) => {
      await finishedArchive(new Date("2025-07-10T12:00:00.000Z"), { watchHistorySyncedAt: marker });
      m.getHistoryPage.mockImplementationOnce(async () => {
        await invalidateWatchHistoryEvidence([serverId]);
        return { records: [], nextCursor: null };
      });

      await syncTracearrHistory(serverId, { passes: "forward" });

      expect((await serverRow()).watchHistorySyncedAt).toBeNull();
    });

    it("the finishing backfill still records completion, without the marker", async () => {
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { watchHistorySyncedAt: null },
      });
      m.getHistoryPage.mockImplementationOnce(async () => {
        await invalidateWatchHistoryEvidence([serverId]);
        return { records: [record("only", "2024-01-01T00:00:00.000Z")], nextCursor: null };
      });

      const result = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(result.backfillPending).toBe(false);
      const row = await serverRow();
      expect(row.tracearrBackfillComplete).toBe(true);
      expect(row.watchHistorySyncedAt).toBeNull();
    });
  });

  describe("a restart landing while the finishing slice runs", () => {
    it("reports the lost completion, keeps the restart, and voids the slice's live reach", async () => {
      m.getHistoryPage.mockImplementationOnce(async () => {
        await restartTracearrBackfill([serverId]);
        return { records: [record("deep", "2019-01-01T00:00:00.000Z")], nextCursor: null };
      });

      const result = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(result).toMatchObject({
        backfillOutcome: "exhausted",
        backfillPending: true,
        completionLost: true,
      });
      const row = await serverRow();
      expect(row.tracearrBackfillComplete).toBe(false);
      // The restart's cursor (≈ now) stands, not the slice's 2019 reach.
      expect(row.tracearrBackfillCursorAt!.getTime()).toBeGreaterThan(
        new Date("2026-01-01").getTime(),
      );
      expect(row.tracearrBackfillLastWalkAt).toBeNull();
    });
  });
});
