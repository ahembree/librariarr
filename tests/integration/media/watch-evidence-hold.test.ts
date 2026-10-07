import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestServer } from "../../setup/test-helpers";

/**
 * The library-resync hold (`MediaServer.libraryResyncRequiredAt`) against real
 * Postgres: what `requireLibraryResync` writes, what `releaseLibraryResyncHold`
 * releases, that no marker write gets past a hold, and how the evaluability
 * guard reads it alongside its other clauses.
 *
 * The hold says "some of this server's media rows are known to be missing and
 * only a complete library sync brings them back". While it is set, a history
 * pass cannot have attached the missing items' plays, so a marker it wrote
 * would vouch for a hole — and negative `watchedByUser`, `playCount = 0` and
 * "not played in N months" DELETE rules match exactly those items.
 */

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
  invalidateServersWithoutWatchHistory,
  markWatchHistoryEstablished,
  markWatchHistoryEstablishedIfUnchanged,
  releaseLibraryResyncHold,
  releaseOwnPopulationHold,
  requireLibraryResync,
  requirePopulationResync,
  restartTracearrBackfill,
  snapshotWatchEvidence,
} from "@/lib/media/watch-evidence";
import { checkWatchHistoryCompleteness } from "@/lib/lifecycle/evaluability";

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
    it("holds the server, withdraws its marker, and restarts a mapped server's walk", async () => {
      const native = await createTestServer(userId, { name: "Native" });
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
    });

    it("leaves other servers alone", async () => {
      const held = await createTestServer(userId, { name: "Held" });
      const other = await createTestServer(userId, { name: "Other" });

      await requireLibraryResync([held.id]);

      const o = await row(other.id);
      expect(o.libraryResyncRequiredAt).toBeNull();
      expect(o.watchHistorySyncedAt).not.toBeNull();
    });

    it("keeps the earliest hold still unreleased — a later request leaves the column as it was", async () => {
      // The instant is what tells the libraries a hold waits for (none of
      // their items is older) from the ones its cause left alone. A library a
      // failed sync half populated after the first hold holds only items newer
      // than it; moved to a later request, the hold would make them read as
      // older — a library nothing touched — and a release could leave it short.
      const server = await createTestServer(userId);
      const earlier = new Date(Date.now() - 60_000);
      await setHold(server.id, earlier);

      await requireLibraryResync([server.id]);
      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(earlier);

      // The later request still counts: a sync whose pass began before it may
      // have passed the library it concerns, so that sync cannot release.
      await expect(releaseLibraryResyncHold(server.id, new Date(Date.now() - 1_000))).resolves.toBe(false);
      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(earlier);
      // A sync whose pass began after it can.
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
      // A hold set while the sync ran must not be moved back to its pass start —
      // that sync would then release it.
      expect((await row(later.id)).libraryResyncRequiredAt).toEqual(purgeMidRun);
      expect((await row(earlier.id)).libraryResyncRequiredAt).toEqual(purgeBefore);
      // The marker is withdrawn on every one of them regardless.
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
      // Taken AFTER the hold: the generation matches, the marker matches — only
      // the hold itself stops it (a native full replace that ran before the
      // purged items were re-added).
      const snapshot = snapshotWatchEvidence(server.id, null);

      await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(false);

      expect((await row(server.id)).watchHistorySyncedAt).toBeNull();
    });

    it("establishes again once the hold is released, for a pass started after the release", async () => {
      const server = await createTestServer(userId, { watchHistorySyncedAt: null });
      await requireLibraryResync([server.id]);
      const passStart = new Date();

      await expect(releaseLibraryResyncHold(server.id, passStart)).resolves.toBe(true);
      const snapshot = snapshotWatchEvidence(server.id, (await row(server.id)).watchHistorySyncedAt);

      await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(true);
      expect((await row(server.id)).watchHistorySyncedAt).not.toBeNull();
    });
  });

  describe("releaseLibraryResyncHold", () => {
    it("releases a hold set at or before the pass start and nulls the marker in the same write", async () => {
      const server = await createTestServer(userId);
      const passStart = new Date();
      // Exactly the pass start: the population hold a sync takes at its own
      // pass start must be releasable by that same sync.
      await setHold(server.id, passStart);
      // A marker that got through somehow (an importer predating the hold
      // check): the release must not leave it vouching for the gap.
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { watchHistorySyncedAt: new Date() },
      });

      await expect(releaseLibraryResyncHold(server.id, passStart)).resolves.toBe(true);

      const r = await row(server.id);
      expect(r.libraryResyncRequiredAt).toBeNull();
      expect(r.watchHistorySyncedAt).toBeNull();
    });

    it("keeps a hold set after the pass started — the sync may have passed the purged library already", async () => {
      const server = await createTestServer(userId);
      const passStart = new Date(Date.now() - 1_000);
      const hold = new Date(passStart.getTime() + 1);
      await setHold(server.id, hold);

      await expect(releaseLibraryResyncHold(server.id, passStart)).resolves.toBe(false);

      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(hold);
    });

    it("changes nothing on a server with no hold — an established marker stays", async () => {
      const established = new Date("2026-02-01T00:00:00Z");
      const server = await createTestServer(userId, { watchHistorySyncedAt: established });
      const snapshot = snapshotWatchEvidence(server.id, established);

      await expect(releaseLibraryResyncHold(server.id, new Date())).resolves.toBe(false);

      expect((await row(server.id)).watchHistorySyncedAt).toEqual(established);
      // No withdrawal was counted either: a sync in flight still establishes.
      await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(true);
    });

    it("loses to a hold another writer changed while it was releasing — the write compares the instant", async () => {
      // Another process (or a hand edit) rewrote the column between the
      // release's read and its write: the write must not clear a hold it never
      // judged.
      const server = await createTestServer(userId);
      const passStart = new Date();
      await setHold(server.id, new Date(passStart.getTime() - 1_000));
      const later = new Date(passStart.getTime() + 60_000);
      const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
      const other = await pool.connect();
      try {
        await other.query("BEGIN");
        await other.query(`SELECT 1 FROM "MediaServer" WHERE "id" = $1 FOR UPDATE`, [server.id]);
        const release = releaseLibraryResyncHold(server.id, passStart);
        // The release reads the row (a plain read is not blocked), then waits
        // on the row lock for its write.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await other.query(`UPDATE "MediaServer" SET "libraryResyncRequiredAt" = $2::timestamp WHERE "id" = $1`, [
          server.id,
          later.toISOString().replace("Z", ""),
        ]);
        await other.query("COMMIT");

        await expect(release).resolves.toBe(false);
      } finally {
        other.release();
        await pool.end();
      }
      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(later);
    });

    it("puts back a hold a purge requested while its write was waiting, and reports no release", async () => {
      // The purge finds the column still set and leaves it (the column keeps
      // the earliest request), then deletes its library's items; the release's
      // write, landing after, would clear the only record of that purge.
      const server = await createTestServer(userId, { watchHistorySyncedAt: null });
      const passStart = new Date();
      const heldAt = new Date(passStart.getTime() - 60_000);
      await setHold(server.id, heldAt);
      const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
      const other = await pool.connect();
      let purgedAt = 0;
      try {
        await other.query("BEGIN");
        await other.query(`SELECT 1 FROM "MediaServer" WHERE "id" = $1 FOR UPDATE`, [server.id]);
        const release = releaseLibraryResyncHold(server.id, passStart);
        // The release has read the row and is waiting on the lock for its write.
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Matches no row (the hold is set), so it does not wait on the lock —
        // bounded all the same, so a regression that made it wait fails here
        // instead of deadlocking the suite behind the lock held above.
        purgedAt = Date.now();
        const purge = requireLibraryResync([server.id]);
        const landed = await Promise.race([
          purge.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
        ]);
        expect((await row(server.id)).libraryResyncRequiredAt).toEqual(heldAt);
        await other.query("COMMIT");
        await purge;
        expect(landed).toBe(true);

        await expect(release).resolves.toBe(false);
      } finally {
        other.release();
        await pool.end();
      }
      const hold = (await row(server.id)).libraryResyncRequiredAt;
      expect(hold).not.toBeNull();
      expect(hold!.getTime()).toBeGreaterThanOrEqual(purgedAt - 5);
      expect((await row(server.id)).watchHistorySyncedAt).toBeNull();
      // ...and the next pass that begins after the purge can release it.
      await expect(releaseLibraryResyncHold(server.id, new Date())).resolves.toBe(true);
    });

    it("refuses the marker write of a pass whose snapshot predates the release", async () => {
      // That pass may have built its item map before the re-added items
      // existed, so its marker would vouch for plays it could not attach.
      const server = await createTestServer(userId, { watchHistorySyncedAt: null });
      await requireLibraryResync([server.id]);
      const older = snapshotWatchEvidence(server.id, null);

      await releaseLibraryResyncHold(server.id, new Date());

      await expect(markWatchHistoryEstablishedIfUnchanged(older)).resolves.toBe(false);
      expect((await row(server.id)).watchHistorySyncedAt).toBeNull();
    });
  });

  describe("a population hold a sync took itself", () => {
    it("gets a receipt only when it wrote the hold, and leaves an existing hold as it was", async () => {
      const fresh = await createTestServer(userId, { name: "Fresh" });
      const purged = await createTestServer(userId, { name: "Purged" });
      const passStart = new Date();
      const purgeHold = new Date(passStart.getTime() - 5_000);
      await setHold(purged.id, purgeHold);

      const receipt = await requirePopulationResync(fresh.id, passStart);
      const none = await requirePopulationResync(purged.id, passStart);

      expect(receipt).toMatchObject({ serverId: fresh.id, at: passStart });
      expect((await row(fresh.id)).libraryResyncRequiredAt).toEqual(passStart);
      expect(none).toBeNull();
      expect((await row(purged.id)).libraryResyncRequiredAt).toEqual(purgeHold);
      // Both withdrew the marker all the same.
      expect((await row(fresh.id)).watchHistorySyncedAt).toBeNull();
      expect((await row(purged.id)).watchHistorySyncedAt).toBeNull();
    });

    it("is released by its own receipt when nothing touched it", async () => {
      const server = await createTestServer(userId);
      const receipt = await requirePopulationResync(server.id, new Date());
      // A marker that got through somehow (a writer predating the hold check):
      // the release must not leave it vouching for the gap.
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { watchHistorySyncedAt: new Date() },
      });

      await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(true);

      const r = await row(server.id);
      expect(r.libraryResyncRequiredAt).toBeNull();
      expect(r.watchHistorySyncedAt).toBeNull();
      // A history pass started after the release establishes the marker.
      await expect(
        markWatchHistoryEstablishedIfUnchanged(snapshotWatchEvidence(server.id, null)),
      ).resolves.toBe(true);
    });

    it("is not released after a purge landed at the very same instant", async () => {
      // A purge's hold at an instant equal to this one leaves the column as it
      // was, so equality alone would release the purge's hold: the withdrawal
      // it counted is what refuses.
      const server = await createTestServer(userId);
      const passStart = new Date();
      const receipt = await requirePopulationResync(server.id, passStart);
      await requireLibraryResync([server.id], { at: passStart });
      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(passStart);

      await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(false);

      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(passStart);
    });

    it("is not released once another writer moved the hold, though no withdrawal was counted here", async () => {
      // Another process (or a hand edit) moved the column: the compare-and-set
      // on the exact instant refuses.
      const server = await createTestServer(userId);
      const passStart = new Date();
      const receipt = await requirePopulationResync(server.id, passStart);
      const later = new Date(passStart.getTime() + 60_000);
      await setHold(server.id, later);

      await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(false);

      expect((await row(server.id)).libraryResyncRequiredAt).toEqual(later);
    });

    it("is not released after a restore rewrote the database", async () => {
      const server = await createTestServer(userId);
      const receipt = await requirePopulationResync(server.id, new Date());
      await invalidateServersWithoutWatchHistory();

      await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(false);
      expect((await row(server.id)).libraryResyncRequiredAt).not.toBeNull();
    });

    it("refuses the marker of a history pass whose snapshot predates the release", async () => {
      const server = await createTestServer(userId, { watchHistorySyncedAt: null });
      const receipt = await requirePopulationResync(server.id, new Date());
      const older = snapshotWatchEvidence(server.id, null);

      await releaseOwnPopulationHold(receipt!);

      await expect(markWatchHistoryEstablishedIfUnchanged(older)).resolves.toBe(false);
      expect((await row(server.id)).watchHistorySyncedAt).toBeNull();
    });
  });

  describe("restartTracearrBackfill", () => {
    it("restarts the walk without holding anything", async () => {
      // Restore's "items present, Tracearr rows missing" case calls it directly:
      // the items exist, so the walk may run at once.
      const server = await createTestServer(userId, {
        tracearrServerId: TRACEARR_SERVER_ID,
        tracearrBackfillComplete: true,
      });
      const before = Date.now();

      await expect(restartTracearrBackfill([server.id])).resolves.toBe(1);

      const r = await row(server.id);
      expect(r.libraryResyncRequiredAt).toBeNull();
      expect(r.tracearrBackfillComplete).toBe(false);
      expect(r.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(r.tracearrForwardWatermarkAt).toEqual(r.tracearrBackfillCursorAt);
      // The marker is not its business.
      expect(r.watchHistorySyncedAt).not.toBeNull();
    });
  });

  describe("checkWatchHistoryCompleteness", () => {
    const refusal = async (serverIds: string[]) => {
      const result = await checkWatchHistoryCompleteness(userId, serverIds);
      if (result.complete) throw new Error("expected a refusal");
      return result.reason;
    };

    it("refuses a held server even while its marker still reads established, and says to run a full sync", async () => {
      const server = await createTestServer(userId, { name: "Held" });
      await setHold(server.id, new Date());

      const reason = await refusal([server.id]);
      expect(reason).toContain(
        '"Held" (some of its media was removed in bulk or is being added for the first time — ' +
          "a purge, a restore, or a library's first sync — and play history waits for a complete " +
          "library sync of this server; run Sync on it under Settings → Servers, and if this stays, " +
          "System Logs name the library it is still waiting for)",
      );
    });

    it("names the hold before a withdrawn marker, a forward gap or an unfinished import", async () => {
      const server = await createTestServer(userId, {
        name: "All four",
        watchHistorySyncedAt: null,
        tracearrServerId: TRACEARR_SERVER_ID,
        tracearrBackfillComplete: false,
      });
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { libraryResyncRequiredAt: new Date(), tracearrForwardFloorAt: new Date() },
      });

      const reason = await refusal([server.id]);
      expect(reason).toMatch(/run Sync on it under Settings → Servers/);
      // A mapped server is told the restarted import comes after that sync.
      expect(reason).toMatch(/after that sync, the Tracearr history import it restarted has to read back/);
      expect(reason).not.toMatch(/no sync has established|reading recent plays|not finished walking/);
    });

    it("names an unfinished import before a withdrawn marker — what a mapped server shows after a release", async () => {
      // The release nulled the marker and the walk it restarted is running:
      // only that walk's completion re-establishes the marker, so a refusal
      // saying "run a Refresh" would send the user to a sync that cannot help.
      const server = await createTestServer(userId, {
        name: "Restarted",
        watchHistorySyncedAt: null,
        tracearrServerId: TRACEARR_SERVER_ID,
        tracearrBackfillComplete: false,
      });
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrForwardFloorAt: new Date() },
      });

      const reason = await refusal([server.id]);
      expect(reason).toMatch(/"Restarted" \(its Tracearr history import has not finished walking back/);
      expect(reason).not.toMatch(/no sync has established|reading recent plays|Refresh/);
    });

    it("names a withdrawn marker before a forward gap once the walk has finished", async () => {
      const server = await createTestServer(userId, {
        name: "Gap",
        watchHistorySyncedAt: null,
        tracearrServerId: TRACEARR_SERVER_ID,
        tracearrBackfillComplete: true,
      });
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrForwardFloorAt: new Date() },
      });

      const reason = await refusal([server.id]);
      expect(reason).toMatch(/no sync has established/);
      expect(reason).not.toMatch(/reading recent plays/);
    });

    it("refuses a mapped server while a forward import reads recent plays, though its marker stands and its walk is complete", async () => {
      // The importer records the floor before every forward walk's first page
      // with a new play and clears it when the walk ends; an interrupted walk
      // leaves it. Either way the plays past it are unread, and the reason
      // says so without calling a healthy import interrupted.
      const server = await createTestServer(userId, {
        name: "Gap",
        tracearrServerId: TRACEARR_SERVER_ID,
        tracearrBackfillComplete: true,
      });
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrForwardFloorAt: new Date("2026-09-01T00:00:00Z") },
      });

      const reason = await refusal([server.id]);
      expect(reason).toContain(
        '"Gap" (a Tracearr import is reading recent plays, or one was interrupted before it finished; ' +
          "this clears when that import completes — the next watch-history sync resumes an interrupted one)",
      );
    });

    it("names an unfinished import before a forward gap", async () => {
      const server = await createTestServer(userId, {
        name: "Both",
        tracearrServerId: TRACEARR_SERVER_ID,
        tracearrBackfillComplete: false,
      });
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrForwardFloorAt: new Date() },
      });

      const reason = await refusal([server.id]);
      expect(reason).toMatch(/not finished walking/);
      expect(reason).not.toMatch(/reading recent plays/);
    });

    it("ignores a forward floor on an unmapped server", async () => {
      // The column belongs to the Tracearr importer; an unlink clears it, and a
      // stray value on a native server describes nothing.
      const server = await createTestServer(userId, { name: "Native" });
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrForwardFloorAt: new Date() },
      });

      await expect(checkWatchHistoryCompleteness(userId, [server.id])).resolves.toEqual({
        complete: true,
      });
    });

    it("ignores a held server outside the scope, and a disabled one", async () => {
      const inScope = await createTestServer(userId, { name: "In scope" });
      const outOfScope = await createTestServer(userId, { name: "Elsewhere" });
      const disabled = await createTestServer(userId, { name: "Off", enabled: false });
      await setHold(outOfScope.id, new Date());
      await setHold(disabled.id, new Date());

      await expect(checkWatchHistoryCompleteness(userId, [inScope.id])).resolves.toEqual({
        complete: true,
      });
      await expect(checkWatchHistoryCompleteness(userId, [inScope.id, disabled.id])).resolves.toEqual({
        complete: true,
      });
      const reason = await refusal([]);
      expect(reason).toContain('"Elsewhere"');
      expect(reason).not.toContain('"Off"');
    });

    it("is complete again once the hold is released and a sync establishes the marker", async () => {
      const server = await createTestServer(userId, { name: "Purged" });
      await requireLibraryResync([server.id]);
      await refusal([server.id]);

      await releaseLibraryResyncHold(server.id, new Date());
      // Released, but the marker is still withdrawn: the next history sync
      // is what establishes it.
      expect(await refusal([server.id])).toMatch(/no sync has established/);

      await markWatchHistoryEstablished([server.id]);
      await expect(checkWatchHistoryCompleteness(userId, [server.id])).resolves.toEqual({
        complete: true,
      });
    });
  });
});
