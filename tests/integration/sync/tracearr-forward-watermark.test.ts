import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { FakeTracearrArchive, play } from "./fake-tracearr-archive";
import { answerFrom, seedMappedServer, serverRow, storedIds, tracearr } from "./tracearr-import-kit";

// The forward watermark of a Tracearr archive with NO stored rows
// (`tracearrForwardWatermarkAt`): the forward pass's only resume point there,
// during an unfinished walk as well as after it.

vi.mock("@/lib/db", async () => ({ prisma: (await import("../../setup/test-db")).getTestPrisma() }));
vi.mock("@/lib/logger", async () => (await import("./tracearr-import-kit")).loggerModule());
// Small pages, so a slice's deadline lands mid-archive.
vi.mock("@/lib/tracearr/tracearr-client", async () => (await import("./tracearr-import-kit")).clientModule(2));

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { releaseLibraryResyncHold, requireLibraryResync, restartTracearrBackfill } from "@/lib/media/watch-evidence";

const prisma = getTestPrisma();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-03-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A play of media no longer in the library: read by the walk, never stored. */
const unstorable = (id: string, when: Date) => play(id, when, { rating_key: "missing" });

let archive: FakeTracearrArchive;
let serverId: string;

const row = () => serverRow(serverId);
const setState = (data: Parameters<typeof prisma.mediaServer.update>[0]["data"]) =>
  prisma.mediaServer.update({ where: { id: serverId }, data });
/** The `since` of every FORWARD request (the backfill sends `until` instead). */
const forwardSinces = () => archive.requests.filter((r) => r.since).map((r) => r.since);
const forward = () => syncTracearrHistory(serverId, { passes: "forward" });
const backfill = (deadlineMs?: number) => syncTracearrHistory(serverId, { passes: "backfill", deadlineMs });
/** Move the clock and forget earlier requests. */
function now(when: Date) {
  vi.setSystemTime(when);
  archive.clearRequests();
}

