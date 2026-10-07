import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

/**
 * The importer's resume state against real Postgres: the forward floor's
 * `LEAST` write and compare-and-set clear, a cursor with no rows behind it,
 * and the mapping-guarded native cleanup. The unit tests drive the same paths through
 * a mocked client; these prove the SQL does what the unit tests assume.
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

const prisma = getTestPrisma();
const HOUR = 60 * 60 * 1000;

function record(id: string, startedAt: string, ratingKey = "100") {
  return {
    id,
    reference_id: id,
    server_id: TRACEARR_SERVER_ID,
    media_type: "movie",
    rating_key: ratingKey,
    started_at: startedAt,
    stopped_at: startedAt,
    state: "stopped",
    watched: true,
    user: { id: "u", server_user_id: "acct-1", username: "Walter W" },
  };
}

let serverId: string;

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

describe("Tracearr import resume state (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" });
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

  it("resumes an interrupted forward walk from the old watermark, then clears the floor", async () => {
    // A fully backfilled server whose newest stored play is OLD_MAX.
    const OLD_MAX = new Date("2025-07-10T12:00:00.000Z");
    const mediaItem = await prisma.mediaItem.findFirstOrThrow();
    await prisma.watchHistory.create({
      data: {
        mediaItemId: mediaItem.id,
        mediaServerId: serverId,
        serverUsername: "walter",
        watchedAt: OLD_MAX,
        source: "TRACEARR",
        sourceEventId: "stored",
        watched: true,
        state: "stopped",
      },
    });
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillComplete: true, watchHistorySyncedAt: new Date("2025-07-10") },
    });

    // Run 1 commits the newest page, then Tracearr fails on the next one.
    m.getHistoryPage
      .mockResolvedValueOnce({ records: [record("new", "2025-07-20T09:00:00.000Z")], nextCursor: "c2" })
      .mockRejectedValueOnce(new Error("socket hang up"));
    const first = await syncTracearrHistory(serverId, { passes: "forward" });
    expect(first.failed).toMatch(/could not be reached/i);

    const originalSince = new Date(OLD_MAX.getTime() - HOUR);
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(originalSince);

    // Run 2: the watermark is now the new play, but the walk still reaches the
    // old one — and having read its whole window, it clears the floor and
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
    const mediaItem = await prisma.mediaItem.findFirstOrThrow();
    await prisma.watchHistory.create({
      data: {
        mediaItemId: mediaItem.id,
        mediaServerId: serverId,
        serverUsername: "walter",
        watchedAt: new Date("2025-07-10T12:00:00.000Z"),
        source: "TRACEARR",
        sourceEventId: "stored",
        watched: true,
        state: "stopped",
      },
    });
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillComplete: true, tracearrForwardFloorAt: OLDER },
    });
    // Without the account map the walk keeps to the ordinary window (newer
    // than the floor) — and stopping there must not move the floor later.
    m.getServerAccountNames.mockRejectedValue(new Error("users down"));
    m.getHistoryPage
      .mockResolvedValueOnce({ records: [record("new", "2025-07-20T09:00:00.000Z")], nextCursor: "c2" })
      .mockRejectedValueOnce(new Error("socket hang up"));

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect((await serverRow()).tracearrForwardFloorAt).toEqual(OLDER);
  });

  it("walks below a cursor it finds with no rows behind it, rather than resetting it", async () => {
    // A cursor with no rows is also what an archive whose newest stretch held
    // nothing storable leaves behind, so the importer no longer reads it as
    // stale. The paths that destroy rows reset the state themselves — a
    // config-only restore is covered in
    // tests/integration/backup/restore-watch-evidence.test.ts.
    const CURSOR = new Date("2022-01-01T00:00:00.000Z");
    await prisma.mediaServer.update({
      where: { id: serverId },
      // No walk stamp either — a slice that errored after committing a page
      // leaves exactly this. Only a recorded restart
      // (`tracearrBackfillRestartedAt`) holds the walk.
      data: {
        tracearrBackfillComplete: false,
        tracearrBackfillCursorAt: CURSOR,
      },
    });
    m.getHistoryPage.mockResolvedValueOnce({
      records: [record("older", "2021-06-01T00:00:00.000Z")],
      nextCursor: null,
    });

    const result = await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(m.getHistoryPage.mock.calls[0][1].until).toEqual(CURSOR);
    expect(result.backfillPending).toBe(false);
    const after = await serverRow();
    expect(after.tracearrBackfillComplete).toBe(true);
    expect(await prisma.watchHistory.count({ where: { source: "TRACEARR" } })).toBe(1);
  });

  // The restart hold (`tracearrBackfillRestartedAt`) and what releases it are
  // covered end to end in tracearr-restart-hold.test.ts.

  it("does not delete native history once the server has been unlinked", async () => {
    // The import's own rows land, then the admin unlinks the server and a
    // native Refresh refills it — all while this run is still walking.
    const mediaItem = await prisma.mediaItem.findFirstOrThrow();
    m.getHistoryPage.mockImplementationOnce(async () => ({
      records: [record("newest", "2026-10-01T00:00:00.000Z")],
      nextCursor: null,
    }));
    m.findOldestPlayAt.mockImplementation(async () => null);
    // Unlink + native refill happen after the page commits: hook the backfill
    // state write, which runs after the walk and before the cleanup.
    const realUpdateMany = prisma.mediaServer.updateMany.bind(prisma.mediaServer);
    const spy = vi
      .spyOn(prisma.mediaServer, "updateMany")
      .mockImplementation((async (args: Parameters<typeof realUpdateMany>[0]) => {
        const out = await realUpdateMany(args);
        if ((args.data as Record<string, unknown>).tracearrBackfillComplete === true) {
          await prisma.mediaServer.update({
            where: { id: serverId },
            data: { tracearrServerId: null },
          });
          await prisma.watchHistory.create({
            data: {
              mediaItemId: mediaItem.id,
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
