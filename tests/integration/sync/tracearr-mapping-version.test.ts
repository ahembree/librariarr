import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
} from "../../setup/test-helpers";
import { FakeTracearrArchive, TRACEARR_SERVER_ID, play } from "./fake-tracearr-archive";

/**
 * An unlink and re-link of the SAME Tracearr server while an import runs.
 *
 * The server PUT wipes the server's rows and resets the walk state on every
 * change of the mapping — twice here — and leaves `tracearrServerId` with the
 * value it had. Every write the importer made was guarded on that value alone,
 * so a slice that started before the two passed every guard afterwards: its
 * pages landed after the wipe, and its deep cursor (or its completion, and the
 * evidence marker with it) landed over the reset, so the re-linked mapping's
 * archive was never walked. The PUT bumps `tracearrMappingVersion` on every
 * change, and every write now requires the version the run read too.
 *
 * Real Postgres; Tracearr is a fake of its history keyset. `relink()` does to
 * the row what the PUT does, twice.
 */

const m = vi.hoisted(() => ({
  getHistoryPage: vi.fn(),
  getHistoryForItem: vi.fn(),
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
  MAX_PAGE_SIZE: 2,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getHistoryPage = m.getHistoryPage;
    this.getHistoryForItem = m.getHistoryForItem;
    this.listServers = m.listServers;
    this.getServerAccountNames = m.getServerAccountNames;
    this.findOldestPlayAt = m.findOldestPlayAt;
  },
}));

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import {
  recoverHistoryForNewItems,
  resetRecoveryAnswers,
} from "@/lib/sync/tracearr-backfill-additions";
import { invalidateWatchHistoryEvidence } from "@/lib/media/watch-evidence";
import { retireTracearrImports } from "@/lib/sync/tracearr-import-activity";

const prisma = getTestPrisma();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);

let archive: FakeTracearrArchive;
let serverId: string;
let itemId: string;

async function serverRow() {
  return prisma.mediaServer.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      tracearrServerId: true,
      tracearrMappingVersion: true,
      tracearrBackfillComplete: true,
      tracearrBackfillCursorAt: true,
      tracearrBackfillLastWalkAt: true,
      tracearrForwardFloorAt: true,
      tracearrForwardWatermarkAt: true,
      tracearrOldestPlayAt: true,
      watchHistorySyncedAt: true,
    },
  });
}

/**
 * What the server PUT does to the row on a change of the mapping: the new
 * value, the version bumped, the walk state and the marker reset, the rows
 * wiped — and the live readout and the evidence withdrawn after the commit.
 * `withdraw: false` leaves the withdrawal out, to show the version alone holds.
 */
async function putMapping(tracearrServerId: string | null, opts: { withdraw?: boolean } = {}) {
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
  if (opts.withdraw !== false) await invalidateWatchHistoryEvidence([serverId]);
}

/** Unlink, then link the same Tracearr server again. */
async function relink(opts: { withdraw?: boolean } = {}) {
  await putMapping(null, opts);
  await putMapping(TRACEARR_SERVER_ID, opts);
}

async function storeRow(sourceEventId: string, watchedAt: Date) {
  await prisma.watchHistory.create({
    data: {
      mediaItemId: itemId,
      mediaServerId: serverId,
      serverUsername: "walter",
      watchedAt,
      source: "TRACEARR",
      sourceEventId,
      watched: true,
      state: "stopped",
    },
  });
}

