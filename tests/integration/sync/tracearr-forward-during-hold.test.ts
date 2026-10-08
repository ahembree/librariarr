import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestMediaItem } from "../../setup/test-helpers";
import { FakeTracearrArchive, play } from "./fake-tracearr-archive";
import {
  answerFrom,
  seedMappedServer,
  serverRow,
  storeTracearrPlay,
  storedIds,
  tracearr,
} from "./tracearr-import-kit";

// Forward walks while the library-resync hold is set: they store everyone
// else's plays, skip the missing items' as unresolved and move MAX(watchedAt)
// past them. The floor recorded before the watermark moves is what keeps those
// plays owed, so it has to outlive the hold.

vi.mock("@/lib/db", async () => ({ prisma: (await import("../../setup/test-db")).getTestPrisma() }));
vi.mock("@/lib/logger", async () => (await import("./tracearr-import-kit")).loggerModule());
vi.mock("@/lib/tracearr/tracearr-client", async () => (await import("./tracearr-import-kit")).clientModule(100));

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import {
  _resetLibraryResyncHoldRequestsForTesting,
  releaseLibraryResyncHold,
  requireLibraryResync,
} from "@/lib/media/watch-evidence";

const prisma = getTestPrisma();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** When the hold lands. */
const T0 = new Date("2026-06-01T12:00:00.000Z").getTime();
const at = (offset: number) => new Date(T0 + offset);

let archive: FakeTracearrArchive;
let serverId: string;
let libraryId: string;
let presentItemId: string;

const setServer = (data: Parameters<typeof prisma.mediaServer.update>[0]["data"]) =>
  prisma.mediaServer.update({ where: { id: serverId }, data });
const floor = async () => (await serverRow(serverId)).tracearrForwardFloorAt;
const forward = () => syncTracearrHistory(serverId, { passes: "forward" });
/** Move the clock and forget earlier requests. */
function now(when: Date) {
  vi.setSystemTime(when);
  archive.clearRequests();
}
const missingPlay = (id: string, when: Date) => play(id, when, { rating_key: "200" });
const onReturned = async (returnedId: string) =>
  (await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "missing" } })).mediaItemId === returnedId;

/** A purge of the library holding rating key 200, at T0: its item goes, the walk restarts. */
async function holdAtT0() {
  vi.setSystemTime(at(0));
  await requireLibraryResync([serverId]);
}

/** The full library sync that releases the hold, bringing the purged item back. */
async function releaseWithItemBack(libraryPassStartedAt: Date) {
  const item = await createTestMediaItem(libraryId, { ratingKey: "200", type: "MOVIE", title: "Heat" });
  expect(await releaseLibraryResyncHold(serverId, libraryPassStartedAt)).toBe(true);
  return item;
}

/** A play of the item that stays, in the archive and already stored. */
async function storedPlay(id: string, when: Date) {
  archive.add(play(id, when));
  await storeTracearrPlay(presentItemId, serverId, id, when);
}

/** A walked archive with nothing stored: every play so far was of media long gone. */
async function walkedArchiveWithNoRows() {
  vi.setSystemTime(at(-DAY));
  await setServer({
    tracearrBackfillComplete: true,
    tracearrBackfillLastWalkAt: at(-DAY),
    tracearrForwardWatermarkAt: at(-DAY),
  });
}

/** A walked archive holding one old play of the item that stays. */
async function walkedArchiveWithRows() {
  vi.setSystemTime(at(-DAY));
  await storedPlay("old", at(-10 * DAY));
  await setServer({ tracearrBackfillComplete: true });
}

