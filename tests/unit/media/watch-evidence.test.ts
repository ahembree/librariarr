import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The write half of `MediaServer.watchHistorySyncedAt`.
 *
 * The marker is what pauses `watchedByUser` rules while a server's plays are
 * gone, so the invariants that matter are: it never slides an existing
 * timestamp forward (that would make "how long has this been paused"
 * unreadable), it no-ops on an empty list rather than issuing an unscoped
 * UPDATE, and the row-derived variant asks about actual plays.
 */
const m = vi.hoisted(() => ({
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  findMany: vi.fn().mockResolvedValue([]),
  findUnique: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    mediaServer: { updateMany: m.updateMany, findMany: m.findMany, findUnique: m.findUnique },
  },
}));

const { mockEnqueueJob } = vi.hoisted(() => ({ mockEnqueueJob: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob }));

import {
  _resetLibraryResyncHoldRequestsForTesting,
  forgetLibraryResyncHoldRequests,
  invalidateWatchHistoryEvidence,
  invalidateServersWithoutWatchHistory,
  markWatchHistoryEstablished,
  markWatchHistoryEstablishedIfUnchanged,
  releaseLibraryResyncHold,
  releaseOwnPopulationHold,
  requireLibraryResync,
  requirePopulationResync,
  restartTracearrBackfill,
  snapshotWatchEvidence,
} from "@/lib/media/watch-evidence";

// The hold-request registry is per process, like the withdrawal counters; the
// tests reuse server ids, so each starts as a freshly started process would.
beforeEach(() => {
  _resetLibraryResyncHoldRequestsForTesting();
});

describe("invalidateWatchHistoryEvidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 0 });
    m.findMany.mockResolvedValue([]);
  });

  it("withdraws the marker only from servers that currently claim one", async () => {
    m.updateMany.mockResolvedValue({ count: 2 });

    await invalidateWatchHistoryEvidence(["s1", "s2"]);

    const arg = m.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      id: { in: ["s1", "s2"] },
      // Only servers that currently claim established history need withdrawing.
      watchHistorySyncedAt: { not: null },
    });
    expect(arg.data.watchHistorySyncedAt).toBeNull();
  });

  it("issues no UPDATE at all for an empty list", async () => {
    // An unscoped `updateMany` here would mark EVERY server on the install and
    // pause every watchedByUser rule set at once.
    await expect(invalidateWatchHistoryEvidence([])).resolves.toBe(0);
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});

describe("invalidateServersWithoutWatchHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 0 });
  });

  it("selects on the absence of plays, not on any operation's own bookkeeping", async () => {
    // Used by restore, which truncates the whole database and re-inserts
    // servers from the file — the affected ids are not knowable up front.
    m.findMany.mockResolvedValue([{ id: "s1" }]);
    m.updateMany.mockResolvedValue({ count: 1 });

    await expect(invalidateServersWithoutWatchHistory()).resolves.toBe(1);

    expect(m.findMany.mock.calls[0][0].where).toMatchObject({
      watchHistorySyncedAt: { not: null },
      watchHistory: { none: {} },
    });
  });

  it("withdraws nothing when every server still holds plays", async () => {
    m.findMany.mockResolvedValue([]);

    await expect(invalidateServersWithoutWatchHistory()).resolves.toBe(0);
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});

