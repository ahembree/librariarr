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
}));

vi.mock("@/lib/db", () => ({
  prisma: { mediaServer: { updateMany: m.updateMany, findMany: m.findMany } },
}));

import {
  invalidateWatchHistoryEvidence,
  invalidateServersWithoutWatchHistory,
  markWatchHistoryEstablishedIfUnchanged,
  restartTracearrBackfill,
  snapshotWatchEvidence,
} from "@/lib/media/watch-evidence";

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
    // The restarted walk covers any gap an interrupted forward walk recorded.
    expect(arg.data.tracearrForwardFloorAt).toBeNull();
    // A last-walk stamp describes the history that was just destroyed.
    expect(arg.data.tracearrBackfillLastWalkAt).toBeNull();
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

  it("writes only where the marker is still the one the run started with", async () => {
    const marker = new Date("2025-01-01T00:00:00Z");
    const snapshot = snapshotWatchEvidence("s1", marker);

    await expect(markWatchHistoryEstablishedIfUnchanged(snapshot)).resolves.toBe(true);

    expect(establishCalls()[0][0].where).toEqual({ id: "s1", watchHistorySyncedAt: marker });
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
