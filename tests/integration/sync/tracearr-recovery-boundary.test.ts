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
 * The recovery pass for re-added items and the forward window, end to end:
 * the real recovery pass, the real backfill task and the real watch-history
 * sync against real Postgres, with only Tracearr's HTTP answers and the job
 * queue's enqueue faked.
 *
 * The recovery pass asks Tracearr for EVERY play of a recently added item, the
 * newest included. Stored, a play newer than the newest stored one moves
 * `MAX(watchedAt)` — where the next forward window starts — up to it, past
 * every other item's play in between that no walk had read: the backfill slice
 * that runs the pass is queued straight away when a server or Tracearr
 * instance is re-enabled, before any catch-up has read what happened while it
 * was off. Those plays were then never imported.
 */

const m = vi.hoisted(() => ({
  getHistoryPage: vi.fn(),
  getHistoryForItem: vi.fn(),
  listServers: vi.fn(),
  getServerAccountNames: vi.fn(),
  findOldestPlayAt: vi.fn(),
  enqueueJob: vi.fn(),
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
    this.getHistoryForItem = m.getHistoryForItem;
    this.listServers = m.listServers;
    this.getServerAccountNames = m.getServerAccountNames;
    this.findOldestPlayAt = m.findOldestPlayAt;
  },
}));

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: m.enqueueJob,
  isJobRetrying: vi.fn(async () => false),
}));

// The real "is a requested sync waiting" watch, polled every 10ms instead of
// every 2s so the task does not wait out the interval.
vi.mock("@/lib/sync/cancel-watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cancel-watch")>();
  return {
    ...actual,
    watchForCancel: (isCancelled: () => Promise<boolean>) => actual.watchForCancel(isCancelled, 10),
  };
});

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import {
  RECOVERY_REASK_MS,
  recoverHistoryForNewItems,
  resetRecoveryAnswers,
} from "@/lib/sync/tracearr-backfill-additions";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { taskList } from "@/lib/jobs/tasks";
import { TASK_TRACEARR_BACKFILL } from "@/lib/jobs/constants";

const prisma = getTestPrisma();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T = new Date("2026-06-10T12:00:00.000Z").getTime();
const at = (offset: number) => new Date(T + offset);

let archive: FakeTracearrArchive;
let serverId: string;
let favouriteId: string;

async function storedIds(): Promise<string[]> {
  const rows = await prisma.watchHistory.findMany({ select: { sourceEventId: true } });
  return rows.map((row) => row.sourceEventId ?? "").sort();
}

