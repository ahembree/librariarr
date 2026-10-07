import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

/**
 * The Tracearr importer against real Postgres, for the failure modes only the
 * database can show: a page the table refuses, walk state with no rows behind
 * it, degraded attribution being re-labelled, and the evidence marker's
 * compare-and-set against a withdrawal landing mid-run.
 */

const TRACEARR_SERVER_ID = "11111111-2222-3333-4444-555555555555";

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
  invalidateWatchHistoryEvidence,
  restartTracearrBackfill,
} from "@/lib/media/watch-evidence";
import { getTracearrBackfillReach } from "@/lib/sync/tracearr-import-activity";

const prisma = getTestPrisma();
const HOUR = 60 * 60 * 1000;

function record(
  id: string,
  startedAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    reference_id: id,
    server_id: TRACEARR_SERVER_ID,
    media_type: "movie",
    rating_key: "100",
    started_at: startedAt,
    stopped_at: startedAt,
    state: "stopped",
    watched: true,
    user: { id: "u", server_user_id: "acct-1", username: "Walter W" },
    ...extra,
  };
}

let serverId: string;
let mediaItemId: string;

async function serverRow() {
  return prisma.mediaServer.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      tracearrForwardFloorAt: true,
      tracearrBackfillCursorAt: true,
      tracearrBackfillComplete: true,
      tracearrBackfillLastWalkAt: true,
      watchHistorySyncedAt: true,
    },
  });
}

async function storeRow(sourceEventId: string, watchedAt: Date, serverUsername = "walter") {
  await prisma.watchHistory.create({
    data: {
      mediaItemId,
      mediaServerId: serverId,
      serverUsername,
      watchedAt,
      source: "TRACEARR",
      sourceEventId,
      watched: true,
      state: "stopped",
    },
  });
}