describe("restartTracearrBackfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 0 });
  });

  it("reopens the archive walk from now, for Tracearr-mapped servers only", async () => {
    m.updateMany.mockResolvedValue({ count: 1 });
    const before = Date.now();

    await expect(restartTracearrBackfill(["s1", "s2"])).resolves.toBe(1);

    const arg = m.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      id: { in: ["s1", "s2"] },
      tracearrServerId: { not: null },
    });
    expect(arg.data.tracearrBackfillComplete).toBe(false);
    // The cursor is moved to NOW, not cleared: with no cursor the walk resumes
    // below the oldest stored row, which after a partial purge is the far end of
    // the archive — so nothing purged would be walked again.
    expect(arg.data.tracearrBackfillCursorAt).toBeInstanceOf(Date);
    expect(arg.data.tracearrBackfillCursorAt.getTime()).toBeGreaterThanOrEqual(before);
    // The restarted walk covers any gap an interrupted forward walk recorded,
    // and the stamp of the walk that recorded it goes with it.
    expect(arg.data.tracearrForwardFloorAt).toBeNull();
    expect(arg.data.tracearrForwardFloorRecordedAt).toBeNull();
    expect(arg.data).toHaveProperty("tracearrForwardFloorRecordedAt");
    // A last-walk stamp describes the history that was just destroyed.
    expect(arg.data.tracearrBackfillLastWalkAt).toBeNull();
    // The forward pass of an archive with no stored rows resumes from the
    // watermark: every play older than the restart is the restarted walk's.
    expect(arg.data.tracearrForwardWatermarkAt).toEqual(arg.data.tracearrBackfillCursorAt);
    // Holds nothing: a caller that deleted items records the hold through
    // `requireLibraryResync`; restore's "items present, rows missing" case
    // needs none.
    expect(arg.data).not.toHaveProperty("libraryResyncRequiredAt");
  });

  it("supersedes a running slice's live reach before moving the cursor", async () => {
    const activity = await import("@/lib/sync/tracearr-import-activity");
    const spy = vi.spyOn(activity, "supersedeTracearrImports");
    m.updateMany.mockResolvedValue({ count: 1 });

    await restartTracearrBackfill(["s1", "s2"]);

    expect(spy).toHaveBeenCalledWith("s1");
    expect(spy).toHaveBeenCalledWith("s2");
    expect(spy.mock.invocationCallOrder[0]).toBeLessThan(m.updateMany.mock.invocationCallOrder[0]);
    spy.mockRestore();
  });

  it("queues no walk — it has to follow the re-sync that brings the purged items back", async () => {
    // Every caller has just removed items whose plays the restarted walk exists
    // to recover. Walked before a sync re-creates them, those plays are skipped
    // as unresolved and the archive can be marked complete without them.
    m.updateMany.mockResolvedValue({ count: 2 });
    m.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);

    await restartTracearrBackfill(["s1", "s2"]);

    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("issues no UPDATE at all for an empty list", async () => {
    await expect(restartTracearrBackfill([])).resolves.toBe(0);
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});

describe("markWatchHistoryEstablishedIfUnchanged", () => {
  // A sync captures the marker when it starts and may only establish the
  // history if nothing withdrew it meanwhile. An unconditional write let a
  // native full replace that was still fetching re-mark a server a purge had
  // just withdrawn — vouching for rows it never saw.
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
    m.findMany.mockResolvedValue([]);
  });

  const establishCalls = () =>
    m.updateMany.mock.calls.filter((c) => c[0].data.watchHistorySyncedAt instanceof Date);

  it("writes only where the marker is still the one the run started with, and no hold is set", async () => {
    const marker = new Date("2025-01-01T00:00:00Z");
    const snapshot = snapshotWatchEvidence("s1", marker);

    await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(true);

    expect(establishCalls()[0][0].where).toEqual({
      id: "s1",
      watchHistorySyncedAt: marker,
      // Some of the server's media rows are known to be missing while held: no
      // pass can have attached their plays, whatever it found.
      libraryResyncRequiredAt: null,
    });
  });

  it("reports false when the compare-and-set finds the marker changed (established → null)", async () => {
    const snapshot = snapshotWatchEvidence("s1", new Date("2025-01-01T00:00:00Z"));
    m.updateMany.mockResolvedValue({ count: 0 });

    await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(false);
  });

  it("does not write after a null → null withdrawal the column cannot show", async () => {
    // The run started on an un-established server (marker null); a purge
    // during it wrote null over null. Only the withdrawal counter can tell.
    const snapshot = snapshotWatchEvidence("s1", null);
    await invalidateWatchHistoryEvidence(["s1"]);
    m.updateMany.mockClear();

    await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(false);
    expect(establishCalls()).toHaveLength(0);
  });

  it("is not affected by a withdrawal on another server", async () => {
    const snapshot = snapshotWatchEvidence("s1", null);
    await invalidateWatchHistoryEvidence(["s2"]);

    await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(true);
  });

  it("refuses every in-flight run after a restore rewrote the database", async () => {
    const snapshot = snapshotWatchEvidence("s1", null);
    await invalidateServersWithoutWatchHistory();
    m.updateMany.mockClear();

    await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(false);
    expect(establishCalls()).toHaveLength(0);
  });

  it("puts the marker back to null when a withdrawal lands between its check and its write", async () => {
    const snapshot = snapshotWatchEvidence("s1", null);
    // The withdrawal is counted while the establishing UPDATE is in flight.
    m.updateMany.mockImplementationOnce(async () => {
      await invalidateWatchHistoryEvidence(["s1"]);
      return { count: 1 };
    });

    await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(false);

    const written = establishCalls()[0][0].data.watchHistorySyncedAt as Date;
    const revert = m.updateMany.mock.calls.at(-1)![0];
    // Only undoes its OWN write: a later sync's newer mark is left alone.
    expect(revert).toEqual({
      where: { id: "s1", watchHistorySyncedAt: written },
      data: { watchHistorySyncedAt: null },
    });
  });
});

