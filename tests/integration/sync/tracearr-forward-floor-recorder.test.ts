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
 * Two overlapping forward walks — a scheduled job and a History-page Refresh,
 * say: the Refresh runs in a request, outside the serial queue — against real
 * Postgres and a fake Tracearr keyset.
 *
 * A forward walk reads every play from its `since` up to when it started. The
 * forward floor marks plays a walk left unread, and a walk that exhausts its
 * window pays any floor at or above its `since`. But a floor recorded by a walk
 * that started LATER can mark plays the earlier walk never fetched — newer than
 * its start — so the earlier walk paying it stranded them for good: the next
 * window starts an hour below the new MAX, and the backfill walks below MIN.
 * `tracearrForwardFloorRecordedAt` (the newest recorder's start) is what tells
 * the two apart.
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
  // Two records a page, so a walk can be stopped part-way through its window.
  MAX_PAGE_SIZE: 2,
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
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** When the first walk starts. */
const T0 = new Date("2026-04-01T12:00:00.000Z").getTime();
const at = (offset: number) => new Date(T0 + offset);

let archive: FakeTracearrArchive;
let serverId: string;
let itemId: string;

async function serverRow() {
  return prisma.mediaServer.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      tracearrForwardFloorAt: true,
      tracearrForwardFloorRecordedAt: true,
      watchHistorySyncedAt: true,
    },
  });
}

async function storedIds(): Promise<string[]> {
  const rows = await prisma.watchHistory.findMany({ select: { sourceEventId: true } });
  return rows.map((row) => row.sourceEventId ?? "").sort();
}

