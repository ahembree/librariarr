import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { FakeTracearrArchive, play } from "./fake-tracearr-archive";
import { answerFrom, seedMappedServer, serverRow, storeTracearrPlay, storedIds, tracearr } from "./tracearr-import-kit";

// A Tracearr history cursor that stops advancing, through the real backfill
// task and watch-history sync: as a resumable stop it re-queued the same pages
// forever without the job ever parking.

const enqueueJob = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", async () => ({ prisma: (await import("../../setup/test-db")).getTestPrisma() }));
vi.mock("@/lib/logger", async () => (await import("./tracearr-import-kit")).loggerModule());
vi.mock("@/lib/tracearr/tracearr-client", async () => (await import("./tracearr-import-kit")).clientModule(100));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob, isJobRetrying: vi.fn(async () => false) }));
// The real "is a requested sync waiting" watch, polled every 10ms instead of 2s.
vi.mock("@/lib/sync/cancel-watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cancel-watch")>();
  return { ...actual, watchForCancel: (isCancelled: () => Promise<boolean>) => actual.watchForCancel(isCancelled, 10) };
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
let itemId: string;

/** The backfill task, invoked the way graphile-worker does. */
function runBackfillTask(): Promise<void> {
  const task = taskList[TASK_TRACEARR_BACKFILL] as (payload: unknown, helpers: unknown) => Promise<void>;
  return task({ serverId }, {});
}
const backfillEnqueues = () => enqueueJob.mock.calls.filter((args) => args[0] === TASK_TRACEARR_BACKFILL);

describe("a Tracearr history cursor that stops advancing (real DB)", () => {
  beforeEach(async () => {
    const archive = new FakeTracearrArchive();
    answerFrom(() => archive);
    enqueueJob.mockReset().mockResolvedValue(true);
    ({ serverId, itemId } = await seedMappedServer());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("fails the backfill slice so the worker backs off, keeping the rows and the reach its pages made", async () => {
    // A second page whose `nextCursor` repeats the one it was asked with.
    tracearr.getHistoryPage
      .mockResolvedValueOnce({
        records: [play("r1", daysAgo(1)), play("r2", daysAgo(2), { rating_key: "missing" })],
        nextCursor: "c1",
      })
      .mockResolvedValueOnce({ records: [play("r3", daysAgo(3))], nextCursor: "c1" });

    const failure = runBackfillTask();

    // Thrown with a message naming the stall, so graphile backs off and parks it.
    await expect(failure).rejects.toThrow(/history cursor stopped advancing/);
    await expect(failure).rejects.not.toThrow(/could not (reach|be reached)/);
    expect(backfillEnqueues()).toHaveLength(0);
    expect(tracearr.getHistoryPage).toHaveBeenCalledTimes(2);

    // Both pages committed; their reach is kept, and an errored walk is
    // neither complete nor recorded as having walked.
    expect(await storedIds()).toEqual(["r1", "r3"]);
    expect(await serverRow(serverId)).toMatchObject({
      tracearrBackfillCursorAt: daysAgo(3),
      tracearrBackfillComplete: false,
      tracearrBackfillLastWalkAt: null,
    });

    // The retry resumes from that reach, not the top.
    tracearr.getHistoryPage.mockResolvedValueOnce({ records: [play("r4", daysAgo(4))], nextCursor: null });
    const retry = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(tracearr.getHistoryPage.mock.calls.at(-1)?.[1]).toMatchObject({ until: daysAgo(3) });
    expect(retry).toMatchObject({ backfillOutcome: "exhausted", backfillPending: false });
  });

  it("reports a forward walk's stall to the Refresh as a failure that says what happened", async () => {
    await storeTracearrPlay(itemId, serverId, "stored", daysAgo(10));
    await prisma.mediaServer.update({ where: { id: serverId }, data: { tracearrBackfillComplete: true } });
    tracearr.getHistoryPage
      .mockResolvedValueOnce({ records: [play("new-1", daysAgo(1))], nextCursor: "c1" })
      .mockResolvedValueOnce({ records: [], nextCursor: "c1" });

    const result = await syncWatchHistory(serverId);

    expect(result.failed).toMatch(/history cursor stopped advancing while importing new plays/);
    expect(result.failed).not.toMatch(/could not be reached/);
    // What it read is kept, and the hole below the new watermark is recorded.
    expect(result.count).toBe(1);
    expect((await serverRow(serverId)).tracearrForwardFloorAt).toEqual(new Date(daysAgo(10).getTime() - 60 * 60 * 1000));
  });

  it.each([
    [
      "ran out of time",
      () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        tracearr.getHistoryPage.mockImplementationOnce(async () => {
          // The page in flight outlives the five-minute slice.
          vi.setSystemTime(Date.now() + 6 * 60_000);
          return { records: [play("r1", daysAgo(1))], nextCursor: "c1" };
        });
      },
      1,
    ],
    [
      "gave way to a requested sync",
      () =>
        tracearr.getHistoryPage.mockImplementationOnce(async () => {
          // A Sync button press while the page is in flight: the route's PENDING row.
          await prisma.syncJob.create({ data: { mediaServerId: serverId, status: "PENDING" } });
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { records: [play("r1", daysAgo(1))], nextCursor: "c1" };
        }),
      1,
    ],
    [
      "was stopped by the page cap, its cursor moving all along",
      () => {
        let page = 0;
        tracearr.getHistoryPage.mockImplementation(async () => ({ records: [], nextCursor: `c${++page}` }));
      },
      20_000,
    ],
  ])("still re-queues a slice that %s", async (_label, answer, pages) => {
    answer();

    await expect(runBackfillTask()).resolves.toBeUndefined();

    expect(tracearr.getHistoryPage).toHaveBeenCalledTimes(pages);
    expect(backfillEnqueues()).toHaveLength(1);
  });
});