describe("markWatchHistoryEstablished", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("never marks a server under a library-resync hold", async () => {
    await markWatchHistoryEstablished(["s1", "s2"]);

    expect(m.updateMany.mock.calls[0][0].where).toEqual({
      id: { in: ["s1", "s2"] },
      libraryResyncRequiredAt: null,
    });
  });

  it("issues no UPDATE for an empty list", async () => {
    await expect(markWatchHistoryEstablished([])).resolves.toBe(0);
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});

// The SQL of both helpers is exercised against Postgres in
// tests/integration/media/watch-evidence-hold.test.ts; these pin the order of
// the steps and what each statement is asked to do.
describe("requireLibraryResync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  const holdWrite = () =>
    m.updateMany.mock.calls.find((c) => "libraryResyncRequiredAt" in c[0].data)![0];

  it("counts the withdrawal before it writes anything", async () => {
    // A sync whose snapshot predates the hold must not be able to establish
    // the marker afterwards, even though the column it compares stays null.
    const snapshot = snapshotWatchEvidence("s1", null);
    let generationMovedBeforeFirstWrite: boolean | undefined;
    m.updateMany.mockImplementationOnce(async () => {
      generationMovedBeforeFirstWrite =
        snapshotWatchEvidence("s1", null).generation !== snapshot.generation;
      return { count: 1 };
    });

    await requireLibraryResync(["s1"]);

    expect(generationMovedBeforeFirstWrite).toBe(true);
    m.updateMany.mockClear();
    await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(false);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("writes the hold at now by default, and only where none is set — the earliest request stays", async () => {
    // A library the earlier request is still waiting on (half populated by a
    // failed sync, say) holds rows created after THAT instant; moving the hold
    // later would make them read as older than the hold, i.e. untouched.
    const before = Date.now();

    await requireLibraryResync(["s1", "s2"]);

    const write = holdWrite();
    const at = write.data.libraryResyncRequiredAt as Date;
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(write.where).toEqual({ id: { in: ["s1", "s2"] }, libraryResyncRequiredAt: null });
  });

  it("writes a given instant the same way", async () => {
    const at = new Date("2026-03-01T10:00:00.000Z");

    await requireLibraryResync(["s1"], { at });

    expect(holdWrite()).toEqual({
      where: { id: { in: ["s1"] }, libraryResyncRequiredAt: null },
      data: { libraryResyncRequiredAt: at },
    });
  });

  it("writes the hold before it withdraws the marker, then restarts a mapped walk", async () => {
    await requireLibraryResync(["s1"]);

    const calls = m.updateMany.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(3);
    expect(calls[0].data).toHaveProperty("libraryResyncRequiredAt");
    expect(calls[1]).toEqual({
      where: { id: { in: ["s1"] }, watchHistorySyncedAt: { not: null } },
      data: { watchHistorySyncedAt: null },
    });
    // `restartTracearrBackfill`, which touches mapped servers only.
    expect(calls[2].where).toEqual({ id: { in: ["s1"] }, tracearrServerId: { not: null } });
    expect(calls[2].data.tracearrBackfillComplete).toBe(false);
  });

  it("notes the request before it writes the hold, so a release already past its own check still sees it", async () => {
    // Noted after the write instead, a request that found the hold set (and
    // left it, the column keeping the earliest) would be cleared by a release
    // whose check came first, with nothing to tell it to put the hold back.
    const passStart = new Date("2026-03-01T10:00:00.000Z");
    let releasedDuringWrite: boolean | undefined;
    m.updateMany.mockImplementationOnce(async () => {
      m.findUnique.mockResolvedValueOnce({ libraryResyncRequiredAt: passStart });
      releasedDuringWrite = await releaseLibraryResyncHold("s1", passStart);
      return { count: 0 };
    });

    await requireLibraryResync(["s1"], { at: new Date(passStart.getTime() + 5_000) });

    expect(releasedDuringWrite).toBe(false);
  });

  it("takes its request back when the hold write throws — no stale request outlives it", async () => {
    // Left behind, it refused every later population its receipt (one is
    // only given while no request is outstanding), and a release whose pass
    // began before its instant.
    const at = new Date("2026-03-01T10:00:00.000Z");
    m.updateMany.mockRejectedValueOnce(new Error("connection reset"));

    await expect(requireLibraryResync(["s1"], { at })).rejects.toThrow("connection reset");

    m.updateMany.mockResolvedValue({ count: 1 });
    await expect(requirePopulationResync("s1", new Date(at.getTime() - 60_000))).resolves.not.toBeNull();
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: new Date(at.getTime() - 60_000) });
    await expect(releaseLibraryResyncHold("s1", new Date(at.getTime() - 1_000))).resolves.toBe(true);
  });

  it("puts back the request that was outstanding before the one whose write threw", async () => {
    const earlier = new Date("2026-03-01T10:00:00.000Z");
    await requireLibraryResync(["s1"], { at: earlier });
    m.updateMany.mockRejectedValueOnce(new Error("connection reset"));

    await expect(requireLibraryResync(["s1"], { at: new Date(earlier.getTime() + 60_000) })).rejects.toThrow();

    // The earlier request still stands: no receipt, and a pass begun before it
    // cannot release.
    await expect(requirePopulationResync("s1", earlier)).resolves.toBeNull();
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: earlier });
    await expect(releaseLibraryResyncHold("s1", new Date(earlier.getTime() - 1))).resolves.toBe(false);
    // ...while one begun after it, but before the failed one, can.
    await expect(releaseLibraryResyncHold("s1", new Date(earlier.getTime() + 1_000))).resolves.toBe(true);
  });

  it("keeps a request noted while the failed write was in flight", async () => {
    const at = new Date("2026-03-01T10:00:00.000Z");
    const later = new Date(at.getTime() + 30_000);
    m.updateMany.mockImplementationOnce(async () => {
      await requireLibraryResync(["s1"], { at: later });
      throw new Error("connection reset");
    });

    await expect(requireLibraryResync(["s1"], { at })).rejects.toThrow("connection reset");

    // Erring toward refusing: the later request is still known.
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: at });
    await expect(releaseLibraryResyncHold("s1", new Date(later.getTime() - 1))).resolves.toBe(false);
  });

  it("does nothing at all for an empty list", async () => {
    const snapshot = snapshotWatchEvidence("s1", null);

    await requireLibraryResync([]);

    expect(m.updateMany).not.toHaveBeenCalled();
    expect(snapshotWatchEvidence("s1", null).generation).toBe(snapshot.generation);
  });
});

describe("forgetLibraryResyncHoldRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("forgets every server's requests, or only the ones named", async () => {
    // For a restore, which rewrites every server's hold column from the file.
    const at = new Date("2026-03-01T10:00:00.000Z");
    await requireLibraryResync(["s1", "s2", "s3"], { at });

    forgetLibraryResyncHoldRequests(["s1"]);
    await expect(requirePopulationResync("s1", at)).resolves.not.toBeNull();
    await expect(requirePopulationResync("s2", at)).resolves.toBeNull();

    forgetLibraryResyncHoldRequests();
    await expect(requirePopulationResync("s3", at)).resolves.not.toBeNull();
  });
});

describe("releaseLibraryResyncHold", () => {
  const passStart = new Date("2026-03-01T10:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("releases a hold set at or before the pass start, nulling the marker in the same write", async () => {
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: passStart });

    await expect(releaseLibraryResyncHold("s1", passStart)).resolves.toBe(true);

    expect(m.updateMany.mock.calls).toHaveLength(1);
    expect(m.updateMany.mock.calls[0][0]).toEqual({
      // The hold it read — one released and set again in between is another.
      where: { id: "s1", libraryResyncRequiredAt: passStart },
      data: { libraryResyncRequiredAt: null, watchHistorySyncedAt: null },
    });
  });

  it("compares with the hold instant it is handed instead of reading one", async () => {
    // The instant the caller decided which libraries the hold waits for by.
    const heldSince = new Date(passStart.getTime() - 60_000);

    await expect(releaseLibraryResyncHold("s1", passStart, heldSince)).resolves.toBe(true);

    expect(m.findUnique).not.toHaveBeenCalled();
    expect(m.updateMany.mock.calls[0][0].where).toEqual({ id: "s1", libraryResyncRequiredAt: heldSince });
  });

  it("refuses a hold requested after the pass began, though the column still reads older", async () => {
    // A purge mid-pass on a server already held leaves the column at the
    // earlier request, and this pass may have passed the purged library.
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: new Date(passStart.getTime() - 60_000) });
    await requireLibraryResync(["s1"], { at: new Date(passStart.getTime() + 1) });
    m.updateMany.mockClear();
    const snapshot = snapshotWatchEvidence("s1", null);

    await expect(releaseLibraryResyncHold("s1", passStart)).resolves.toBe(false);

    expect(m.updateMany).not.toHaveBeenCalled();
    expect(snapshotWatchEvidence("s1", null).generation).toBe(snapshot.generation);
  });

  it("is not refused by a request at or before the pass start, nor by another server's", async () => {
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: passStart });
    await requireLibraryResync(["s1"], { at: passStart });
    await requireLibraryResync(["s2"], { at: new Date(passStart.getTime() + 60_000) });
    m.updateMany.mockClear();

    await expect(releaseLibraryResyncHold("s1", passStart)).resolves.toBe(true);
  });

  it("puts back a hold requested while its write was in flight, and reports no release", async () => {
    // That request found the column set and left it (it keeps the earliest), so
    // the release's write just cleared it along with the hold it released.
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: passStart });
    let raced: Date | undefined;
    m.updateMany.mockImplementationOnce(async () => {
      raced = new Date(passStart.getTime() + 5_000);
      await requireLibraryResync(["s1"], { at: raced });
      return { count: 1 };
    });

    await expect(releaseLibraryResyncHold("s1", passStart)).resolves.toBe(false);

    expect(m.updateMany.mock.calls.at(-1)![0]).toEqual({
      where: { id: "s1", libraryResyncRequiredAt: null },
      data: { libraryResyncRequiredAt: raced },
    });
  });

  it("forgets the requests it covered, so a later population of the server gets its receipt again", async () => {
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: passStart });
    await requireLibraryResync(["s1"], { at: passStart });

    await expect(releaseLibraryResyncHold("s1", passStart)).resolves.toBe(true);

    await expect(requirePopulationResync("s1", new Date(passStart.getTime() + 60_000))).resolves.not.toBeNull();
  });

  it("counts a withdrawal before releasing, so an older history pass cannot vouch afterwards", async () => {
    // A pass whose snapshot predates the release may have built its item map
    // before the re-added items existed.
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: passStart });
    const older = snapshotWatchEvidence("s1", null);
    let generationMovedBeforeWrite: boolean | undefined;
    m.updateMany.mockImplementationOnce(async () => {
      generationMovedBeforeWrite = snapshotWatchEvidence("s1", null).generation !== older.generation;
      return { count: 1 };
    });

    await releaseLibraryResyncHold("s1", passStart);

    expect(generationMovedBeforeWrite).toBe(true);
    // ...while one started after the release may establish it.
    const newer = snapshotWatchEvidence("s1", null);
    m.updateMany.mockClear();
    await expect(markWatchHistoryEstablishedIfUnchanged(older)).resolves.toBe(false);
    await expect(markWatchHistoryEstablishedIfUnchanged(newer)).resolves.toBe(true);
  });

  it("does not touch a hold set after the pass started, and counts no withdrawal", async () => {
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: new Date(passStart.getTime() + 1) });
    const snapshot = snapshotWatchEvidence("s1", null);

    await expect(releaseLibraryResyncHold("s1", passStart)).resolves.toBe(false);

    expect(m.updateMany).not.toHaveBeenCalled();
    expect(snapshotWatchEvidence("s1", null).generation).toBe(snapshot.generation);
  });

  it("does nothing for a server with no hold — a normal full sync leaves the marker alone", async () => {
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: null });
    const snapshot = snapshotWatchEvidence("s1", null);

    await expect(releaseLibraryResyncHold("s1", passStart)).resolves.toBe(false);

    expect(m.updateMany).not.toHaveBeenCalled();
    expect(snapshotWatchEvidence("s1", null).generation).toBe(snapshot.generation);
  });

  it("reports false when the compare-and-set finds the hold changed", async () => {
    m.findUnique.mockResolvedValue({ libraryResyncRequiredAt: passStart });
    m.updateMany.mockResolvedValue({ count: 0 });

    await expect(releaseLibraryResyncHold("s1", passStart)).resolves.toBe(false);
  });
});

