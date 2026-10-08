import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { FakeTracearrArchive, play } from "./fake-tracearr-archive";
import { answerFrom, seedMappedServer, serverRow, storeTracearrPlay, tracearr } from "./tracearr-import-kit";

// While the library-resync hold is set, no Tracearr pass may vouch for the
// server's play history (`watchHistorySyncedAt`): plays of missing items were skipped.

vi.mock("@/lib/db", async () => ({ prisma: (await import("../../setup/test-db")).getTestPrisma() }));
vi.mock("@/lib/logger", async () => (await import("./tracearr-import-kit")).loggerModule());
vi.mock("@/lib/tracearr/tracearr-client", async () => (await import("./tracearr-import-kit")).clientModule(100));

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { releaseLibraryResyncHold, requireLibraryResync } from "@/lib/media/watch-evidence";

const prisma = getTestPrisma();
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);

let archive: FakeTracearrArchive;
let serverId: string;
let itemId: string;
const setServer = (data: Parameters<typeof prisma.mediaServer.update>[0]["data"]) =>
  prisma.mediaServer.update({ where: { id: serverId }, data });

describe("the Tracearr importer never vouches over a library-resync hold (real DB)", () => {
  beforeEach(async () => {
    archive = new FakeTracearrArchive();
    answerFrom(() => archive);
    ({ serverId, itemId } = await seedMappedServer());
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // The first two SIMULATE a hold written without its restart (left only by a
  // failed restart write): `establishMarker`'s own hold condition refuses there.
  it("records a completion reached while the hold was set, without the marker — and is not a lost completion", async () => {
    await setServer({ watchHistorySyncedAt: null });
    archive.add(play("p1", ago(2 * DAY)));
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await setServer({ libraryResyncRequiredAt: new Date() });
      return archive.page(id, options);
    });

    const result = await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(result).toMatchObject({ backfillOutcome: "exhausted", backfillPending: false, count: 1 });
    expect(result.completionLost).toBeUndefined();
    expect(await serverRow(serverId)).toMatchObject({ tracearrBackfillComplete: true, watchHistorySyncedAt: null });

    // Once the hold is gone, the next healthy run vouches.
    await setServer({ libraryResyncRequiredAt: null });
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect((await serverRow(serverId)).watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  it("does not vouch on a finished archive's forward run while the hold is set, and does after its release", async () => {
    await storeTracearrPlay(itemId, serverId, "stored", ago(DAY));
    await setServer({ tracearrBackfillComplete: true, watchHistorySyncedAt: null, libraryResyncRequiredAt: new Date() });

    expect((await syncTracearrHistory(serverId, { passes: "forward" })).failed).toBeUndefined();
    expect((await serverRow(serverId)).watchHistorySyncedAt).toBeNull();

    expect(await releaseLibraryResyncHold(serverId, new Date())).toBe(true);
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect((await serverRow(serverId)).watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  it("loses the completion to a hold that restarted the walk, and holds the next slice", async () => {
    await setServer({ watchHistorySyncedAt: null });
    archive.add(play("p1", ago(2 * DAY)));
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await requireLibraryResync([serverId]);
      return archive.page(id, options);
    });

    const result = await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(result).toMatchObject({ backfillOutcome: "exhausted", backfillPending: true, completionLost: true });
    expect(await serverRow(serverId)).toMatchObject({ tracearrBackfillComplete: false, watchHistorySyncedAt: null });
    // Held until the library sync that brings the items back releases it.
    archive.clearRequests();
    const next = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(next).toMatchObject({ heldReason: "awaiting-resync", backfillPending: true });
    expect(archive.requests).toHaveLength(0);
  });
});