describe("forward walks while some of the server's items are missing (real DB)", () => {
  beforeEach(async () => {
    _resetLibraryResyncHoldRequestsForTesting();
    archive = new FakeTracearrArchive();
    answerFrom(() => archive);
    ({ serverId, libraryId, itemId: presentItemId } = await seedMappedServer());
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it.each([
    ["with no stored rows", false],
    ["with stored rows", true],
  ])("reads a missing item's play from the hold once it is back — archive %s", async (_label, rows) => {
    await (rows ? walkedArchiveWithRows() : walkedArchiveWithNoRows());
    await holdAtT0();
    archive.add(missingPlay("missing", at(10 * MINUTE)), play("present", at(3 * HOUR)));

    // During the hold: its own window as ever, the play it can attribute
    // stored, and the floor no lower than an hour before the hold.
    now(at(4 * HOUR));
    expect((await forward()).failed).toBeUndefined();
    expect(archive.requests[0].since).toEqual(rows ? at(-10 * DAY - HOUR) : at(-HOUR));
    expect(await storedIds()).toEqual(rows ? ["old", "present"] : ["present"]);
    expect(await floor()).toEqual(at(-HOUR));

    vi.setSystemTime(at(5 * HOUR));
    const returned = await releaseWithItemBack(at(4.5 * HOUR));

    // The first walk after the release re-reads the hold, not ten days.
    now(at(6 * HOUR));
    await forward();
    expect(archive.requests[0].since).toEqual(at(-HOUR));
    expect(await onReturned(returned.id)).toBe(true);
    expect(await floor()).toBeNull();

    // And the restarted walk completes and vouches.
    expect(await syncTracearrHistory(serverId, { passes: "backfill" })).toMatchObject({
      backfillOutcome: "exhausted",
      backfillPending: false,
    });
    expect(await storedIds()).toEqual(rows ? ["missing", "old", "present"] : ["missing", "present"]);
    expect(await serverRow(serverId)).toMatchObject({
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  it("keeps a degraded walk's floor during the hold no lower than the hold either", async () => {
    await walkedArchiveWithRows();
    await holdAtT0();
    archive.add(play("present", at(3 * HOUR)));
    // Without the user list it records its floor before every page it writes.
    tracearr.getServerAccountNames.mockRejectedValueOnce(new Error("users down"));

    vi.setSystemTime(at(4 * HOUR));
    await forward();
    expect(await storedIds()).toEqual(["old", "present"]);
    expect(await floor()).toEqual(at(-HOUR));
  });

  it("does not re-read back to the floor on every walk during the hold — only the first after it", async () => {
    await walkedArchiveWithNoRows();
    await holdAtT0();
    archive.add(missingPlay("missing", at(10 * MINUTE)), play("present", at(3 * HOUR)));
    vi.setSystemTime(at(4 * HOUR));
    await forward();

    // A later playback in the same hold: the ordinary window, an hour below the newest stored play.
    archive.add(play("present-2", at(7 * HOUR)));
    now(at(8 * HOUR));
    await forward();
    expect(archive.requests[0].since).toEqual(at(2 * HOUR));
    expect(await storedIds()).toEqual(["present", "present-2"]);
    expect(await floor()).toEqual(at(-HOUR));

    vi.setSystemTime(at(9 * HOUR));
    await releaseWithItemBack(at(8.5 * HOUR));
    now(at(10 * HOUR));
    await forward();
    expect(archive.requests[0].since).toEqual(at(-HOUR));
    expect(await storedIds()).toEqual(["missing", "present", "present-2"]);
  });

  it("keeps the floor when a walk that began during the hold finishes after its release", async () => {
    await walkedArchiveWithNoRows();
    await holdAtT0();
    archive.add(missingPlay("missing", at(10 * MINUTE)), play("present", at(3 * HOUR)));
    // Released while this walk's page is in flight: its item index predates the item.
    vi.setSystemTime(at(4 * HOUR));
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await releaseWithItemBack(at(4 * HOUR));
      return archive.page(id, options);
    });
    await forward();
    expect(await storedIds()).toEqual(["present"]);
    expect(await floor()).toEqual(at(-HOUR));

    vi.setSystemTime(at(5 * HOUR));
    await forward();
    expect(await storedIds()).toEqual(["missing", "present"]);
  });

  it("does not move the watermark past what a walk that began during the hold skipped", async () => {
    // Nothing storable during the hold, so no floor: the watermark alone keeps the play owed.
    await walkedArchiveWithNoRows();
    await holdAtT0();
    archive.add(missingPlay("missing", at(10 * MINUTE)));

    vi.setSystemTime(at(4 * HOUR));
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await releaseWithItemBack(at(4 * HOUR));
      return archive.page(id, options);
    });
    await forward();
    expect(await storedIds()).toEqual([]);
    expect((await serverRow(serverId)).tracearrForwardWatermarkAt).toEqual(at(0));

    vi.setSystemTime(at(5 * HOUR));
    await forward();
    expect(await storedIds()).toEqual(["missing"]);
  });

  it("does not let a walk that began before the hold pay a floor while the hold is set", async () => {
    await walkedArchiveWithRows();
    archive.add(play("present", at(-5 * MINUTE)));
    vi.setSystemTime(at(0));
    // The hold lands mid-page, and a walk run during it records a floor.
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      await requireLibraryResync([serverId]);
      await setServer({ tracearrForwardFloorAt: at(-30 * MINUTE) });
      return archive.page(id, options);
    });

    expect((await forward()).failed).toBeUndefined();
    expect(await storedIds()).toEqual(["old", "present"]);
    // Still owed: the walk read only what had started before it began.
    expect(await floor()).not.toBeNull();
  });

  it("bounds a held walk's floor by the restart cursor when the hold is newer than it", async () => {
    // The restart-shaped state an older build left: cursor = restart instant ten
    // days ago, hold newer. Bounded by the hold alone, the floor would sit
    // above a missing item's play five days ago that neither walk reads.
    vi.setSystemTime(at(-DAY));
    await storedPlay("old", at(-30 * DAY));
    archive.add(missingPlay("missing", at(-5 * DAY)), play("present", at(HOUR)));
    vi.setSystemTime(at(0));
    await setServer({
      tracearrBackfillComplete: false,
      tracearrBackfillCursorAt: at(-10 * DAY),
      tracearrForwardWatermarkAt: at(-10 * DAY),
      libraryResyncRequiredAt: at(0),
    });

    vi.setSystemTime(at(2 * HOUR));
    await forward();
    expect(await storedIds()).toEqual(["old", "present"]);
    expect(await floor()).toEqual(at(-10 * DAY - HOUR));

    vi.setSystemTime(at(3 * HOUR));
    const returned = await releaseWithItemBack(at(2.5 * HOUR));
    now(at(4 * HOUR));
    await forward();
    expect(archive.requests[0].since).toEqual(at(-10 * DAY - HOUR));
    expect(await onReturned(returned.id)).toBe(true);

    archive.clearRequests();
    const backfill = await syncTracearrHistory(serverId, { passes: "backfill" });
    expect(archive.requests[0].until).toEqual(at(-10 * DAY));
    expect(backfill).toMatchObject({ backfillOutcome: "exhausted", backfillPending: false });
    expect(await serverRow(serverId)).toMatchObject({
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  it.each([
    ["with stored rows", true],
    ["with nothing left stored once the purge ran", false],
  ])("bounds a held walk's floor by the LATEST restart when the hold is requested again (%s)", async (_label, presentRows) => {
    vi.setSystemTime(at(-DAY));
    if (presentRows) await storedPlay("p100-old", at(-30 * DAY));
    else archive.add(play("p100-old", at(-30 * DAY)));
    const purged = await createTestMediaItem(libraryId, { ratingKey: "200", type: "MOVIE", title: "Heat" });
    archive.add(missingPlay("p200-old", at(-20 * DAY)));
    await storeTracearrPlay(purged.id, serverId, "p200-old", at(-20 * DAY));
    await setServer({
      tracearrBackfillComplete: true,
      tracearrBackfillCursorAt: at(-30 * DAY),
      tracearrBackfillLastWalkAt: at(-2 * DAY),
      tracearrOldestPlayAt: at(-30 * DAY),
    });

    // A purge at 0: the hold first, then the delete, which takes the play.
    await holdAtT0();
    await prisma.mediaItem.delete({ where: { id: purged.id } });
    archive.add(play("p100-a", at(0.5 * HOUR)), missingPlay("p200-a", at(0.7 * HOUR)));
    vi.setSystemTime(at(HOUR));
    await forward();

    // Requested again five days on: the hold keeps its first instant, the walk restarts from now.
    vi.setSystemTime(at(5 * DAY));
    await requireLibraryResync([serverId]);
    expect((await serverRow(serverId)).libraryResyncRequiredAt).toEqual(at(0));
    archive.add(play("p100-b", at(5 * DAY + 0.2 * HOUR)), missingPlay("p200-b", at(5 * DAY + 0.4 * HOUR)));
    vi.setSystemTime(at(5 * DAY + HOUR));
    await forward();
    // No lower than an hour below the latest restart: everything older is the restarted walk's.
    expect(await floor()).toEqual(at(5 * DAY - HOUR));
    archive.add(play("p100-c", at(8 * DAY)), missingPlay("p200-c", at(8 * DAY + HOUR)));
    vi.setSystemTime(at(8 * DAY + 2 * HOUR));
    await forward();

    vi.setSystemTime(at(10 * DAY));
    const returned = await releaseWithItemBack(at(9.9 * DAY));
    now(at(10 * DAY + MINUTE));
    await forward();
    expect(archive.requests[0].since).toEqual(at(5 * DAY - HOUR));

    // And the restarted walk covers everything at or below its cursor.
    let backfill = await syncTracearrHistory(serverId, { passes: "backfill" });
    for (let i = 0; i < 3 && backfill.backfillPending; i++) {
      backfill = await syncTracearrHistory(serverId, { passes: "backfill" });
    }
    const onItem = await prisma.watchHistory.findMany({ where: { mediaItemId: returned.id } });
    expect(onItem.map((row) => row.sourceEventId).sort()).toEqual(["p200-a", "p200-b", "p200-c", "p200-old"]);
    expect(await serverRow(serverId)).toMatchObject({
      tracearrBackfillComplete: true,
      tracearrForwardFloorAt: null,
      watchHistorySyncedAt: expect.any(Date),
    });
  });

  // These SIMULATE holds `requireLibraryResync` never leaves on its own (only a
  // failed restart write does): with nothing below the floor proven to be
  // walked again, it is not bounded at all.
  it.each([
    ["an archive already walked to its end", { tracearrBackfillComplete: true, tracearrBackfillCursorAt: at(-HOUR) }],
    ["no resume cursor", { tracearrBackfillComplete: false, tracearrBackfillCursorAt: null }],
  ])("does not bound the floor with %s", async (_label, state) => {
    vi.setSystemTime(at(-DAY));
    await storedPlay("old", at(-10 * DAY));
    archive.add(missingPlay("missing", at(-5 * DAY)), play("present", at(HOUR)));
    vi.setSystemTime(at(0));
    await setServer({ ...state, libraryResyncRequiredAt: at(0) });

    vi.setSystemTime(at(2 * HOUR));
    await forward();
    expect(await floor()).toEqual(at(-10 * DAY - HOUR));

    vi.setSystemTime(at(3 * HOUR));
    const returned = await releaseWithItemBack(at(2.5 * HOUR));
    vi.setSystemTime(at(4 * HOUR));
    await forward();
    expect(await onReturned(returned.id)).toBe(true);
  });
});
