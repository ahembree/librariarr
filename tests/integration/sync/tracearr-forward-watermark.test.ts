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
 * The forward watermark of a Tracearr archive with NO stored rows
 * (`MediaServer.tracearrForwardWatermarkAt`), against real Postgres and a fake
 * of Tracearr's history keyset that honours `since`/`until` — so a window that
 * starts too late visibly misses a play.
 *
 * With rows, the forward pass resumes from `MAX(watchedAt)`. Without any (every
 * play the walk has read references media that left the library), it used to
 * resume from `tracearrBackfillLastWalkAt − 7 days` once the walk completed and
 * not run at all before that: a play made during a walk that took longer than a
 * week was read by nothing, ever, and one made during an unfinished walk waited
 * for its end.
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
  // Small pages, so a slice's deadline lands mid-archive.
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
import {
  releaseLibraryResyncHold,
  requireLibraryResync,
  restartTracearrBackfill,
} from "@/lib/media/watch-evidence";

const prisma = getTestPrisma();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-03-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A play of media no longer in the library: read by the walk, never stored. */
const unstorable = (id: string, when: Date) => play(id, when, { rating_key: "missing" });

let archive: FakeTracearrArchive;
let serverId: string;

async function serverRow() {
  return prisma.mediaServer.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      tracearrForwardWatermarkAt: true,
      tracearrForwardFloorAt: true,
      tracearrBackfillCursorAt: true,
      tracearrBackfillComplete: true,
      tracearrBackfillLastWalkAt: true,
      watchHistorySyncedAt: true,
    },
  });
}

const setState = (data: Parameters<typeof prisma.mediaServer.update>[0]["data"]) =>
  prisma.mediaServer.update({ where: { id: serverId }, data });

/** The `since` of every FORWARD request (the backfill sends `until` instead). */
const forwardSinces = () => archive.requests.filter((r) => r.since).map((r) => r.since);

