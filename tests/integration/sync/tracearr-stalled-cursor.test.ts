import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import { TRACEARR_SERVER_ID, play } from "./fake-tracearr-archive";

/**
 * A Tracearr history cursor that stops advancing, end to end: the real
 * importer, the real backfill task and the real watch-history sync, against
 * real Postgres, with only Tracearr's HTTP answers and the job queue's enqueue
 * faked.
 *
 * A repeated cursor used to end the walk as a resumable "stopped", which the
 * backfill task re-queues at once — so a Tracearr that kept handing back the
 * same position had every slice re-walk the same pages (rebuilding the join
 * index and re-walking `/users` each time) on the serial MAIN_QUEUE, forever,
 * without the job ever parking.
 */

const m = vi.hoisted(() => ({
  getHistoryPage: vi.fn(),
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
// every 2s so a yield can be driven without waiting out the interval.
vi.mock("@/lib/sync/cancel-watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cancel-watch")>();
  return {
    ...actual,
    watchForCancel: (isCancelled: () => Promise<boolean>) => actual.watchForCancel(isCancelled, 10),
  };
});

import { taskList } from "@/lib/jobs/tasks";
import { TASK_TRACEARR_BACKFILL } from "@/lib/jobs/constants";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";

const prisma = getTestPrisma();
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * DAY);

let serverId: string;

/** Invoke the backfill task the way graphile-worker does: through `taskList`. */
function runBackfillTask(): Promise<void> {
  const task = taskList[TASK_TRACEARR_BACKFILL] as (payload: unknown, helpers: unknown) => Promise<void>;
  return task({ serverId }, {});
}

function backfillEnqueues() {
  return m.enqueueJob.mock.calls.filter((args) => args[0] === TASK_TRACEARR_BACKFILL);
}

async function serverRow() {
  return prisma.mediaServer.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      tracearrBackfillCursorAt: true,
      tracearrBackfillComplete: true,
      tracearrBackfillLastWalkAt: true,
      tracearrForwardFloorAt: true,
    },
  });
}

/** A first page, then a second whose `nextCursor` repeats the one it was asked with. */
function stallAfterTwoPages() {
  m.getHistoryPage
    .mockResolvedValueOnce({
      records: [play("r1", daysAgo(1)), play("r2", daysAgo(2), { rating_key: "missing" })],
      nextCursor: "c1",
    })
    .mockResolvedValueOnce({
      records: [play("r3", daysAgo(3))],
      nextCursor: "c1",
    });
}

describe("a Tracearr history cursor that stops advancing (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    // Reset, not just cleared: a once-implementation a failed test never
    // consumed must not leak into the next one.
    for (const fn of Object.values(m)) fn.mockReset();
    m.enqueueJob.mockResolvedValue(true);
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    m.findOldestPlayAt.mockResolvedValue(null);
    const user = await createTestUser();
    const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_ID });
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" });
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

  it("fails the backfill slice so the worker backs off, keeping the rows and the reach its pages made", async () => {
    stallAfterTwoPages();

    const failure = runBackfillTask();

    // Thrown, so graphile-worker retries with backoff and `maxAttempts` parks
    // it — under a message that names the stall, not an unreachable Tracearr.
    await expect(failure).rejects.toThrow(/history cursor stopped advancing/);
    await expect(failure).rejects.not.toThrow(/could not (reach|be reached)/);
    expect(backfillEnqueues()).toHaveLength(0);
    expect(m.getHistoryPage).toHaveBeenCalledTimes(2);

    // Both pages committed before the repeat was seen.
    const stored = await prisma.watchHistory.findMany({ select: { sourceEventId: true } });
    expect(stored.map((r) => r.sourceEventId).sort()).toEqual(["r1", "r3"]);
    // How far they reached is kept, so the retry resumes below it — and an
    // errored walk is neither complete nor recorded as having walked.
    expect(await serverRow()).toMatchObject({
      tracearrBackfillCursorAt: daysAgo(3),
      tracearrBackfillComplete: false,
      tracearrBackfillLastWalkAt: null,
    });

    // The retry the backoff brings resumes from that reach, not the top.
    m.getHistoryPage.mockResolvedValueOnce({ records: [play("r4", daysAgo(4))], nextCursor: null });
    const retry = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(m.getHistoryPage.mock.calls.at(-1)?.[1]).toMatchObject({ until: daysAgo(3) });
    expect(retry).toMatchObject({ backfillOutcome: "exhausted", backfillPending: false });
  });

  it("reports a forward walk's stall to the Refresh as a failure that says what happened", async () => {
    // A stored play, so the forward window exists.
    const item = await prisma.mediaItem.findFirstOrThrow();
    await prisma.watchHistory.create({
      data: {
        mediaItemId: item.id,
        mediaServerId: serverId,
        serverUsername: "walter",
        watchedAt: daysAgo(10),
        source: "TRACEARR",
        sourceEventId: "stored",
        watched: true,
        state: "stopped",
      },
    });
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillComplete: true },
    });
    m.getHistoryPage
      .mockResolvedValueOnce({ records: [play("new-1", daysAgo(1))], nextCursor: "c1" })
      .mockResolvedValueOnce({ records: [], nextCursor: "c1" });

    const result = await syncWatchHistory(serverId);

    expect(result.failed).toMatch(/history cursor stopped advancing while importing new plays/);
    expect(result.failed).not.toMatch(/could not be reached/);
    // What it read before the stall is kept, and the hole it may have left
    // below the new watermark is recorded for the next run.
    expect(result.count).toBe(1);
    expect((await serverRow()).tracearrForwardFloorAt).toEqual(new Date(daysAgo(10).getTime() - 60 * 60 * 1000));
  });

  it("still re-queues a slice that merely ran out of time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    m.getHistoryPage.mockImplementationOnce(async () => {
      // The page in flight outlives the five-minute slice.
      vi.setSystemTime(Date.now() + 6 * 60_000);
      return { records: [play("r1", daysAgo(1))], nextCursor: "c1" };
    });

    await expect(runBackfillTask()).resolves.toBeUndefined();

    expect(m.getHistoryPage).toHaveBeenCalledTimes(1);
    expect(backfillEnqueues()).toHaveLength(1);
  });

  it("still re-queues a slice that gave way to a requested sync", async () => {
    m.getHistoryPage.mockImplementationOnce(async () => {
      // A Sync button press while the page is in flight: the route's PENDING row.
      await prisma.syncJob.create({ data: { mediaServerId: serverId, status: "PENDING" } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { records: [play("r1", daysAgo(1))], nextCursor: "c1" };
    });

    await expect(runBackfillTask()).resolves.toBeUndefined();

    expect(m.getHistoryPage).toHaveBeenCalledTimes(1);
    expect(backfillEnqueues()).toHaveLength(1);
  });

  it("still re-queues a slice the page cap stopped, since its cursor kept moving", async () => {
    let page = 0;
    m.getHistoryPage.mockImplementation(async () => ({ records: [], nextCursor: `c${++page}` }));

    await expect(runBackfillTask()).resolves.toBeUndefined();

    expect(m.getHistoryPage).toHaveBeenCalledTimes(20_000);
    expect(backfillEnqueues()).toHaveLength(1);
  });
});
