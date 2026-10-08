import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { FakeTracearrArchive, play } from "./fake-tracearr-archive";
import {
  answerFrom,
  seedMappedServer,
  serverRow,
  storeTracearrPlay,
  storedIds,
  tracearr,
} from "./tracearr-import-kit";

// Overlapping forward walks (a scheduled job and a History-page Refresh): a
// floor recorded by a walk that started LATER can mark plays the earlier walk
// never fetched, so the earlier one must not pay it —
// `tracearrForwardFloorRecordedAt` (the newest recorder's start) tells them apart.

vi.mock("@/lib/db", async () => ({ prisma: (await import("../../setup/test-db")).getTestPrisma() }));
vi.mock("@/lib/logger", async () => (await import("./tracearr-import-kit")).loggerModule());
// Two records a page, so a walk can be stopped part-way through its window.
vi.mock("@/lib/tracearr/tracearr-client", async () => (await import("./tracearr-import-kit")).clientModule(2));

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

/** A play of the movie, in the archive and already stored. */
async function storedPlay(id: string, when: Date) {
  archive.add(play(id, when));
  await storeTracearrPlay(itemId, serverId, id, when);
}

const floor = async () => {
  const row = await serverRow(serverId);
  return { at: row.tracearrForwardFloorAt, recordedAt: row.tracearrForwardFloorRecordedAt };
};

/** A second forward walk, started now, that reads its first page and is then stopped. */
async function walkStoppedAfterOnePage() {
  const stop = new AbortController();
  tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
    stop.abort();
    return archive.page(id, options);
  });
  return syncTracearrHistory(serverId, { passes: "forward", signal: stop.signal });
}

describe("paying the forward floor when forward walks overlap (real DB)", () => {
  beforeEach(async () => {
    archive = new FakeTracearrArchive();
    answerFrom(() => archive);
    ({ serverId, itemId } = await seedMappedServer({ tracearrBackfillComplete: true }));
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
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      const page = archive.page(id, options);
      // A second walk starts three hours on, reads only plays newer than the
      // first walk's start and is stopped, leaving "gap" under its floor.
      vi.setSystemTime(at(3 * HOUR));
      archive.add(play("gap", at(30 * MINUTE)), play("new-1", at(2 * HOUR)), play("new-2", at(2.5 * HOUR)));
      await walkStoppedAfterOnePage();
      expect(await storedIds()).toEqual(["new-1", "new-2", "old"]);
      return page;
    });

    expect((await syncTracearrHistory(serverId, { passes: "forward" })).failed).toBeUndefined();
    expect(await storedIds()).toEqual(["first-new", "new-1", "new-2", "old"]);
    expect(await floor()).toEqual({ at: at(-6 * HOUR), recordedAt: at(3 * HOUR) });

    vi.setSystemTime(at(4 * HOUR));
    archive.clearRequests();
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(archive.requests[0].since).toEqual(at(-6 * HOUR));
    expect(await storedIds()).toEqual(["first-new", "gap", "new-1", "new-2", "old"]);
    expect(await floor()).toEqual({ at: null, recordedAt: null });
    expect((await serverRow(serverId)).watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  it("does not pay it when the later walk records after it — the stamp moves even when the floor keeps its value", async () => {
    archive.add(play("first-a", at(-20 * MINUTE)), play("first-b", at(-15 * MINUTE)), play("first-c", at(-10 * MINUTE)));
    vi.setSystemTime(at(0));
    tracearr.getHistoryPage
      // The first page moves the watermark: the walk records the floor itself.
      .mockImplementationOnce(async (id: string, options: object) => archive.page(id, options))
      .mockImplementationOnce(async (id: string, options: object) => {
        const page = archive.page(id, options);
        expect(await floor()).toEqual({ at: at(-6 * HOUR), recordedAt: at(0) });
        // A second walk records it too: the value stays (its `since` is above), the stamp does not.
        vi.setSystemTime(at(3 * HOUR));
        archive.add(play("gap", at(30 * MINUTE)), play("new-1", at(2 * HOUR)), play("new-2", at(2.5 * HOUR)));
        await walkStoppedAfterOnePage();
        expect(await floor()).toEqual({ at: at(-6 * HOUR), recordedAt: at(3 * HOUR) });
        return page;
      });

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await storedIds()).toEqual(["first-a", "first-b", "first-c", "new-1", "new-2", "old"]);
    expect((await floor()).at).toEqual(at(-6 * HOUR));

    vi.setSystemTime(at(4 * HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toContain("gap");
    expect((await floor()).at).toBeNull();
  });

  it("pays a floor that a walk started before it recorded", async () => {
    archive.add(play("gap", at(-30 * MINUTE)), play("new-1", at(-20 * MINUTE)), play("new-2", at(-10 * MINUTE)));
    vi.setSystemTime(at(0));
    await walkStoppedAfterOnePage();
    expect(await storedIds()).toEqual(["new-1", "new-2", "old"]);
    expect(await floor()).toEqual({ at: at(-6 * HOUR), recordedAt: at(0) });

    vi.setSystemTime(at(HOUR));
    await syncTracearrHistory(serverId, { passes: "forward" });
    expect(await storedIds()).toEqual(["gap", "new-1", "new-2", "old"]);
    expect(await floor()).toEqual({ at: null, recordedAt: null });
    expect((await serverRow(serverId)).watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  it("pays the floor it recorded itself, though it records after its first page came back", async () => {
    // So the stamp is the walk's START: stamped with the moment of recording,
    // no walk could pay its own floor.
    archive.add(play("new", at(-10 * MINUTE)));
    vi.setSystemTime(at(0));
    await prisma.mediaServer.update({ where: { id: serverId }, data: { watchHistorySyncedAt: null } });
    tracearr.getHistoryPage.mockImplementationOnce(async (id: string, options: object) => {
      vi.setSystemTime(at(MINUTE));
      return archive.page(id, options);
    });

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await storedIds()).toEqual(["new", "old"]);
    expect(await floor()).toEqual({ at: null, recordedAt: null });
    expect((await serverRow(serverId)).watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  it("pays a floor that carries no recorder stamp, as before the stamp existed", async () => {
    // The walk moves no watermark (its newest play is stored), so it records nothing itself.
    await storedPlay("newest", at(-HOUR));
    archive.add(play("gap", at(-3 * HOUR)));
    await prisma.mediaServer.update({
      where: { id: serverId },
      data: { tracearrForwardFloorAt: at(-6 * HOUR), tracearrForwardFloorRecordedAt: null },
    });
    vi.setSystemTime(at(0));

    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await storedIds()).toEqual(["gap", "newest", "old"]);
    expect(await floor()).toEqual({ at: null, recordedAt: null });
  });
});