describe("Tracearr forward watermark for an archive with no stored rows (real DB)", () => {
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

  it("reads a play made during a walk that took longer than a week, once the walk completes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    archive.add(
      unstorable("old-1", at(-30 * DAY)),
      unstorable("old-2", at(-29 * DAY)),
      unstorable("old-3", at(-28 * DAY)),
    );

    // The first slice, at T0: one page (the slice is spent), nothing storable.
    vi.setSystemTime(T0);
    const first = await syncTracearrHistory(serverId, { passes: "backfill", deadlineMs: Date.now() - 1 });
    expect(first).toMatchObject({ count: 0, backfillPending: true, backfillOutcome: "stopped" });
    // The walk began from the newest play: everything older is its to read.
    expect((await serverRow()).tracearrForwardWatermarkAt).toEqual(T0);

    // A play a day into the walk — which then stalls for days (a parked
    // instance, a failing `/users`, a long hold).
    archive.add(play("during", at(DAY)));

    vi.setSystemTime(at(10 * DAY));
    const done = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(done).toMatchObject({ count: 0, backfillPending: false, backfillOutcome: "exhausted" });
    expect(await prisma.watchHistory.count()).toBe(0);

    // Resumed from the watermark, not from "last walk − 7 days" (T0 + 3d,
    // after the play): the play is read.
    vi.setSystemTime(at(10 * DAY + HOUR));
    archive.clearRequests();
    const forward = await syncTracearrHistory(serverId, { passes: "forward" });
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect(forward.count).toBe(1);
    expect(await prisma.watchHistory.count({ where: { sourceEventId: "during" } })).toBe(1);
  });

  it("imports a play made during an unfinished walk, and the walk carries on from its own cursor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    archive.add(
      unstorable("old-1", at(-3 * DAY)),
      unstorable("old-2", at(-2 * DAY)),
      unstorable("old-3", at(-DAY)),
    );
    vi.setSystemTime(T0);
    await syncTracearrHistory(serverId, { passes: "backfill", deadlineMs: Date.now() - 1 });
    const afterSlice = await serverRow();
    expect(afterSlice.tracearrBackfillCursorAt).toEqual(at(-2 * DAY));

    // Played while the archive is still being walked. Before the watermark no
    // forward pass ran at all on an archive with no rows, until the walk ended.
    archive.add(play("during", at(30 * 60 * 1000)));
    vi.setSystemTime(at(2 * HOUR));
    archive.clearRequests();
    const forward = await syncTracearrHistory(serverId, { passes: "forward" });

    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect(forward).toMatchObject({ count: 1, backfillPending: true });
    expect(await prisma.watchHistory.count({ where: { sourceEventId: "during" } })).toBe(1);
    // Having read its whole window, it moves the watermark up to its own start.
    expect((await serverRow()).tracearrForwardWatermarkAt).toEqual(at(2 * HOUR));

    // The rows it stored do not move the walk's resume point: the cursor
    // wins over MIN(watchedAt), so nothing between is stepped over.
    archive.clearRequests();
    vi.setSystemTime(at(3 * HOUR));
    const rest = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(archive.requests[0].until).toEqual(at(-2 * DAY));
    expect(rest).toMatchObject({ backfillPending: false, backfillOutcome: "exhausted" });
  });

  it("covers the whole archive when the first slice failed before committing and a forward pass then stored rows", async () => {
    // The walk recorded its watermark, then failed on its first fetch: no
    // cursor, no rows. A forward pass then stores rows, and the next slice
    // resumes at the watermark — not below MIN(watchedAt), which a resumed
    // chain can put below the forward window (see the resumed-chain test) —
    // so the two windows meet: everything at or below the watermark is the
    // walk's, everything from an hour below it the forward pass's.
    vi.useFakeTimers({ toFake: ["Date"] });
    archive.add(
      play("before-2h", at(-2 * HOUR)),
      play("before-30m", at(-30 * 60 * 1000)),
      unstorable("gone", at(-DAY)),
    );
    vi.setSystemTime(T0);
    m.getHistoryPage.mockRejectedValueOnce(new Error("socket hang up"));
    const first = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(first.backfillOutcome).toBe("errored");
    expect(await serverRow()).toMatchObject({
      tracearrForwardWatermarkAt: T0,
      tracearrBackfillCursorAt: null,
    });

    archive.add(play("after", at(HOUR)));
    vi.setSystemTime(at(2 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    // The forward window starts an hour before the watermark: "before-2h" is
    // below it, and so the walk's.
    const stored = await prisma.watchHistory.findMany({ select: { sourceEventId: true } });
    expect(stored.map((r) => r.sourceEventId).sort()).toEqual(["after", "before-30m"]);

    archive.clearRequests();
    vi.setSystemTime(at(3 * HOUR));
    const rest = await syncTracearrHistory(serverId, { passes: "backfill" });
    // The watermark as the forward walk left it — moved up to that walk's own
    // start, having read everything from an hour below the old one.
    expect(archive.requests[0].until).toEqual(at(2 * HOUR));
    expect(rest).toMatchObject({ backfillPending: false, backfillOutcome: "exhausted" });
    const all = await prisma.watchHistory.findMany({ select: { sourceEventId: true } });
    expect(all.map((r) => r.sourceEventId).sort()).toEqual(["after", "before-2h", "before-30m"]);
  });

  it("resumes the walk at the watermark, not below a resumed chain the forward pass filed under its first session", async () => {
    // Tracearr's `since` selects a play by ANY of its sessions but files it
    // under its first session's `started_at`, so a chain begun well before the
    // forward window and resumed inside it arrives dated before the window.
    // With no cursor (the first slice failed before committing a page) that
    // row put MIN(watchedAt) below the forward window, and a backfill resuming
    // below MIN left every play between the two unread by either pass.
    vi.useFakeTimers({ toFake: ["Date"] });
    archive.add(play("gap", at(-3 * HOUR)), unstorable("ancient", at(-10 * DAY)));
    archive.addResumed(play("resumed", at(-5 * HOUR)), at(-30 * 60 * 1000));
    vi.setSystemTime(T0);
    m.getHistoryPage.mockRejectedValueOnce(new Error("socket hang up"));
    const first = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(first.backfillOutcome).toBe("errored");
    expect(await serverRow()).toMatchObject({
      tracearrForwardWatermarkAt: T0,
      tracearrBackfillCursorAt: null,
    });

    vi.setSystemTime(at(2 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    // Only the resumed chain is in the window — dated five hours back.
    expect((await prisma.watchHistory.findMany()).map((r) => [r.sourceEventId, r.watchedAt])).toEqual([
      ["resumed", at(-5 * HOUR)],
    ]);

    archive.clearRequests();
    vi.setSystemTime(at(3 * HOUR));
    const rest = await syncTracearrHistory(serverId, { passes: "backfill" });
    // At the watermark (moved up to the forward walk's start, which read
    // everything above the old one less an hour) — not below MIN at -5h.
    expect(archive.requests[0].until).toEqual(at(2 * HOUR));
    expect(rest).toMatchObject({ backfillPending: false, backfillOutcome: "exhausted" });
    const all = await prisma.watchHistory.findMany({ select: { sourceEventId: true } });
    expect(all.map((r) => r.sourceEventId).sort()).toEqual(["gap", "resumed"]);
  });

  it("resumes the forward pass from a restart's instant minus the overlap", async () => {
    // A restart (a purge emptied the rows) moves the watermark to "now": every
    // older play is the restarted walk's, every newer one the forward pass's.
    await setState({ tracearrBackfillComplete: true, tracearrBackfillLastWalkAt: new Date() });
    await restartTracearrBackfill([serverId]);
    const watermark = (await serverRow()).tracearrForwardWatermarkAt!;
    expect(watermark).toBeInstanceOf(Date);

    archive.add(play("since-restart", new Date(watermark.getTime() - 10 * 60 * 1000)));
    const forward = await syncTracearrHistory(serverId, { passes: "forward" });

    expect(forwardSinces()).toEqual([new Date(watermark.getTime() - HOUR)]);
    expect(forward.count).toBe(1);
  });

  it("keeps the old 'last walk − 7 days' fallback for a finished archive whose watermark predates the column", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await setState({
      tracearrBackfillComplete: true,
      tracearrBackfillLastWalkAt: at(-2 * DAY),
      tracearrForwardWatermarkAt: null,
    });
    archive.add(unstorable("gone", at(-3 * DAY)));

    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(forwardSinces()).toEqual([at(-9 * DAY)]);
    // A healthy walk that read its window records the watermark it starts from
    // now on — and leaves the last-walk stamp, the backfill's own, alone.
    expect(await serverRow()).toMatchObject({
      tracearrForwardWatermarkAt: T0,
      tracearrBackfillLastWalkAt: at(-2 * DAY),
    });

    archive.clearRequests();
    vi.setSystemTime(at(DAY));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(forwardSinces()).toEqual([at(-HOUR)]);
  });

  it("does not move the watermark while the server's items are known to be missing", async () => {
    // A purge holds the server and restarts the walk (watermark = now). A
    // forward pass during the hold skips the purged items' plays as
    // unresolved; moving the watermark past them would leave them unread once
    // the items are back.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await requireLibraryResync([serverId]);
    expect((await serverRow()).tracearrForwardWatermarkAt).toEqual(T0);

    archive.add(unstorable("purged-item-play", at(HOUR)));
    vi.setSystemTime(at(2 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect((await serverRow()).tracearrForwardWatermarkAt).toEqual(T0);

    // Released by the full sync that brought the items back: the next forward
    // pass reads the held stretch again, then moves on.
    expect(await releaseLibraryResyncHold(serverId, at(3 * HOUR))).toBe(true);
    archive.clearRequests();
    vi.setSystemTime(at(4 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect((await serverRow()).tracearrForwardWatermarkAt).toEqual(at(4 * HOUR));
  });

  it("does not overwrite a restart that lands while a forward walk runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await setState({
      tracearrForwardWatermarkAt: at(-DAY),
      tracearrBackfillCursorAt: at(-5 * DAY),
    });
    m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      vi.setSystemTime(at(60 * 1000));
      await restartTracearrBackfill([serverId]);
      return archive.page(id, options);
    });

    await syncTracearrHistory(serverId, { passes: "forward" });

    // The restart's instant, not the walk's earlier start.
    expect((await serverRow()).tracearrForwardWatermarkAt).toEqual(at(60 * 1000));
  });

  it("never moves an existing watermark when a walk starts from the newest play again", async () => {
    // A first slice that failed before committing leaves the watermark and no
    // cursor; the retry resumes at it (everything newer is the forward pass's)
    // and never records a new one. Re-recording would move the forward pass
    // past plays the earlier watermark still owes it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await setState({ tracearrForwardWatermarkAt: at(-5 * DAY) });
    archive.add(unstorable("gone", at(-DAY)));

    await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(archive.requests[0].until).toEqual(at(-5 * DAY));
    expect((await serverRow()).tracearrForwardWatermarkAt).toEqual(at(-5 * DAY));
  });

  it("does not move the watermark on a forward walk without the account map, and records the floor instead", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await setState({
      tracearrForwardWatermarkAt: at(-DAY),
      tracearrBackfillCursorAt: at(-5 * DAY),
    });
    archive.add(play("labelled", at(-2 * HOUR)));
    m.getServerAccountNames.mockRejectedValueOnce(new Error("users down"));

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(forwardSinces()).toEqual([at(-DAY - HOUR)]);
    expect(await serverRow()).toMatchObject({
      tracearrForwardWatermarkAt: at(-DAY),
      tracearrForwardFloorAt: at(-DAY - HOUR),
    });
    expect(
      (await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "labelled" } }))
        .serverUsername,
    ).toBe("Walter W");

    // The next healthy run reaches the floor, re-labels and pays it.
    archive.clearRequests();
    vi.setSystemTime(at(HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(forwardSinces()).toEqual([at(-DAY - HOUR)]);
    expect(
      (await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "labelled" } }))
        .serverUsername,
    ).toBe("walter");
    expect((await serverRow()).tracearrForwardFloorAt).toBeNull();
  });

  it("lets a Refresh overlap the first slice: both land, and neither moves the other's resume point", async () => {
    // The History page's Refresh runs in a request, outside the serial queue
    // the slice runs on. Here it runs while the slice's first page is in flight.
    vi.useFakeTimers({ toFake: ["Date"] });
    archive.add(
      play("x", at(-30 * 60 * 1000)),
      unstorable("old-3", at(-DAY)),
      unstorable("old-2", at(-2 * DAY)),
      unstorable("old-1", at(-3 * DAY)),
    );
    vi.setSystemTime(T0);
    let refresh: Awaited<ReturnType<typeof syncTracearrHistory>> | undefined;
    m.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      vi.setSystemTime(at(60 * 1000));
      refresh = await syncTracearrHistory(serverId, { passes: "forward" });
      return archive.page(id, options);
    });

    const slice = await syncTracearrHistory(serverId, { passes: "backfill", deadlineMs: 0 });

    // The Refresh read from the watermark the slice recorded as it began.
    expect(refresh).toMatchObject({ count: 1, backfillPending: true });
    expect(forwardSinces()).toEqual([at(-HOUR)]);
    expect(slice).toMatchObject({ backfillOutcome: "stopped", backfillPending: true });
    // One row for the play both read: the slice's re-delivery merged.
    expect(await prisma.watchHistory.count({ where: { sourceEventId: "x" } })).toBe(1);
    // The Refresh moved the watermark to its own start; the slice kept its
    // cursor where its page reached.
    expect(await serverRow()).toMatchObject({
      tracearrForwardWatermarkAt: at(60 * 1000),
      tracearrBackfillCursorAt: at(-DAY),
    });

    // The next slice resumes from that cursor, not from the Refresh's rows.
    archive.clearRequests();
    vi.setSystemTime(at(HOUR));
    await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(archive.requests[0].until).toEqual(at(-DAY));
    expect((await serverRow()).tracearrBackfillComplete).toBe(true);
  });

  it("leaves the watermark alone when the library is empty", async () => {
    await setState({ tracearrForwardWatermarkAt: at(-DAY), tracearrBackfillComplete: true });
    await prisma.mediaItem.deleteMany({});
    archive.add(play("p", new Date()));

    const result = await syncTracearrHistory(serverId, { passes: "forward" });

    expect(result).toEqual({ count: 0, backfillPending: false });
    expect(archive.requests).toHaveLength(0);
    expect((await serverRow()).tracearrForwardWatermarkAt).toEqual(at(-DAY));
  });
});
