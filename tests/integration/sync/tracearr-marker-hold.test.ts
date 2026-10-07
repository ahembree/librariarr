import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import { FakeTracearrArchive, TRACEARR_SERVER_ID, play } from "./fake-tracearr-archive";

/**
 * The Tracearr importer and the library-resync hold
 * (`MediaServer.libraryResyncRequiredAt`): while some of a server's items are
 * known to be missing, no history pass may vouch for its play history
 * (`watchHistorySyncedAt`) — the plays of items that do not exist yet were
 * skipped, and negative `watchedByUser`, `playCount = 0` and "not played in N
 * months" rules would match exactly those items.
 *
 * Real Postgres and the real evidence helpers; Tracearr is a fake keyset.
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
import { releaseLibraryResyncHold, requireLibraryResync } from "@/lib/media/watch-evidence";

const prisma = getTestPrisma();
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);

let archive: FakeTracearrArchive;
let serverId: string;
let itemId: string;

async function serverRow() {
  return prisma.mediaServer.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      tracearrBackfillComplete: true,
      tracearrBackfillCursorAt: true,
      libraryResyncRequiredAt: true,
      watchHistorySyncedAt: true,
    },
  });
}

describe("the Tracearr importer never vouches over a library-resync hold (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    archive = new FakeTracearrArchive();
    // Reset, not just cleared: a once-implementation a failed test never
    // consumed must not leak into the next one.
    for (const fn of Object.values(m)) fn.mockReset();
    m.getHistoryPage.mockImplementation(async (id: string, options: object) => archive.page(id, options));
    m.findOldestPlayAt.mockImplementation(async (id: string) => archive.oldest(id));
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
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

  // The first two tests SIMULATE a hold that landed without its restart, which
  // `requireLibraryResync` never leaves behind on its own: every hold goes
  // through `restartTracearrBackfill`, which moves a mapped server's cursor (so
  // a finishing slice's completion is refused — the third test) and marks the
  // archive unfinished. Only a restart write that failed after the hold was
  // written leaves this state, and `establishMarker`'s own hold condition is
  // what still refuses the marker there.
  it("records a completion reached while the hold was set, without the marker — and is not a lost completion", async () => {
    // A fresh mapping: the server PUT that made it nulled the marker.
    await prisma.mediaServer.update({ where: { id: serverId }, data: { watchHistorySyncedAt: null } });
    archive.add(play("p1", ago(2 * DAY)));
    // The hold lands while the finishing page is in flight, written directly
    // (its restart did not happen), so the cursor did not move and the
    // completion compare-and-set still matches.
    m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { libraryResyncRequiredAt: new Date() },
      });
      return archive.page(id, options);
    });

    const result = await syncTracearrHistory(serverId, { passes: "backfill" });

    // The walk did reach the archive's end: complete, nothing re-queued.
    expect(result).toMatchObject({ backfillOutcome: "exhausted", backfillPending: false, count: 1 });
    expect(result.completionLost).toBeUndefined();
    expect(await serverRow()).toMatchObject({
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: null,
    });

    // Once the hold is gone, the next healthy run vouches.
    await prisma.mediaServer.update({ where: { id: serverId }, data: { libraryResyncRequiredAt: null } });
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  it("does not vouch on a finished archive's forward run while the hold is set, and does after its release", async () => {
    await prisma.watchHistory.create({
      data: {
        mediaItemId: itemId,
        mediaServerId: serverId,
        serverUsername: "walter",
        watchedAt: ago(DAY),
        source: "TRACEARR",
        sourceEventId: "stored",
        watched: true,
        state: "stopped",
      },
    });
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: {
        tracearrBackfillComplete: true,
        watchHistorySyncedAt: null,
        // Written directly on a finished archive: the restart that comes with
        // every real hold would have marked it unfinished (see above).
        libraryResyncRequiredAt: new Date(),
      },
    });

    const held = await syncTracearrHistory(serverId, { passes: "forward" });
    expect(held.failed).toBeUndefined();
    expect((await serverRow()).watchHistorySyncedAt).toBeNull();

    expect(await releaseLibraryResyncHold(serverId, new Date())).toBe(true);
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect((await serverRow()).watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  it("loses the completion to a hold that restarted the walk, and holds the next slice", async () => {
    // `requireLibraryResync` (a purge, say) also restarts a mapped server's
    // walk, which moves the cursor: the finishing slice's completion no longer
    // describes the archive, and is refused outright.
    await prisma.mediaServer.update({ where: { id: serverId }, data: { watchHistorySyncedAt: null } });
    archive.add(play("p1", ago(2 * DAY)));
    m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await requireLibraryResync([serverId]);
      return archive.page(id, options);
    });

    const result = await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(result).toMatchObject({
      backfillOutcome: "exhausted",
      backfillPending: true,
      completionLost: true,
    });
    expect(await serverRow()).toMatchObject({
      tracearrBackfillComplete: false,
      watchHistorySyncedAt: null,
    });
    // The re-queued slice is held until the library sync that brings the
    // items back releases the hold.
    archive.clearRequests();
    const next = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(next).toMatchObject({ heldReason: "awaiting-resync", backfillPending: true });
    expect(archive.requests).toHaveLength(0);
  });
});