/** A play of the movie, in the archive and already stored. */
async function storedPlay(id: string, when: Date) {
  archive.add(play(id, when));
  await prisma.watchHistory.create({
    data: {
      mediaItemId: itemId,
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

/**
 * A second forward walk, started now, that reads its first page and is then
 * stopped — the user pressing Stop on a Refresh, say.
 */
async function walkStoppedAfterOnePage() {
  const stop = new AbortController();
  m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
    stop.abort();
    return archive.page(id, options);
  });
  return syncTracearrHistory(serverId, { passes: "forward", signal: stop.signal });
}

describe("paying the forward floor when forward walks overlap (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
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
    const server = await createTestServer(user.id, {
      tracearrServerId: TRACEARR_SERVER_ID,
      tracearrBackfillComplete: true,
    });
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    itemId = (await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" })).id;
    await prisma.tracearrInstance.create({
      data: { userId: user.id, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(-DAY));
    await storedPlay("old", at(-5 * HOUR));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("does not pay a floor that a walk started after it recorded — and the next walk reads what that walk left", async () => {
    archive.add(play("first-new", at(-10 * MINUTE)));
    vi.setSystemTime(at(0));
    m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      // The first walk's page, as Tracearr answered it when that walk asked.
      const page = archive.page(id, options);
      // Three hours on, a second walk starts while the first is still going,
      // reads only the newest plays — all newer than the first walk's start —
      // and is stopped, leaving "gap" unread under the floor it records.
      vi.setSystemTime(at(3 * HOUR));
      archive.add(play("gap", at(30 * MINUTE)), play("new-1", at(2 * HOUR)), play("new-2", at(2.5 * HOUR)));
      await walkStoppedAfterOnePage();
      expect(await storedIds()).toEqual(["new-1", "new-2", "old"]);
      return page;
    });

    const first = await syncTracearrHistory(serverId, { passes: "forward" });

    expect(first.failed).toBeUndefined();
    expect(await storedIds()).toEqual(["first-new", "new-1", "new-2", "old"]);
    // Still owed: the first walk never fetched anything newer than its start.
    expect(await serverRow()).toMatchObject({
      tracearrForwardFloorAt: at(-6 * HOUR),
      tracearrForwardFloorRecordedAt: at(3 * HOUR),
    });

    vi.setSystemTime(at(4 * HOUR));
    archive.clearRequests();
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(archive.requests[0].since).toEqual(at(-6 * HOUR));
    expect(await storedIds()).toEqual(["first-new", "gap", "new-1", "new-2", "old"]);
    expect(await serverRow()).toMatchObject({
      tracearrForwardFloorAt: null,
      tracearrForwardFloorRecordedAt: null,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  it("does not pay it when the later walk records after it — the stamp moves even when the floor keeps its value", async () => {
    archive.add(
      play("first-a", at(-20 * MINUTE)),
      play("first-b", at(-15 * MINUTE)),
      play("first-c", at(-10 * MINUTE)),
    );
    vi.setSystemTime(at(0));
    m.getHistoryPage
      // The first walk's first page moves the watermark, so it records the
      // floor itself — stamped with its own start.
      .mockImplementationOnce(async (id: string, options: object) => archive.page(id, options))
      .mockImplementationOnce(async (id: string, options: object) => {
        const page = archive.page(id, options);
        expect(await serverRow()).toMatchObject({
          tracearrForwardFloorAt: at(-6 * HOUR),
          tracearrForwardFloorRecordedAt: at(0),
        });
        // A second walk records the floor too. Its own `since` is above the
        // stored one, so the floor keeps its value — but not its stamp.
        vi.setSystemTime(at(3 * HOUR));
        archive.add(play("gap", at(30 * MINUTE)), play("new-1", at(2 * HOUR)), play("new-2", at(2.5 * HOUR)));
        await walkStoppedAfterOnePage();
        expect(await serverRow()).toMatchObject({
          tracearrForwardFloorAt: at(-6 * HOUR),
          tracearrForwardFloorRecordedAt: at(3 * HOUR),
        });
        return page;
      });

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await storedIds()).toEqual(["first-a", "first-b", "first-c", "new-1", "new-2", "old"]);
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(at(-6 * HOUR));

    vi.setSystemTime(at(4 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toContain("gap");
    expect((await serverRow()).tracearrForwardFloorAt).toBeNull();
  });

  it("pays a floor that a walk started before it recorded", async () => {
    // The ordinary resume: a walk stopped part-way, and the next one — started
    // after it — reaches back to its floor and reads what it left.
    archive.add(play("gap", at(-30 * MINUTE)), play("new-1", at(-20 * MINUTE)), play("new-2", at(-10 * MINUTE)));
    vi.setSystemTime(at(0));
    await walkStoppedAfterOnePage();
    expect(await storedIds()).toEqual(["new-1", "new-2", "old"]);
    expect(await serverRow()).toMatchObject({
      tracearrForwardFloorAt: at(-6 * HOUR),
      tracearrForwardFloorRecordedAt: at(0),
    });

    vi.setSystemTime(at(HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual(["gap", "new-1", "new-2", "old"]);
    expect(await serverRow()).toMatchObject({
      tracearrForwardFloorAt: null,
      tracearrForwardFloorRecordedAt: null,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  it("pays the floor it recorded itself", async () => {
    // The steady state: a walk after a playback moves the watermark, so it
    // records the floor before writing — and, reading its whole window, pays
    // it. It records after its first page has come back, so the stamp has to
    // be the walk's START: stamped with the moment of recording, the walk
    // could never pay its own floor, and on a server where every playback
    // brings a new play nothing ever would.
    archive.add(play("new", at(-10 * MINUTE)));
    vi.setSystemTime(at(0));
    await prisma.mediaServer.update({ where: { id: serverId }, data: { watchHistorySyncedAt: null } });
    m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      // The page takes a while to come back.
      vi.setSystemTime(at(MINUTE));
      return archive.page(id, options);
    });

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await storedIds()).toEqual(["new", "old"]);
    expect(await serverRow()).toMatchObject({
      tracearrForwardFloorAt: null,
      tracearrForwardFloorRecordedAt: null,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  it("pays a floor that carries no recorder stamp, as before the stamp existed", async () => {
    // Restored from a backup taken before the column, say. The walk below
    // moves no watermark (its newest play is already stored), so it records
    // nothing itself and the floor keeps no stamp.
    await storedPlay("newest", at(-HOUR));
    archive.add(play("gap", at(-3 * HOUR)));
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrForwardFloorAt: at(-6 * HOUR), tracearrForwardFloorRecordedAt: null },
    });
    vi.setSystemTime(at(0));

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await storedIds()).toEqual(["gap", "newest", "old"]);
    expect(await serverRow()).toMatchObject({
      tracearrForwardFloorAt: null,
      tracearrForwardFloorRecordedAt: null,
    });
  });
});