describe("requirePopulationResync", () => {
  const at = new Date("2026-03-01T10:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("is requireLibraryResync at the given instant", async () => {
    await requirePopulationResync("s1", at);

    const holdWrite = m.updateMany.mock.calls.find((c) => "libraryResyncRequiredAt" in c[0].data)![0];
    expect(holdWrite).toEqual({
      where: { id: { in: ["s1"] }, libraryResyncRequiredAt: null },
      data: { libraryResyncRequiredAt: at },
    });
  });

  it("returns a receipt carrying the generation right after its own withdrawal", async () => {
    const receipt = await requirePopulationResync("s1", at);

    expect(receipt).toEqual({ serverId: "s1", at, generation: snapshotWatchEvidence("s1", null).generation });
  });

  it("returns no receipt when a hold was already in place", async () => {
    // The hold write matched nothing: an earlier purge or restore holds it, and
    // its missing items may be anywhere on the server.
    m.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(requirePopulationResync("s1", at)).resolves.toBeNull();
  });

  it("returns no receipt while another request is outstanding, though its write has not landed", async () => {
    // A purge noted its request and is still writing: this call finds the
    // column empty and writes, but the hold it wrote also stands for that
    // purge, whose missing items are not this sync's to bring back.
    let landPurge!: () => void;
    m.updateMany.mockImplementationOnce(
      () => new Promise((resolve) => (landPurge = () => resolve({ count: 0 }))),
    );
    const purge = requireLibraryResync(["s1"]);

    await expect(requirePopulationResync("s1", at)).resolves.toBeNull();

    landPurge();
    await purge;
  });

  it("leaves a withdrawal counted while it was writing out of its receipt", async () => {
    // A purge landing during the call must not be folded into the receipt, or
    // the release would not see it.
    m.updateMany.mockImplementationOnce(async () => {
      await invalidateWatchHistoryEvidence(["s1"]);
      return { count: 1 };
    });

    const receipt = await requirePopulationResync("s1", at);

    expect(receipt!.generation).not.toBe(snapshotWatchEvidence("s1", null).generation);
  });
});