describe("an unlink and re-link of the same Tracearr server mid-import (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    resetRecoveryAnswers();
    archive = new FakeTracearrArchive();
    // Reset, not just cleared: a once-implementation a failed test never
    // consumed must not leak into the next one.
    for (const fn of Object.values(m)) fn.mockReset();
    m.getHistoryPage.mockImplementation(async (id: string, options: object) => archive.page(id, options));
    m.findOldestPlayAt.mockImplementation(async (id: string) => archive.oldest(id));
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    m.getHistoryForItem.mockResolvedValue([]);
    const user = await createTestUser();
    const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_ID });
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    itemId = (await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" })).id;
    await prisma.tracearrInstance.create({
      data: { userId: user.id, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("refuses the pages after it, and the slice's cursor, walk stamp and completion", async () => {
    archive.add(play("p1", ago(1 * DAY)), play("p2", ago(2 * DAY)), play("p3", ago(3 * DAY)));
    // Page 1 commits; the re-link lands while page 2 is in flight.
    m.getHistoryPage
      .mockImplementationOnce(async (id: string, options: object) => archive.page(id, options))
      .mockImplementationOnce(async (id: string, options: object) => {
        await relink();
        return archive.page(id, options);
      });

    const result = await syncTracearrHistory(serverId, { passes: "backfill" });

    // A clean stop: the mapping moved, Tracearr did not fail.
    expect(result).toMatchObject({ backfillOutcome: "stopped", backfillPending: true });
    // Page 1's rows went with the wipe; page 2's never landed.
    expect(await prisma.watchHistory.count()).toBe(0);
    // The reset stands: the re-linked mapping's walk starts from the top.
    expect(await serverRow()).toMatchObject({
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
    // A fresh mapping, as the PUT that made it leaves it: no marker — which is
    // also what the re-link resets it to, so the marker's own compare-and-set
    // cannot tell the two mappings apart.
    await prisma.mediaServer.update({ where: { id: serverId }, data: { watchHistorySyncedAt: null } });
    archive.add(play("p1", ago(1 * DAY)));
    // Land the re-link right before the run's completion write, after its page.
    const realUpdateMany = prisma.mediaServer.updateMany.bind(prisma.mediaServer);
    let relinked = false;
    const spy = vi.spyOn(prisma.mediaServer, "updateMany").mockImplementation((async (
      args: Parameters<typeof realUpdateMany>[0],
    ) => {
      if (!relinked && (args.data as Record<string, unknown>).tracearrBackfillComplete === true) {
        relinked = true;
        await relink({ withdraw });
      }
      return realUpdateMany(args);
    }) as never);
    try {
      const result = await syncTracearrHistory(serverId, { passes: "backfill" });
      // The walk finished, but on an archive that has since been reset: owed a
      // fresh walk, and re-queued for one rather than read as empty.
      expect(result).toMatchObject({
        backfillOutcome: "exhausted",
        backfillPending: true,
        completionLost: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(relinked).toBe(true);
    expect(await serverRow()).toMatchObject({
      tracearrBackfillComplete: false,
      tracearrBackfillCursorAt: null,
      tracearrBackfillLastWalkAt: null,
      watchHistorySyncedAt: null,
    });
  });

  it("refuses the backfill's watermark when the re-link lands before it", async () => {
    archive.add(play("p1", ago(1 * DAY)));
    m.findOldestPlayAt.mockImplementationOnce(async () => {
      await relink();
      return null;
    });

    await syncTracearrHistory(serverId, { passes: "backfill" });

    expect((await serverRow()).tracearrForwardWatermarkAt).toBeNull();
    expect(await prisma.watchHistory.count()).toBe(0);
  });

  it("refuses a forward walk's floor, and leaves a floor the re-linked mapping recorded alone", async () => {
    // A forward walk with a floor of its own to pay; meanwhile the mapping is
    // re-linked and a degraded run of the NEW mapping records its floor.
    await storeRow("stored", ago(10 * DAY));
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillComplete: true, tracearrForwardFloorAt: ago(12 * DAY) },
    });
    const newMappingFloor = ago(11 * DAY);
    m.getHistoryPage.mockImplementationOnce(async () => {
      await relink();
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrForwardFloorAt: newMappingFloor },
      });
      // Nothing to write, so the walk exhausts and goes on to pay its floor.
      return { records: [], nextCursor: null };
    });

    const result = await syncTracearrHistory(serverId, { passes: "forward" });

    expect(result.failed).toBeUndefined();
    // The value matched (same Tracearr server) and the floor sits above this
    // walk's `since`: only the version tells the two mappings apart.
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(newMappingFloor);
  });

  it("refuses to record a floor under the re-linked mapping", async () => {
    await storeRow("stored", ago(10 * DAY));
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillComplete: true },
    });
    // The page carries a play newer than the stored watermark, so the walk
    // records its floor before writing it — after the re-link.
    m.getHistoryPage.mockImplementationOnce(async () => {
      await relink();
      return { records: [play("new", ago(1 * DAY))], nextCursor: null };
    });

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect((await serverRow()).tracearrForwardFloorAt).toBeNull();
    expect(await prisma.watchHistory.count()).toBe(0);
  });

  it("does not hand the re-linked mapping the old run's forward watermark", async () => {
    // A finished archive with no rows and no watermark yet: the forward walk
    // records one when it has read its window — compare-and-set on the null it
    // read, which the re-link's reset matches.
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillComplete: true, tracearrBackfillLastWalkAt: ago(2 * DAY) },
    });
    m.getHistoryPage.mockImplementationOnce(async () => {
      await relink();
      return { records: [], nextCursor: null };
    });

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect((await serverRow()).tracearrForwardWatermarkAt).toBeNull();
  });

  it("does not delete native history written under the re-linked mapping", async () => {
    await storeRow("stored", ago(10 * DAY));
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillComplete: true },
    });
    archive.add(play("new", ago(1 * DAY)));
    // After the page commits, right before the run's marker release (and the
    // native-stratum cleanup that follows it): re-linked, and a native row
    // appears for the new mapping.
    const realUpdateMany = prisma.mediaServer.updateMany.bind(prisma.mediaServer);
    let relinked = false;
    const spy = vi.spyOn(prisma.mediaServer, "updateMany").mockImplementation((async (
      args: Parameters<typeof realUpdateMany>[0],
    ) => {
      if (!relinked && "watchHistorySyncedAt" in (args.data as Record<string, unknown>)) {
        relinked = true;
        await relink({ withdraw: false });
        await prisma.watchHistory.create({
          data: { mediaItemId: itemId, mediaServerId: serverId, serverUsername: "walter", watchedAt: new Date() },
        });
      }
      return realUpdateMany(args);
    }) as never);
    try {
      await syncTracearrHistory(serverId, { passes: "forward" });
    } finally {
      spy.mockRestore();
    }

    expect(relinked).toBe(true);
    expect(await prisma.watchHistory.count({ where: { source: "NATIVE" } })).toBe(1);
    // Nor is the re-linked mapping vouched for.
    expect((await serverRow()).watchHistorySyncedAt).toBeNull();
  });

  it("writes everything as before while the version holds", async () => {
    // A fresh mapping, as the PUT leaves it: no marker, at a bumped version.
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { watchHistorySyncedAt: null, tracearrMappingVersion: 3 },
    });
    archive.add(play("p1", ago(1 * DAY)), play("p2", ago(2 * DAY)), play("p3", ago(3 * DAY)));

    const result = await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(result).toMatchObject({ count: 3, backfillOutcome: "exhausted", backfillPending: false });
    const row = await serverRow();
    expect(row.tracearrBackfillComplete).toBe(true);
    expect(row.tracearrBackfillCursorAt).toEqual(ago(3 * DAY));
    expect(row.tracearrBackfillLastWalkAt).toBeInstanceOf(Date);
    expect(row.tracearrForwardWatermarkAt).toBeInstanceOf(Date);
    expect(row.tracearrOldestPlayAt).toEqual(ago(3 * DAY));
    expect(row.watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  describe("the recovery pass for re-added items", () => {
    async function recentlyAdded() {
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: true },
      });
      await prisma.mediaItem.update({
        where: { id: itemId },
        data: { createdAt: new Date(NOW - DAY) },
      });
      await createTestExternalId(itemId, "TMDB", "603");
    }

    it("writes nothing once the mapping has been re-linked under it", async () => {
      await recentlyAdded();
      // A second, older addition — asked about after the first, if at all.
      const library = await prisma.library.findFirstOrThrow({ where: { mediaServerId: serverId } });
      const second = await createTestMediaItem(library.id, { ratingKey: "200", type: "MOVIE", title: "Heat" });
      await prisma.mediaItem.update({ where: { id: second.id }, data: { createdAt: new Date(NOW - 2 * DAY) } });
      m.getHistoryForItem.mockImplementationOnce(async () => {
        await relink();
        return [play("old-1", ago(400 * DAY)), play("old-2", ago(300 * DAY))];
      });

      const result = await recoverHistoryForNewItems(serverId);

      expect(result.imported).toBe(0);
      expect(await prisma.watchHistory.count()).toBe(0);
      // It stopped at the refused write: the next candidate was never asked.
      const asked = m.getHistoryForItem.mock.calls.map((call) => call[1] as { ratingKey?: string });
      expect(asked.some((filter) => filter.ratingKey === "100")).toBe(true);
      expect(asked.some((filter) => filter.ratingKey === "200")).toBe(false);
    });

    it("does nothing for a re-linked mapping whose archive walk has not run yet", async () => {
      // The task gates on the slice's view of the walk, taken before the
      // re-link; written now, an old recovered play would become the new
      // archive's resume point and the walk would skip everything above it.
      await recentlyAdded();
      await relink();
      m.getHistoryForItem.mockResolvedValue([play("old-1", ago(400 * DAY))]);

      const result = await recoverHistoryForNewItems(serverId);

      expect(result).toEqual({ checked: 0, imported: 0 });
      expect(m.getHistoryForItem).not.toHaveBeenCalled();
      expect(await prisma.watchHistory.count()).toBe(0);
    });

    it("recovers as before while the version holds", async () => {
      await recentlyAdded();
      m.getHistoryForItem.mockImplementation(async (_id: string, filter: { ratingKey?: string }) =>
        filter.ratingKey ? [] : [play("old-1", ago(400 * DAY), { rating_key: "999", tmdb_id: 603 })],
      );

      const result = await recoverHistoryForNewItems(serverId);

      expect(result.imported).toBe(1);
      expect(await prisma.watchHistory.count({ where: { sourceEventId: "old-1", mediaItemId: itemId } })).toBe(1);
    });
  });
});