describe("Tracearr importer robustness (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    m.getHistoryPage.mockReset();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    mediaItemId = (
      await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" })
    ).id;
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrServerId: TRACEARR_SERVER_ID },
    });
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
      // A record whose INSERT fails on every attempt. Classified as a
      // resumable stop, the slice re-queued itself immediately, resumed at the
      // same position, fetched the same page and failed again — forever.
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
      // Nothing committed, so nothing moved — and the walk is not recorded as
      // having run.
      expect(after.tracearrBackfillCursorAt).toBeNull();
      expect(after.tracearrBackfillLastWalkAt).toBeNull();
      expect(await prisma.watchHistory.count()).toBe(0);
    });

    it("stores a value outside the integer column's range as null instead of failing the page", async () => {
      // The millisecond fields are int64 upstream and `integer` here. One bogus
      // value used to fail its page on every attempt.
      m.getHistoryPage.mockResolvedValueOnce({
        records: [
          record("big", "2024-01-01T00:00:00.000Z", {
            progress_ms: "9999999999",
            duration_ms: 3_000_000_000,
            bitrate: 12_000,
          }),
        ],
        nextCursor: null,
      });

      const result = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(result.backfillOutcome).toBe("exhausted");
      const row = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "big" } });
      expect(row.progressMs).toBeNull();
      expect(row.durationMs).toBeNull();
      expect(row.bitrate).toBe(12_000);
    });

    it("strips NUL characters Postgres refuses, in text and JSON columns alike", async () => {
      m.getHistoryPage.mockResolvedValueOnce({
        records: [
          record("nul", "2024-01-01T00:00:00.000Z", {
            device: "Living\u0000 Room",
            transcode_info: { reason: "bad\u0000value", ["k\u0000ey"]: 1 },
          }),
        ],
        nextCursor: null,
      });

      await syncTracearrHistory(serverId, { passes: "backfill" });

      const row = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "nul" } });
      expect(row.deviceName).toBe("Living Room");
      expect(row.transcodeInfo).toEqual({ reason: "badvalue", key: 1 });
    });
  });

  describe("walk state with no rows behind it is trusted", () => {
    it("keeps walking down an archive whose newest slice held nothing storable", async () => {
      // Every play on the first slice references media not in the library.
      // The cursor it records has no rows behind it, which used to be read as
      // stale and reset — so every slice restarted at the top, forever.
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

      // The next slice is a no-op — it used to restart the archive from the top.
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
    // Every record of a walk run while the server's enabled libraries hold
    // nothing resolves to nothing — by the rows, the same as an archive of
    // since-deleted media, which legitimately completes. Completing here
    // established the marker over an empty history, and once the items synced
    // the library read "nobody watched anything" with no walk left to run.
    const archive = [
      record("old-1", "2023-01-01T00:00:00.000Z"),
      record("old-2", "2024-06-01T00:00:00.000Z"),
    ];

    it("does not complete or vouch for the history, then imports once items appear", async () => {
      // The mapping was saved before the first library sync (and, like any
      // mapping change, cleared the marker).
      await prisma.mediaItem.deleteMany({});
      await prisma.mediaServer.update({ where: { id: serverId }, data: { watchHistorySyncedAt: null } });
      m.getHistoryPage.mockResolvedValue({ records: archive, nextCursor: null });

      const first = await syncTracearrHistory(serverId, { passes: "backfill" });

      // Like an empty mapping: the task does not re-queue on this.
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
      // No cursor deep in the archive for the real walk to resume below.
      expect(before.tracearrBackfillCursorAt).toBeNull();
      expect(before.tracearrBackfillLastWalkAt).toBeNull();

      // The library sync lands; the watch-history sync it ends with queues the
      // next slice.
      const library = await prisma.library.findFirstOrThrow({ where: { mediaServerId: serverId } });
      const film = await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE" });

      const second = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(second).toMatchObject({ count: 2, backfillPending: false, backfillOutcome: "exhausted" });
      expect(await prisma.watchHistory.count({ where: { mediaItemId: film.id } })).toBe(2);
      const after = await serverRow();
      expect(after.tracearrBackfillComplete).toBe(true);
      expect(after.watchHistorySyncedAt).toBeInstanceOf(Date);
    });

    it("treats items only in a DISABLED library as an empty library", async () => {
      await prisma.library.updateMany({ where: { mediaServerId: serverId }, data: { enabled: false } });
      m.getHistoryPage.mockResolvedValue({ records: archive, nextCursor: null });

      const result = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(result).toEqual({
        count: 0,
        backfillPending: true,
        backfillOutcome: "exhausted",
        heldReason: "no-library-items",
      });
      expect((await serverRow()).tracearrBackfillComplete).toBe(false);
      expect(await prisma.watchHistory.count()).toBe(0);
    });

    it("does not re-establish a withdrawn marker or move the forward watermark while empty", async () => {
      // A finished archive whose library was emptied (a purge path that did
      // not restart the walk, a library re-created under a new key).
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
    it("keeps the floor at the degraded walk's since until a healthy walk re-delivers them", async () => {
      const OLD_MAX = new Date("2025-07-10T12:00:00.000Z");
      await storeRow("stored", OLD_MAX);
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: true },
      });
      const since = new Date(OLD_MAX.getTime() - HOUR);

      // Degraded: the account map is down. The window holds a new play (moves
      // MAX) and one just above the old watermark, and the walk exhausts it.
      m.getServerAccountNames.mockRejectedValueOnce(new Error("users down"));
      m.getHistoryPage.mockResolvedValueOnce({
        records: [
          record("newest", "2025-07-20T09:00:00.000Z"),
          record("between", "2025-07-15T09:00:00.000Z"),
        ],
        nextCursor: null,
      });
      await syncTracearrHistory(serverId, { passes: "forward" });

      let row = await serverRow();
      // Recorded and NOT cleared by the degraded walk's own exhaustion.
      expect(row.tracearrForwardFloorAt).toEqual(since);
      expect(row.watchHistorySyncedAt).toBeNull();
      expect(
        (await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "between" } }))
          .serverUsername,
      ).toBe("Walter W");

      // Healthy: its own window would start at NEW_MAX - 1h, above "between";
      // the floor reaches it, and the bridged name overwrites the label.
      m.getHistoryPage.mockReset();
      m.getHistoryPage.mockResolvedValueOnce({
        records: [
          record("newest", "2025-07-20T09:00:00.000Z"),
          record("between", "2025-07-15T09:00:00.000Z"),
        ],
        nextCursor: null,
      });
      await syncTracearrHistory(serverId, { passes: "forward" });

      expect(m.getHistoryPage.mock.calls[0][1].since).toEqual(since);
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
      const OLD_MAX = new Date("2025-07-10T12:00:00.000Z");
      await storeRow("stored", OLD_MAX);
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: true },
      });
      m.getServerAccountNames.mockRejectedValueOnce(new Error("users down"));
      m.getHistoryPage.mockResolvedValueOnce({
        records: [record("overlap", "2025-07-10T11:30:00.000Z")],
        nextCursor: null,
      });

      await syncTracearrHistory(serverId, { passes: "forward" });

      expect((await serverRow()).tracearrForwardFloorAt).toEqual(
        new Date(OLD_MAX.getTime() - HOUR),
      );
    });
  });

  describe("the evidence marker is never written over a withdrawal made mid-run", () => {
    it("a healthy forward run does not re-establish a marker withdrawn while it walked", async () => {
      await storeRow("stored", new Date("2025-07-10T12:00:00.000Z"));
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: true, watchHistorySyncedAt: new Date("2025-07-10") },
      });
      // A degraded Refresh (or a purge) withdraws while this run is paging.
      m.getHistoryPage.mockImplementationOnce(async () => {
        await invalidateWatchHistoryEvidence([serverId]);
        return { records: [], nextCursor: null };
      });

      await syncTracearrHistory(serverId, { passes: "forward" });

      expect((await serverRow()).watchHistorySyncedAt).toBeNull();
    });

    it("also when the marker was already null — the withdrawal changes no column", async () => {
      await storeRow("stored", new Date("2025-07-10T12:00:00.000Z"));
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: true, watchHistorySyncedAt: null },
      });
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

    it("a healthy run with no withdrawal establishes it as before", async () => {
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { watchHistorySyncedAt: null },
      });
      m.getHistoryPage.mockResolvedValueOnce({
        records: [record("only", "2024-01-01T00:00:00.000Z")],
        nextCursor: null,
      });

      await syncTracearrHistory(serverId, { passes: "backfill" });

      expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
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

    it("hides a superseded slice's reach from the live readout while it runs", async () => {
      let reachDuringRun: string | null | undefined;
      m.getHistoryPage
        .mockImplementationOnce(async () => ({
          records: [record("deep", "2019-01-01T00:00:00.000Z")],
          nextCursor: "c2",
        }))
        .mockImplementationOnce(async () => {
          // After page 1 committed, the walk is restarted under the slice.
          expect(getTracearrBackfillReach(serverId)).toBe("2019-01-01T00:00:00.000Z");
          await restartTracearrBackfill([serverId]);
          reachDuringRun = getTracearrBackfillReach(serverId);
          return { records: [record("deeper", "2018-01-01T00:00:00.000Z")], nextCursor: null };
        });

      await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(reachDuringRun).toBeNull();
    });
  });
});
