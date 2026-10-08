import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestServer } from "../../setup/test-helpers";

// The library-resync hold against real Postgres: what is written, what the releases release, and no marker past it.

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  markWatchHistoryEstablished,
  markWatchHistoryEstablishedIfUnchanged,
  releaseLibraryResyncHold,
  releaseOwnPopulationHold,
  requireLibraryResync,
  requirePopulationResync,
  snapshotWatchEvidence,
} from "@/lib/media/watch-evidence";

const prisma = getTestPrisma();
const TRACEARR_SERVER_ID = "11111111-2222-3333-4444-555555555555";

const row = (id: string) =>
  prisma.mediaServer.findUniqueOrThrow({
    where: { id },
    select: {
      libraryResyncRequiredAt: true,
      watchHistorySyncedAt: true,
      tracearrBackfillComplete: true,
      tracearrBackfillCursorAt: true,
      tracearrForwardWatermarkAt: true,
      tracearrForwardFloorAt: true,
      tracearrForwardFloorRecordedAt: true,
      tracearrBackfillLastWalkAt: true,
    },
  });

const setHold = (id: string, at: Date | null) =>
  prisma.mediaServer.update({ where: { id }, data: { libraryResyncRequiredAt: at } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` while a second connection holds the server row `FOR UPDATE`; `fn` commits. */
async function whileRowLocked(serverId: string, fn: (other: PoolClient) => Promise<void>) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  const other = await pool.connect();
  try {
    await other.query("BEGIN");
    await other.query(`SELECT 1 FROM "MediaServer" WHERE "id" = $1 FOR UPDATE`, [serverId]);
    await fn(other);
  } finally {
    other.release();
    await pool.end();
  }
}

describe("library-resync hold (real DB)", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    userId = (await createTestUser()).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("requireLibraryResync", () => {
    it("holds the server, withdraws its marker, restarts a mapped server's walk, and leaves others alone", async () => {
      const native = await createTestServer(userId, { name: "Native" });
      const other = await createTestServer(userId, { name: "Other" });
      const mapped = await createTestServer(userId, {
        name: "Mapped",
        tracearrServerId: TRACEARR_SERVER_ID,
        tracearrBackfillComplete: true,
      });
      await prisma.mediaServer.update({
        where: { id: mapped.id },
        data: {
          tracearrBackfillCursorAt: new Date("2019-01-01T00:00:00Z"),
          tracearrForwardFloorAt: new Date("2026-01-01T00:00:00Z"),
          tracearrForwardFloorRecordedAt: new Date("2026-01-01T01:00:00Z"),
          tracearrBackfillLastWalkAt: new Date("2026-01-02T00:00:00Z"),
        },
      });
      const before = Date.now();

      await requireLibraryResync([native.id, mapped.id]);

      const n = await row(native.id);
      expect(n.libraryResyncRequiredAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(n.watchHistorySyncedAt).toBeNull();
      // Unmapped: no Tracearr state to restart.
      expect(n.tracearrBackfillCursorAt).toBeNull();
      expect(n.tracearrForwardWatermarkAt).toBeNull();

      const t = await row(mapped.id);
      expect(t.libraryResyncRequiredAt).not.toBeNull();
      expect(t.watchHistorySyncedAt).toBeNull();
      expect(t.tracearrBackfillComplete).toBe(false);
      // Restarted from the newest play: cursor and watermark both ≈ now.
      expect(t.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(t.tracearrForwardWatermarkAt).toEqual(t.tracearrBackfillCursorAt);
      expect(t.tracearrForwardFloorAt).toBeNull();
      expect(t.tracearrForwardFloorRecordedAt).toBeNull();
      expect(t.tracearrBackfillLastWalkAt).toBeNull();

      const o = await row(other.id);
      expect(o.libraryResyncRequiredAt).toBeNull();
      expect(o.watchHistorySyncedAt).not.toBeNull();
    });

    it("keeps the earliest hold still unreleased — a later request leaves the column as it was", async () => {
      // Moved later, the hold would make a half-populated library read as untouched.
      const server = await createTestServer(userId);
      const earlier = new Date(Date.now() - 60_000);
      await setHold(server.id, earlier);

      await requireLibraryResync([server.id]);
      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(earlier);

      // The later request still refuses a sync whose pass began before it.
      await expect(releaseLibraryResyncHold(server.id, new Date(Date.now() - 1_000))).resolves.toBe(false);
      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(earlier);
      await expect(releaseLibraryResyncHold(server.id, new Date())).resolves.toBe(true);
    });

    it("writes a given instant where no hold exists and keeps any existing one", async () => {
      const unset = await createTestServer(userId, { name: "Unset" });
      const later = await createTestServer(userId, { name: "Later" });
      const earlier = await createTestServer(userId, { name: "Earlier" });
      const passStart = new Date(Date.now() - 30_000);
      const purgeMidRun = new Date(passStart.getTime() + 10_000);
      const purgeBefore = new Date(passStart.getTime() - 10_000);
      await setHold(later.id, purgeMidRun);
      await setHold(earlier.id, purgeBefore);

      await requireLibraryResync([unset.id, later.id, earlier.id], { at: passStart });

      expect((await row(unset.id)).libraryResyncRequiredAt).toEqual(passStart);
      // Moved back to the pass start, a hold set while the sync ran would be released by it.
      expect((await row(later.id)).libraryResyncRequiredAt).toEqual(purgeMidRun);
      expect((await row(earlier.id)).libraryResyncRequiredAt).toEqual(purgeBefore);
      for (const id of [unset.id, later.id, earlier.id]) {
        expect((await row(id)).watchHistorySyncedAt).toBeNull();
      }
    });
  });

  describe("no marker gets past a hold", () => {
    it("markWatchHistoryEstablished skips a held server and marks the rest", async () => {
      const held = await createTestServer(userId, { name: "Held", watchHistorySyncedAt: null });
      const free = await createTestServer(userId, { name: "Free", watchHistorySyncedAt: null });
      await setHold(held.id, new Date());

      await expect(markWatchHistoryEstablished([held.id, free.id])).resolves.toBe(1);

      expect((await row(held.id)).watchHistorySyncedAt).toBeNull();
      expect((await row(free.id)).watchHistorySyncedAt).not.toBeNull();
    });

    it("markWatchHistoryEstablishedIfUnchanged refuses while held, even from a snapshot taken after the hold", async () => {
      const server = await createTestServer(userId, { watchHistorySyncedAt: null });
      await requireLibraryResync([server.id]);
      // Generation and marker both match: only the hold itself stops it.
      const snapshot = snapshotWatchEvidence(server.id, null);

      await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(false);

      expect((await row(server.id)).watchHistorySyncedAt).toBeNull();
    });
  });

  describe("releaseLibraryResyncHold", () => {
    it("releases a hold set at or before the pass start and nulls the marker in the same write", async () => {
      const server = await createTestServer(userId);
      const passStart = new Date();
      // Exactly the pass start: a sync's own population hold must be releasable by it.
      await setHold(server.id, passStart);
      // A marker that got through somehow must not be left vouching for the gap.
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { watchHistorySyncedAt: new Date() },
      });

      await expect(releaseLibraryResyncHold(server.id, passStart)).resolves.toBe(true);

      const r = await row(server.id);
      expect(r.libraryResyncRequiredAt).toBeNull();
      expect(r.watchHistorySyncedAt).toBeNull();
    });

    it("refuses the marker of a pass whose snapshot predates the release; a pass started after it establishes", async () => {
      const server = await createTestServer(userId, { watchHistorySyncedAt: null });
      await requireLibraryResync([server.id]);
      const older = snapshotWatchEvidence(server.id, null);

      await expect(releaseLibraryResyncHold(server.id, new Date())).resolves.toBe(true);

      await expect(markWatchHistoryEstablishedIfUnchanged(older)).resolves.toBe(false);
      expect((await row(server.id)).watchHistorySyncedAt).toBeNull();
      const newer = snapshotWatchEvidence(server.id, (await row(server.id)).watchHistorySyncedAt);
      await expect(markWatchHistoryEstablishedIfUnchanged(newer)).resolves.toBe(true);
      expect((await row(server.id)).watchHistorySyncedAt).not.toBeNull();
    });

    it("loses to a hold another writer changed while it was releasing — the write compares the instant", async () => {
      const server = await createTestServer(userId);
      const passStart = new Date();
      await setHold(server.id, new Date(passStart.getTime() - 1_000));
      const later = new Date(passStart.getTime() + 60_000);
      await whileRowLocked(server.id, async (other) => {
        // The release reads the row (not blocked), then waits on the lock for its write.
        const release = releaseLibraryResyncHold(server.id, passStart);
        await sleep(300);
        await other.query(`UPDATE "MediaServer" SET "libraryResyncRequiredAt" = $2::timestamp WHERE "id" = $1`, [
          server.id,
          later.toISOString().replace("Z", ""),
        ]);
        await other.query("COMMIT");

        await expect(release).resolves.toBe(false);
      });
      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(later);
    });

    it("puts back a hold a purge requested while its write was waiting, and reports no release", async () => {
      // The purge leaves the earlier hold in place; the release's write would erase the only record of it.
      const server = await createTestServer(userId, { watchHistorySyncedAt: null });
      const passStart = new Date();
      const heldAt = new Date(passStart.getTime() - 60_000);
      await setHold(server.id, heldAt);
      let purgedAt = 0;
      await whileRowLocked(server.id, async (other) => {
        const release = releaseLibraryResyncHold(server.id, passStart);
        await sleep(300);
        // Matches no row, so it must not wait on the lock; bounded so a regression fails instead of deadlocking.
        purgedAt = Date.now();
        const purge = requireLibraryResync([server.id]);
        const landed = await Promise.race([purge.then(() => true), sleep(2_000).then(() => false)]);
        expect((await row(server.id)).libraryResyncRequiredAt).toEqual(heldAt);
        await other.query("COMMIT");
        await purge;
        expect(landed).toBe(true);

        await expect(release).resolves.toBe(false);
      });
      const hold = (await row(server.id)).libraryResyncRequiredAt;
      expect(hold).not.toBeNull();
      expect(hold!.getTime()).toBeGreaterThanOrEqual(purgedAt - 5);
      expect((await row(server.id)).watchHistorySyncedAt).toBeNull();
      // ...and the next pass that begins after the purge can release it.
      await expect(releaseLibraryResyncHold(server.id, new Date())).resolves.toBe(true);
    });
  });

  describe("a population hold a sync took itself", () => {
    it("is released by its own receipt when nothing touched it; only a pass started after that establishes", async () => {
      const server = await createTestServer(userId, { watchHistorySyncedAt: null });
      const receipt = await requirePopulationResync(server.id, new Date());
      const older = snapshotWatchEvidence(server.id, null);
      // A marker that got through somehow must not be left vouching for the gap.
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { watchHistorySyncedAt: new Date() },
      });

      await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(true);

      const r = await row(server.id);
      expect(r.libraryResyncRequiredAt).toBeNull();
      expect(r.watchHistorySyncedAt).toBeNull();
      await expect(markWatchHistoryEstablishedIfUnchanged(older)).resolves.toBe(false);
      expect((await row(server.id)).watchHistorySyncedAt).toBeNull();
      await expect(
        markWatchHistoryEstablishedIfUnchanged(snapshotWatchEvidence(server.id, null)),
      ).resolves.toBe(true);
    });

    it("is not released once another writer moved the hold, though no withdrawal was counted here", async () => {
      const server = await createTestServer(userId);
      const passStart = new Date();
      const receipt = await requirePopulationResync(server.id, passStart);
      const later = new Date(passStart.getTime() + 60_000);
      await setHold(server.id, later);

      await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(false);

      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(later);
    });

  });
});
