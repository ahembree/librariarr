import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The write half of `MediaServer.watchHistoryClearedAt`.
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
  markWatchHistoryCleared,
  markServersWithoutWatchHistory,
} from "@/lib/media/watch-evidence";

describe("markWatchHistoryCleared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 0 });
    m.findMany.mockResolvedValue([]);
  });

  it("marks only servers that are not already marked", async () => {
    m.updateMany.mockResolvedValue({ count: 2 });

    await markWatchHistoryCleared(["s1", "s2"]);

    const arg = m.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      id: { in: ["s1", "s2"] },
      // Without this the timestamp would slide forward on every bulk
      // operation, so a server marked days ago would look freshly cleared.
      watchHistoryClearedAt: null,
    });
    expect(arg.data.watchHistoryClearedAt).toBeInstanceOf(Date);
  });

  it("issues no UPDATE at all for an empty list", async () => {
    // An unscoped `updateMany` here would mark EVERY server on the install and
    // pause every watchedByUser rule set at once.
    await expect(markWatchHistoryCleared([])).resolves.toBe(0);
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});

describe("markServersWithoutWatchHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 0 });
  });

  it("selects on the absence of plays, not on any operation's own bookkeeping", async () => {
    // Used by restore, which truncates the whole database and re-inserts
    // servers from the file — the affected ids are not knowable up front.
    m.findMany.mockResolvedValue([{ id: "s1" }]);
    m.updateMany.mockResolvedValue({ count: 1 });

    await expect(markServersWithoutWatchHistory()).resolves.toBe(1);

    expect(m.findMany.mock.calls[0][0].where).toMatchObject({
      watchHistoryClearedAt: null,
      watchHistory: { none: {} },
    });
  });

  it("marks nothing when every server still holds plays", async () => {
    m.findMany.mockResolvedValue([]);

    await expect(markServersWithoutWatchHistory()).resolves.toBe(0);
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});
