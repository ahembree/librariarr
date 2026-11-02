/** Ordering edge cases of the two pure job pickers the sync indicators share. */
import { describe, it, expect } from "vitest";
import { latestSyncOutcome } from "@/lib/sync/latest-outcome";
import { activeSyncPerServer } from "@/lib/sync/active-sync";

describe("latestSyncOutcome", () => {
  it("ranks a success with no completion time behind a timed failure", () => {
    const failed = { status: "FAILED", completedAt: "2026-01-01T00:00:00Z" };
    const completed = { status: "COMPLETED", completedAt: null };
    expect(latestSyncOutcome([completed, failed])).toEqual({ status: "FAILED", job: failed });
  });

  it("keeps a timed success ahead of a failure with no completion time", () => {
    const failed = { status: "FAILED", completedAt: null };
    const completed = { status: "COMPLETED", completedAt: "2026-01-01T00:00:00Z" };
    expect(latestSyncOutcome([failed, completed])).toEqual({ status: "COMPLETED", job: completed });
  });
});

describe("activeSyncPerServer", () => {
  it("keeps the older queued row when a newer one arrives for the same server", () => {
    const older = { mediaServerId: "s1", status: "PENDING", startedAt: "2026-01-01T00:00:00Z", id: "a" };
    const newer = { mediaServerId: "s1", status: "PENDING", startedAt: "2026-01-01T00:05:00Z", id: "b" };
    expect(activeSyncPerServer([older, newer])).toEqual([older]);
  });

  it("ignores a queued row once the server's running one was seen", () => {
    const running = { mediaServerId: "s1", status: "RUNNING", startedAt: "2026-01-01T00:05:00Z" };
    const queued = { mediaServerId: "s1", status: "PENDING", startedAt: "2026-01-01T00:00:00Z" };
    expect(activeSyncPerServer([running, queued])).toEqual([running]);
  });
});
