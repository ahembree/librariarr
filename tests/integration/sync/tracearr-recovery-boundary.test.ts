import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestMediaItem } from "../../setup/test-helpers";
import { FakeTracearrArchive, play } from "./fake-tracearr-archive";
import { answerFrom, seedMappedServer, storeTracearrPlay, storedIds, tracearr } from "./tracearr-import-kit";

// The recovery pass for re-added items stores only plays at or below the
// forward boundary: stored, a newer play moved MAX(watchedAt) — where the next
// forward window starts — past every other item's play no walk had read.

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

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { RECOVERY_REASK_MS, recoverHistoryForNewItems, resetRecoveryAnswers } from "@/lib/sync/tracearr-backfill-additions";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { taskList } from "@/lib/jobs/tasks";
import { TASK_TRACEARR_BACKFILL } from "@/lib/jobs/constants";

const prisma = getTestPrisma();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T = new Date("2026-06-10T12:00:00.000Z").getTime();
const at = (offset: number) => new Date(T + offset);

let archive: FakeTracearrArchive;
let serverId: string;
let libraryId: string;
let favouriteId: string;

const forward = () => syncTracearrHistory(serverId, { passes: "forward" });
/** Move the clock and forget earlier requests. */
function now(when: Date) {
  vi.setSystemTime(when);
  archive.clearRequests();
}

describe("the recovery pass leaves plays newer than the forward boundary to the forward walk (real DB)", () => {
  beforeEach(async () => {
    resetRecoveryAnswers();
    archive = new FakeTracearrArchive();
    answerFrom(() => archive);
    enqueueJob.mockReset().mockResolvedValue(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    ({ serverId, libraryId, itemId: favouriteId } = await seedMappedServer({
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: at(-DAY),
    }));
    await prisma.mediaItem.update({ where: { id: favouriteId }, data: { createdAt: at(-60 * DAY) } });
    // Recently added: the recovery pass's candidate.
    const added = await createTestMediaItem(libraryId, { ratingKey: "300", type: "MOVIE", title: "Just Added" });
    await prisma.mediaItem.update({ where: { id: added.id }, data: { createdAt: at(-DAY) } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /** A play of the long-held favourite, in the archive and stored two hours ago. */
  async function storedFavouritePlay() {
    archive.add(play("a-old", at(-2 * HOUR)));
    await storeTracearrPlay(favouriteId, serverId, "a-old", at(-2 * HOUR));
  }

  it("does not move the forward window past an unread play by storing a recent one", async () => {
    await storedFavouritePlay();
    // Neither read yet: a play of the favourite, and the new item's.
    archive.add(play("q-unread", at(HOUR)), play("x-recent", at(3 * HOUR), { rating_key: "300" }));

    vi.setSystemTime(at(3.5 * HOUR));
    await recoverHistoryForNewItems(serverId);
    expect(await storedIds()).toEqual(["a-old"]);

    now(at(4 * HOUR));
    await forward();
    expect(archive.requests[0].since).toEqual(at(-3 * HOUR));
    expect(await storedIds()).toEqual(["a-old", "q-unread", "x-recent"]);
  });

  it("still recovers the new item's OLD plays in the same pass", async () => {
    await storedFavouritePlay();
    archive.add(play("x-old", at(-40 * DAY), { rating_key: "300" }), play("x-recent", at(3 * HOUR), { rating_key: "300" }));

    vi.setSystemTime(at(3.5 * HOUR));
    expect(await recoverHistoryForNewItems(serverId)).toEqual({ checked: 1, imported: 1 });
    expect(await storedIds()).toEqual(["a-old", "x-old"]);
  });

  it("keeps an unread play when the server comes back after a day off and its queued slice recovers first", async () => {
    await storedFavouritePlay();
    // Disabled at 0: nothing imports for it, while Tracearr goes on recording.
    await prisma.mediaServer.update({ where: { id: serverId }, data: { enabled: false } });
    archive.add(play("q-unread", at(2 * HOUR)), play("x-recent", at(20 * HOUR), { rating_key: "300" }));
    vi.setSystemTime(at(22 * HOUR));
    expect((await forward()).count).toBe(0);

    // Re-enabled: the save queues the backfill slice, whose recovery pass runs before any catch-up.
    vi.setSystemTime(at(24 * HOUR));
    await prisma.mediaServer.update({ where: { id: serverId }, data: { enabled: true } });
    const task = taskList[TASK_TRACEARR_BACKFILL] as (payload: unknown, helpers: unknown) => Promise<void>;
    await task({ serverId }, {});
    expect(await storedIds()).toEqual(["a-old"]);

    now(at(25 * HOUR));
    await syncWatchHistory(serverId);
    expect(archive.requests[0].since).toEqual(at(-3 * HOUR));
    expect(await storedIds()).toEqual(["a-old", "q-unread", "x-recent"]);
  });

  it("bounds an archive with no stored rows by its forward watermark", async () => {
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrForwardWatermarkAt: at(-2 * HOUR), tracearrBackfillLastWalkAt: at(-2 * HOUR) },
    });
    archive.add(
      play("x-old", at(-5 * HOUR), { rating_key: "300" }),
      play("q-unread", at(-30 * MIN)),
      play("x-new", at(HOUR), { rating_key: "300" }),
    );

    vi.setSystemTime(at(2 * HOUR));
    await recoverHistoryForNewItems(serverId);
    // Below the watermark: recovered. Above it: the forward walk's.
    expect(await storedIds()).toEqual(["x-old"]);

    vi.setSystemTime(at(3 * HOUR));
    await forward();
    expect(await storedIds()).toEqual(["q-unread", "x-new", "x-old"]);
  });

  it("re-asks an item whose play it left to the catch-up a day later, storing what a stale-index Refresh stepped over", async () => {
    // A Refresh runs outside the serial queue; one whose join index predates
    // the item reads its play as unresolved while moving MAX past it.
    await createTestMediaItem(libraryId, { ratingKey: "rk-y", type: "MOVIE", title: "Y" });
    await storeTracearrPlay(favouriteId, serverId, "z0", at(-180 * MIN));
    // X — not in the library yet — played two hours ago, Y ten minutes ago.
    archive.add(
      play("z0", at(-180 * MIN)),
      play("p-x", at(-120 * MIN), { rating_key: "rk-x" }),
      play("n-y", at(-10 * MIN), { rating_key: "rk-y" }),
    );

    // The Refresh's first page is held (a slow or rate-limited answer).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inPage = new Promise<void>((resolve) => (entered = resolve));
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      entered();
      await gate;
      return archive.page(id, options);
    });
    const refresh = forward();
    await inPage; // its join index is built, without X

    // The incremental sync adds X, and the backfill job's recovery pass runs.
    await createTestMediaItem(libraryId, { ratingKey: "rk-x", type: "MOVIE", title: "X" });
    await recoverHistoryForNewItems(serverId);
    release();
    await refresh;
    expect(await storedIds()).toEqual(["n-y", "z0"]);

    // Every later catch-up starts above it.
    await forward();
    await recoverHistoryForNewItems(serverId);
    expect(await storedIds()).toEqual(["n-y", "z0"]);

    // A day on, X is asked again, and its play is old enough to store.
    vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
    await recoverHistoryForNewItems(serverId);
    expect(await storedIds()).toEqual(["n-y", "p-x", "z0"]);
  });
});