describe("releaseOwnPopulationHold", () => {
  const at = new Date("2026-03-01T10:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("releases on the exact instant, nulling the marker in the same write", async () => {
    const receipt = await requirePopulationResync("s1", at);
    m.updateMany.mockClear();

    await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(true);

    expect(m.updateMany.mock.calls).toHaveLength(1);
    expect(m.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "s1", libraryResyncRequiredAt: at },
      data: { libraryResyncRequiredAt: null, watchHistorySyncedAt: null },
    });
  });

  it("refuses, writing nothing, once any withdrawal was counted for the server since the hold", async () => {
    const receipt = await requirePopulationResync("s1", at);
    // A purge after the population (at any instant — even this hold's own).
    await requireLibraryResync(["s1"], { at });
    m.updateMany.mockClear();

    await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(false);

    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("refuses after a restore rewrote the database", async () => {
    const receipt = await requirePopulationResync("s1", at);
    await invalidateServersWithoutWatchHistory();
    m.updateMany.mockClear();

    await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(false);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("is not affected by another server's withdrawal", async () => {
    const receipt = await requirePopulationResync("s1", at);
    await invalidateWatchHistoryEvidence(["s2"]);

    await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(true);
  });

  it("counts a withdrawal before releasing, so an older history pass cannot vouch afterwards", async () => {
    const receipt = await requirePopulationResync("s1", at);
    const older = snapshotWatchEvidence("s1", null);

    await releaseOwnPopulationHold(receipt!);

    m.updateMany.mockClear();
    await expect(markWatchHistoryEstablishedIfUnchanged(older)).resolves.toBe(false);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("reports false when the compare-and-set finds a different hold", async () => {
    const receipt = await requirePopulationResync("s1", at);
    m.updateMany.mockResolvedValue({ count: 0 });

    await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(false);
  });

  it("puts back a hold requested while its write was in flight, and reports no release", async () => {
    const receipt = await requirePopulationResync("s1", at);
    const raced = new Date(at.getTime() + 5_000);
    m.updateMany.mockClear();
    m.updateMany.mockImplementationOnce(async () => {
      await requireLibraryResync(["s1"], { at: raced });
      return { count: 1 };
    });

    await expect(releaseOwnPopulationHold(receipt!)).resolves.toBe(false);

    expect(m.updateMany.mock.calls.at(-1)![0]).toEqual({
      where: { id: "s1", libraryResyncRequiredAt: null },
      data: { libraryResyncRequiredAt: raced },
    });
  });
});
