import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestExternalId, createTestMediaItem } from "../../setup/test-helpers";
import { FakeTracearrArchive, TRACEARR_SERVER_ID, play } from "./fake-tracearr-archive";
import { answerFrom, seedMappedServer, serverRow, storeTracearrPlay, tracearr } from "./tracearr-import-kit";

// An unlink and re-link of the SAME Tracearr server while an import runs. The
// value of `tracearrServerId` comes back unchanged, so every write the importer
// makes also requires the `tracearrMappingVersion` the run read.

vi.mock("@/lib/db", async () => ({ prisma: (await import("../../setup/test-db")).getTestPrisma() }));
vi.mock("@/lib/logger", async () => (await import("./tracearr-import-kit")).loggerModule());
vi.mock("@/lib/tracearr/tracearr-client", async () => (await import("./tracearr-import-kit")).clientModule(2));

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { recoverHistoryForNewItems, resetRecoveryAnswers } from "@/lib/sync/tracearr-backfill-additions";
import { invalidateWatchHistoryEvidence } from "@/lib/media/watch-evidence";
import { retireTracearrImports } from "@/lib/sync/tracearr-import-activity";

const prisma = getTestPrisma();
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);

let archive: FakeTracearrArchive;
let serverId: string;
let itemId: string;
const setServer = (data: Parameters<typeof prisma.mediaServer.update>[0]["data"]) =>
  prisma.mediaServer.update({ where: { id: serverId }, data });

/**
 * What the server PUT does on a change of the mapping: the version bumped, the
 * walk state and marker reset, the rows wiped, then the run retired and (unless
 * `withdraw` is false, to show the version alone holds) the evidence withdrawn.
 */
async function putMapping(tracearrServerId: string | null, withdraw = true) {
  await prisma.$transaction([
    prisma.mediaServer.update({
      where: { id: serverId },
      data: {
        tracearrServerId,
        tracearrMappingVersion: { increment: 1 },
        tracearrBackfillComplete: false,
        tracearrOldestPlayAt: null,
        tracearrBackfillCursorAt: null,
        tracearrForwardFloorAt: null,
        tracearrBackfillLastWalkAt: null,
        tracearrForwardWatermarkAt: null,
        watchHistorySyncedAt: null,
      },
    }),
    prisma.watchHistory.deleteMany({ where: { mediaServerId: serverId } }),
  ]);
  retireTracearrImports(serverId);
  if (withdraw) await invalidateWatchHistoryEvidence([serverId]);
}

/** Unlink, then link the same Tracearr server again. */
async function relink(withdraw = true) {
  await putMapping(null, withdraw);
  await putMapping(TRACEARR_SERVER_ID, withdraw);
}

/** Run `before` once, ahead of the first `mediaServer.updateMany` whose data `matches`. */
async function beforeStateWrite(
  matches: (data: Record<string, unknown>) => boolean,
  before: () => Promise<void>,
  run: () => Promise<unknown>,
) {
  const realUpdateMany = prisma.mediaServer.updateMany.bind(prisma.mediaServer);
  let fired = false;
  const spy = vi.spyOn(prisma.mediaServer, "updateMany").mockImplementation((async (
    args: Parameters<typeof realUpdateMany>[0],
  ) => {
    if (!fired && matches(args.data as Record<string, unknown>)) {
      fired = true;
      await before();
    }
    return realUpdateMany(args);
  }) as never);
  let result: unknown;
  try {
    result = await run();
  } finally {
    spy.mockRestore();
  }
  expect(fired).toBe(true);
  return result;
}

/** A finished archive holding one stored play, ten days old. */
async function walkedWithOnePlay() {
  await storeTracearrPlay(itemId, serverId, "stored", ago(10 * DAY));
  await setServer({ tracearrBackfillComplete: true });
}