describe("Tracearr forward watermark for an archive with no stored rows (real DB)", () => {
  beforeEach(async () => {
    archive = new FakeTracearrArchive();
    answerFrom(() => archive);
    ({ serverId } = await seedMappedServer());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("reads a play made during a walk that took longer than a week, once the walk completes", async () => {
    archive.add(unstorable("old-1", at(-30 * DAY)), unstorable("old-2", at(-29 * DAY)), unstorable("old-3", at(-28 * DAY)));
    // The first slice: one page, nothing storable. The walk began from the
    // newest play, so everything older is its to read.
    expect(await backfill(Date.now() - 1)).toMatchObject({ count: 0, backfillPending: true, backfillOutcome: "stopped" });
    expect((await row()).tracearrForwardWatermarkAt).toEqual(T0);

    // A play a day in; the walk then stalls for days.
    archive.add(play("during", at(DAY)));
    vi.setSystemTime(at(10 * DAY));
    expect(await backfill()).toMatchObject({ count: 0, backfillPending: false, backfillOutcome: "exhausted" });
    expect(await prisma.watchHistory.count()).toBe(0);

    // Resumed from the watermark, not "last walk − 7 days" (after the play).
    now(at(10 * DAY + HOUR));
    expect((await forward()).count).toBe(1);
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect(await storedIds()).toEqual(["during"]);
  });

  it("imports a play made during an unfinished walk, and the walk carries on from its own cursor", async () => {
    archive.add(unstorable("old-1", at(-3 * DAY)), unstorable("old-2", at(-2 * DAY)), unstorable("old-3", at(-DAY)));
    await backfill(Date.now() - 1);
    expect((await row()).tracearrBackfillCursorAt).toEqual(at(-2 * DAY));

    archive.add(play("during", at(30 * 60 * 1000)));
    now(at(2 * HOUR));
    expect(await forward()).toMatchObject({ count: 1, backfillPending: true });
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect(await storedIds()).toEqual(["during"]);
    // Having read its whole window, it moves the watermark up to its own start.
    expect((await row()).tracearrForwardWatermarkAt).toEqual(at(2 * HOUR));

    // The cursor wins over MIN(watchedAt): nothing between is stepped over.
    now(at(3 * HOUR));
    expect(await backfill()).toMatchObject({ backfillPending: false, backfillOutcome: "exhausted" });
    expect(archive.requests[0].until).toEqual(at(-2 * DAY));
  });

  it.each([
    ["the first slice failed before committing a page, and a forward pass then stored rows", false],
    // Tracearr's `since` selects a resumed chain by any session but files it
    // under its first, so the row puts MIN below the forward window.
    ["the forward pass filed a resumed chain below its window", true],
  ])("resumes the walk at the watermark when %s", async (_label, resumed) => {
    archive.add(play("gap", at(-2 * HOUR)), unstorable("gone", at(-DAY)), play("after", at(HOUR)));
    if (resumed) archive.addResumed(play("in-window", at(-5 * HOUR)), at(-30 * 60 * 1000));
    else archive.add(play("in-window", at(-30 * 60 * 1000)));
    tracearr.getHistoryPage.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await backfill()).backfillOutcome).toBe("errored");
    expect(await row()).toMatchObject({ tracearrForwardWatermarkAt: T0, tracearrBackfillCursorAt: null });

    now(at(2 * HOUR));
    await forward();
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    const rows = await prisma.watchHistory.findMany({ orderBy: { sourceEventId: "asc" } });
    expect(rows.map((r) => [r.sourceEventId, r.watchedAt])).toEqual([
      ["after", at(HOUR)],
      ["in-window", resumed ? at(-5 * HOUR) : at(-30 * 60 * 1000)],
    ]);

    // At the watermark (moved up to the forward walk's start), not below MIN.
    now(at(3 * HOUR));
    expect(await backfill()).toMatchObject({ backfillPending: false, backfillOutcome: "exhausted" });
    expect(archive.requests[0].until).toEqual(at(2 * HOUR));
    expect(await storedIds()).toEqual(["after", "gap", "in-window"]);
  });

  it("resumes the forward pass from a restart's instant minus the overlap", async () => {
    vi.useRealTimers();
    await setState({ tracearrBackfillComplete: true, tracearrBackfillLastWalkAt: new Date() });
    await restartTracearrBackfill([serverId]);
    const watermark = (await row()).tracearrForwardWatermarkAt!;
    expect(watermark).toBeInstanceOf(Date);

    archive.add(play("since-restart", new Date(watermark.getTime() - 10 * 60 * 1000)));
    expect((await forward()).count).toBe(1);
    expect(forwardSinces()).toEqual([new Date(watermark.getTime() - HOUR)]);
  });

  it("keeps the old 'last walk − 7 days' fallback for a finished archive whose watermark predates the column", async () => {
    await setState({ tracearrBackfillComplete: true, tracearrBackfillLastWalkAt: at(-2 * DAY), tracearrForwardWatermarkAt: null });
    archive.add(unstorable("gone", at(-3 * DAY)));

    await forward();
    expect(forwardSinces()).toEqual([at(-9 * DAY)]);
    // It records the watermark from now on, and leaves the backfill's own stamp alone.
    expect(await row()).toMatchObject({ tracearrForwardWatermarkAt: T0, tracearrBackfillLastWalkAt: at(-2 * DAY) });

    now(at(DAY));
    await forward();
    expect(forwardSinces()).toEqual([at(-HOUR)]);
  });

  it("does not move the watermark while the server's items are known to be missing", async () => {
    // Moved past the missing items' skipped plays, it would leave them unread.
    await requireLibraryResync([serverId]);
    expect((await row()).tracearrForwardWatermarkAt).toEqual(T0);

    archive.add(unstorable("purged-item-play", at(HOUR)));
    now(at(2 * HOUR));
    await forward();
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect((await row()).tracearrForwardWatermarkAt).toEqual(T0);

    // After the releasing sync: the held stretch is read again, then it moves on.
    expect(await releaseLibraryResyncHold(serverId, at(3 * HOUR))).toBe(true);
    now(at(4 * HOUR));
    await forward();
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect((await row()).tracearrForwardWatermarkAt).toEqual(at(4 * HOUR));
  });

  it("does not overwrite a restart that lands while a forward walk runs", async () => {
    await setState({ tracearrForwardWatermarkAt: at(-DAY), tracearrBackfillCursorAt: at(-5 * DAY) });
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      vi.setSystemTime(at(60 * 1000));
      await restartTracearrBackfill([serverId]);
      return archive.page(id, options);
    });

    await forward();

    // The restart's instant, not the walk's earlier start.
    expect((await row()).tracearrForwardWatermarkAt).toEqual(at(60 * 1000));
  });

  it("never moves an existing watermark when a walk starts from the newest play again", async () => {
    // Moving it later would skip plays the earlier watermark still owes the forward pass.
    await setState({ tracearrForwardWatermarkAt: at(-5 * DAY) });
    archive.add(unstorable("gone", at(-DAY)));

    await backfill();

    expect(archive.requests[0].until).toEqual(at(-5 * DAY));
    expect((await row()).tracearrForwardWatermarkAt).toEqual(at(-5 * DAY));
  });

  it("does not move the watermark on a forward walk without the account map, and records the floor instead", async () => {
    await setState({ tracearrForwardWatermarkAt: at(-DAY), tracearrBackfillCursorAt: at(-5 * DAY) });
    archive.add(play("labelled", at(-2 * HOUR)));
    tracearr.getServerAccountNames.mockRejectedValueOnce(new Error("users down"));
    const username = async () =>
      (await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "labelled" } })).serverUsername;

    await forward();

    expect(forwardSinces()).toEqual([at(-DAY - HOUR)]);
    expect(await row()).toMatchObject({ tracearrForwardWatermarkAt: at(-DAY), tracearrForwardFloorAt: at(-DAY - HOUR) });
    expect(await username()).toBe("Walter W");

    // The next healthy run reaches the floor, re-labels and pays it.
    now(at(HOUR));
    await forward();
    expect(forwardSinces()).toEqual([at(-DAY - HOUR)]);
    expect(await username()).toBe("walter");
    expect((await row()).tracearrForwardFloorAt).toBeNull();
  });

  it("lets a Refresh overlap the first slice: both land, and neither moves the other's resume point", async () => {
    archive.add(
      play("x", at(-30 * 60 * 1000)),
      unstorable("old-3", at(-DAY)),
      unstorable("old-2", at(-2 * DAY)),
      unstorable("old-1", at(-3 * DAY)),
    );
    let refresh: Awaited<ReturnType<typeof syncTracearrHistory>> | undefined;
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      vi.setSystemTime(at(60 * 1000));
      refresh = await forward();
      return archive.page(id, options);
    });

    const slice = await backfill(0);

    // The Refresh read from the watermark the slice recorded as it began.
    expect(refresh).toMatchObject({ count: 1, backfillPending: true });
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect(slice).toMatchObject({ backfillOutcome: "stopped", backfillPending: true });
    expect(await prisma.watchHistory.count({ where: { sourceEventId: "x" } })).toBe(1);
    // The Refresh moved the watermark to its start; the slice's cursor is its page's reach.
    expect(await row()).toMatchObject({ tracearrForwardWatermarkAt: at(60 * 1000), tracearrBackfillCursorAt: at(-DAY) });

    now(at(HOUR));
    await backfill();
    expect(archive.requests[0].until).toEqual(at(-DAY));
    expect((await row()).tracearrBackfillComplete).toBe(true);
  });

  it("leaves the watermark alone when the library is empty", async () => {
    await setState({ tracearrForwardWatermarkAt: at(-DAY), tracearrBackfillComplete: true });
    await prisma.mediaItem.deleteMany({});
    archive.add(play("p", new Date()));

    expect(await forward()).toEqual({ count: 0, backfillPending: false });
    expect(archive.requests).toHaveLength(0);
    expect((await row()).tracearrForwardWatermarkAt).toEqual(at(-DAY));
  });
});