describe("the recovery pass leaves plays newer than the forward boundary to the forward walk (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    resetRecoveryAnswers();
    vi.clearAllMocks();
    // Reset, not just cleared: a once-implementation a failed test never
    // consumed must not leak into the next one.
    for (const fn of Object.values(m)) fn.mockReset();
    archive = new FakeTracearrArchive();
    m.getHistoryPage.mockImplementation(async (id: string, options: object) => archive.page(id, options));
    m.findOldestPlayAt.mockImplementation(async (id: string) => archive.oldest(id));
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    m.enqueueJob.mockResolvedValue(true);
    // Every play of an item, whatever its age — what `/history?rating_key=`
    // answers; nothing by provider id.
    m.getHistoryForItem.mockImplementation(async (id: string, filter: { ratingKey?: string }) =>
      filter.ratingKey
        ? archive.page(id, { pageSize: 1000 }).records.filter((record) => record.rating_key === filter.ratingKey)
        : [],
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    const user = await createTestUser();
    const server = await createTestServer(user.id, {
      tracearrServerId: TRACEARR_SERVER_ID,
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: at(-DAY),
    });
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    favouriteId = (await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "Old Favourite" })).id;
    await prisma.mediaItem.update({ where: { id: favouriteId }, data: { createdAt: at(-60 * DAY) } });
    // Recently added: the recovery pass's candidate.
    const added = await createTestMediaItem(library.id, { ratingKey: "300", type: "MOVIE", title: "Just Added" });
    await prisma.mediaItem.update({ where: { id: added.id }, data: { createdAt: at(-DAY) } });
    await prisma.tracearrInstance.create({
      data: { userId: user.id, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function storedFavouritePlay(id: string, when: Date) {
    archive.add(play(id, when));
    await prisma.watchHistory.create({
      data: {
        mediaItemId: favouriteId,
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

  it("does not move the forward window past an unread play by storing a recent one", async () => {
    await storedFavouritePlay("a-old", at(-2 * HOUR));
    // Neither read yet: a play of the old favourite, and the new item's.
    archive.add(play("q-unread", at(HOUR)), play("x-recent", at(3 * HOUR), { rating_key: "300" }));

    vi.setSystemTime(at(3.5 * HOUR));
    await recoverHistoryForNewItems(serverId);
    // The new item's play is newer than the newest stored one: the forward
    // walk's to import.
    expect(await storedIds()).toEqual(["a-old"]);

    vi.setSystemTime(at(4 * HOUR));
    archive.clearRequests();
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(archive.requests[0].since).toEqual(at(-3 * HOUR));
    expect(await storedIds()).toEqual(["a-old", "q-unread", "x-recent"]);
  });

  it("still recovers the new item's OLD plays in the same pass", async () => {
    await storedFavouritePlay("a-old", at(-2 * HOUR));
    // Filed long ago under the key the item has now, and a recent one.
    archive.add(
      play("x-old", at(-40 * DAY), { rating_key: "300" }),
      play("x-recent", at(3 * HOUR), { rating_key: "300" }),
    );

    vi.setSystemTime(at(3.5 * HOUR));
    const result = await recoverHistoryForNewItems(serverId);

    expect(result).toEqual({ checked: 1, imported: 1 });
    expect(await storedIds()).toEqual(["a-old", "x-old"]);
  });

  it("keeps an unread play when the server comes back after a day off and its queued slice recovers first", async () => {
    await storedFavouritePlay("a-old", at(-2 * HOUR));
    // Disabled at 0: nothing imports for it. Tracearr goes on recording.
    await prisma.mediaServer.update({ where: { id: serverId }, data: { enabled: false } });
    archive.add(play("q-unread", at(2 * HOUR)), play("x-recent", at(20 * HOUR), { rating_key: "300" }));
    vi.setSystemTime(at(22 * HOUR));
    expect((await syncTracearrHistory(serverId, { passes: "forward" })).count).toBe(0);

    // Re-enabled: the save queues the backfill slice, which runs on the serial
    // queue — and runs the recovery pass — before any catch-up.
    vi.setSystemTime(at(24 * HOUR));
    await prisma.mediaServer.update({ where: { id: serverId }, data: { enabled: true } });
    const task = taskList[TASK_TRACEARR_BACKFILL] as (payload: unknown, helpers: unknown) => Promise<void>;
    await task({ serverId }, {});
    expect(await storedIds()).toEqual(["a-old"]);

    // The next watch-history sync — a play event, the schedule, a Refresh.
    vi.setSystemTime(at(25 * HOUR));
    archive.clearRequests();
    await syncWatchHistory(serverId);
    expect(archive.requests[0].since).toEqual(at(-3 * HOUR));
    expect(await storedIds()).toEqual(["a-old", "q-unread", "x-recent"]);
  });

  it("bounds an archive with no stored rows by its forward watermark", async () => {
    // Walked, nothing storable: the forward window starts an hour below the
    // watermark.
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrForwardWatermarkAt: at(-2 * HOUR), tracearrBackfillLastWalkAt: at(-2 * HOUR) },
    });
    archive.add(
      play("x-old", at(-5 * HOUR), { rating_key: "300" }),
      play("q-unread", at(-30 * 60 * 1000)),
      play("x-new", at(HOUR), { rating_key: "300" }),
    );

    vi.setSystemTime(at(2 * HOUR));
    await recoverHistoryForNewItems(serverId);
    // Below the watermark: recovered. Above it: the forward walk's.
    expect(await storedIds()).toEqual(["x-old"]);

    vi.setSystemTime(at(3 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual(["q-unread", "x-new", "x-old"]);
  });
});

describe("an item whose plays the pass left to the catch-up (real DB)", () => {
  // The catch-up can step over a play it cannot place: a History-page Refresh
  // runs outside the serial queue, and one whose join index was built before
  // the item existed reads the play as unresolved while moving MAX past it.
  // Settled, the item was never asked about again and the play was lost.
  const MIN = 60 * 1000;

  beforeEach(async () => {
    await cleanDatabase();
    resetRecoveryAnswers();
    vi.clearAllMocks();
    for (const fn of Object.values(m)) fn.mockReset();
    archive = new FakeTracearrArchive();
    m.findOldestPlayAt.mockImplementation(async (id: string) => archive.oldest(id));
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    m.enqueueJob.mockResolvedValue(true);
    m.getHistoryForItem.mockImplementation(async (id: string, filter: { ratingKey?: string }) =>
      filter.ratingKey
        ? archive.page(id, { pageSize: 1000 }).records.filter((record) => record.rating_key === filter.ratingKey)
        : [],
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks again a day later, and stores the play a stale-index Refresh stepped over", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, {
      tracearrServerId: TRACEARR_SERVER_ID,
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: at(-DAY),
    });
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(library.id, { ratingKey: "rk-y", type: "MOVIE", title: "Y" });
    const z = await createTestMediaItem(library.id, { ratingKey: "rk-z", type: "MOVIE", title: "Z" });
    await prisma.tracearrInstance.create({
      data: { userId: user.id, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
    // A walked archive whose newest stored play is three hours old.
    await prisma.watchHistory.create({
      data: {
        mediaItemId: z.id,
        mediaServerId: server.id,
        serverUsername: "walter",
        watchedAt: at(-180 * MIN),
        source: "TRACEARR",
        sourceEventId: "z0",
        watched: true,
        state: "stopped",
      },
    });
    // X — not in the library yet — played two hours ago, Y ten minutes ago.
    archive.add(
      play("z0", at(-180 * MIN), { rating_key: "rk-z" }),
      play("p-x", at(-120 * MIN), { rating_key: "rk-x" }),
      play("n-y", at(-10 * MIN), { rating_key: "rk-y" }),
    );

    // The Refresh's first page is held (a slow or rate-limited answer).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inPage = new Promise<void>((resolve) => (entered = resolve));
    let first = true;
    m.getHistoryPage.mockImplementation(async (id: string, options: object) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return archive.page(id, options);
    });
    const refresh = syncTracearrHistory(server.id, { passes: "forward" });
    await inPage; // its join index is built, without X

    // The incremental sync adds X, and the backfill job's recovery pass runs.
    await createTestMediaItem(library.id, { ratingKey: "rk-x", type: "MOVIE", title: "X" });
    await recoverHistoryForNewItems(server.id);
    release();
    await refresh;
    // The Refresh stored Y's play and stepped over X's; MAX is past it now.
    expect(await storedIds()).toEqual(["n-y", "z0"]);

    // Every later catch-up starts above it.
    m.getHistoryPage.mockImplementation(async (id: string, options: object) => archive.page(id, options));
    await syncTracearrHistory(server.id, { passes: "forward" });
    await recoverHistoryForNewItems(server.id);
    expect(await storedIds()).toEqual(["n-y", "z0"]);

    // A day on, X is asked about again, and its play is old enough to store.
    vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
    await recoverHistoryForNewItems(server.id);
    expect(await storedIds()).toEqual(["n-y", "p-x", "z0"]);
  });
});