describe("an unlink and re-link of the same Tracearr server mid-import (real DB)", () => {
  beforeEach(async () => {
    resetRecoveryAnswers();
    archive = new FakeTracearrArchive();
    answerFrom(() => archive);
    ({ serverId, itemId } = await seedMappedServer());
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("refuses the pages after it, and the slice's cursor, walk stamp and completion", async () => {
    archive.add(play("p1", ago(1 * DAY)), play("p2", ago(2 * DAY)), play("p3", ago(3 * DAY)));
    // Page 1 commits; the re-link lands while page 2 is in flight.
    tracearr.getHistoryPage
      .mockImplementationOnce(async (id: string, options: object) => archive.page(id, options))
      .mockImplementationOnce(async (id: string, options: object) => {
        await relink();
        return archive.page(id, options);
      });

    const result = await syncTracearrHistory(serverId, { passes: "backfill" });

    // A clean stop: the mapping moved, Tracearr did not fail.
    expect(result).toMatchObject({ backfillOutcome: "stopped", backfillPending: true });
    expect(await prisma.watchHistory.count()).toBe(0);
    // The reset stands: the re-linked mapping's walk starts from the top.
    expect(await serverRow(serverId)).toMatchObject({
      tracearrServerId: TRACEARR_SERVER_ID,
      tracearrBackfillComplete: false,
      tracearrBackfillCursorAt: null,
      tracearrBackfillLastWalkAt: null,
      tracearrForwardWatermarkAt: null,
      tracearrOldestPlayAt: null,
      watchHistorySyncedAt: null,
    });
  });

  it.each([
    ["exactly as the PUT does it", true],
    ["with only the version to tell — no evidence withdrawal", false],
  ])("refuses the completion and the marker when the re-link lands just before the state write (%s)", async (_label, withdraw) => {
    // A fresh mapping has no marker either, so the marker's own compare-and-set cannot tell them apart.
    await setServer({ watchHistorySyncedAt: null });
    archive.add(play("p1", ago(1 * DAY)));

    const result = await beforeStateWrite(
      (data) => data.tracearrBackfillComplete === true,
      () => relink(withdraw),
      () => syncTracearrHistory(serverId, { passes: "backfill" }),
    );

    // Owed a fresh walk, and re-queued for one rather than read as empty.
    expect(result).toMatchObject({ backfillOutcome: "exhausted", backfillPending: true, completionLost: true });
    expect(await serverRow(serverId)).toMatchObject({
      tracearrBackfillComplete: false,
      tracearrBackfillCursorAt: null,
      tracearrBackfillLastWalkAt: null,
      watchHistorySyncedAt: null,
    });
  });

  it("refuses the backfill's watermark when the re-link lands before it", async () => {
    archive.add(play("p1", ago(1 * DAY)));
    tracearr.findOldestPlayAt.mockImplementationOnce(async () => {
      await relink();
      return null;
    });

    await syncTracearrHistory(serverId, { passes: "backfill" });

    expect((await serverRow(serverId)).tracearrForwardWatermarkAt).toBeNull();
    expect(await prisma.watchHistory.count()).toBe(0);
  });

  it("refuses a forward walk's floor clear, leaving a floor the re-linked mapping recorded alone", async () => {
    await walkedWithOnePlay();
    await setServer({ tracearrForwardFloorAt: ago(12 * DAY) });
    const newMappingFloor = ago(11 * DAY);
    tracearr.getHistoryPage.mockImplementationOnce(async () => {
      await relink();
      await setServer({ tracearrForwardFloorAt: newMappingFloor });
      // Nothing to write: the walk exhausts and goes on to pay its floor.
      return { records: [], nextCursor: null };
    });

    expect((await syncTracearrHistory(serverId, { passes: "forward" })).failed).toBeUndefined();
    // Same value, floor above this walk's `since`: only the version tells them apart.
    expect((await serverRow(serverId)).tracearrForwardFloorAt).toEqual(newMappingFloor);
  });

  it("refuses to record a floor under the re-linked mapping", async () => {
    await walkedWithOnePlay();
    // A play newer than the stored watermark: the floor is recorded before it is written.
    tracearr.getHistoryPage.mockImplementationOnce(async () => {
      await relink();
      return { records: [play("new", ago(1 * DAY))], nextCursor: null };
    });

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect((await serverRow(serverId)).tracearrForwardFloorAt).toBeNull();
    expect(await prisma.watchHistory.count()).toBe(0);
  });

  it("does not hand the re-linked mapping the old run's forward watermark", async () => {
    // A finished no-rows archive: the forward walk records the watermark
    // compare-and-set on the null it read, which the re-link's reset matches.
    await setServer({ tracearrBackfillComplete: true, tracearrBackfillLastWalkAt: ago(2 * DAY) });
    tracearr.getHistoryPage.mockImplementationOnce(async () => {
      await relink();
      return { records: [], nextCursor: null };
    });

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect((await serverRow(serverId)).tracearrForwardWatermarkAt).toBeNull();
  });

  it("does not delete native history written under the re-linked mapping", async () => {
    await walkedWithOnePlay();
    archive.add(play("new", ago(1 * DAY)));

    // Right before the marker release (and the native-stratum cleanup after it).
    await beforeStateWrite(
      (data) => "watchHistorySyncedAt" in data,
      async () => {
        await relink(false);
        await prisma.watchHistory.create({
          data: { mediaItemId: itemId, mediaServerId: serverId, serverUsername: "walter", watchedAt: new Date() },
        });
      },
      () => syncTracearrHistory(serverId, { passes: "forward" }),
    );

    expect(await prisma.watchHistory.count({ where: { source: "NATIVE" } })).toBe(1);
    expect((await serverRow(serverId)).watchHistorySyncedAt).toBeNull();
  });

  it("writes everything as before while the version holds", async () => {
    await setServer({ watchHistorySyncedAt: null, tracearrMappingVersion: 3 });
    archive.add(play("p1", ago(1 * DAY)), play("p2", ago(2 * DAY)), play("p3", ago(3 * DAY)));

    const result = await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(result).toMatchObject({ count: 3, backfillOutcome: "exhausted", backfillPending: false });
    expect(await serverRow(serverId)).toMatchObject({
      tracearrBackfillComplete: true,
      tracearrBackfillCursorAt: ago(3 * DAY),
      tracearrBackfillLastWalkAt: expect.any(Date),
      tracearrForwardWatermarkAt: expect.any(Date),
      tracearrOldestPlayAt: ago(3 * DAY),
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  describe("the recovery pass for re-added items", () => {
    beforeEach(async () => {
      await setServer({ tracearrBackfillComplete: true });
      await prisma.mediaItem.update({ where: { id: itemId }, data: { createdAt: new Date(NOW - DAY) } });
      await createTestExternalId(itemId, "TMDB", "603");
    });

    it("writes nothing once the mapping has been re-linked under it", async () => {
      // A second, older addition — asked about after the first, if at all.
      const library = await prisma.library.findFirstOrThrow({ where: { mediaServerId: serverId } });
      const second = await createTestMediaItem(library.id, { ratingKey: "200", type: "MOVIE", title: "Heat" });
      await prisma.mediaItem.update({ where: { id: second.id }, data: { createdAt: new Date(NOW - 2 * DAY) } });
      tracearr.getHistoryForItem.mockImplementationOnce(async () => {
        await relink();
        return [play("old-1", ago(400 * DAY)), play("old-2", ago(300 * DAY))];
      });

      expect((await recoverHistoryForNewItems(serverId)).imported).toBe(0);
      expect(await prisma.watchHistory.count()).toBe(0);
      // It stopped at the refused write: the next candidate was never asked.
      const asked = tracearr.getHistoryForItem.mock.calls.map((call) => (call[1] as { ratingKey?: string }).ratingKey);
      expect(asked).toContain("100");
      expect(asked).not.toContain("200");
    });

    it("does nothing for a re-linked mapping whose archive walk has not run yet", async () => {
      // Written now, an old recovered play would become the new archive's resume point.
      await relink();
      tracearr.getHistoryForItem.mockResolvedValue([play("old-1", ago(400 * DAY))]);

      expect(await recoverHistoryForNewItems(serverId)).toEqual({ checked: 0, imported: 0 });
      expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();
      expect(await prisma.watchHistory.count()).toBe(0);
    });

    it("recovers as before while the version holds", async () => {
      tracearr.getHistoryForItem.mockImplementation(async (_id: string, filter: { ratingKey?: string }) =>
        filter.ratingKey ? [] : [play("old-1", ago(400 * DAY), { rating_key: "999", tmdb_id: 603 })],
      );

      expect((await recoverHistoryForNewItems(serverId)).imported).toBe(1);
      expect(await prisma.watchHistory.count({ where: { sourceEventId: "old-1", mediaItemId: itemId } })).toBe(1);
    });
  });
});
