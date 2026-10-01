import { describe, it, expect } from "vitest";
import { latestSyncOutcome } from "@/lib/sync/latest-outcome";

const job = (id: string, status: string, completedAt: string | null) => ({ id, status, completedAt });

describe("latestSyncOutcome", () => {
  it("reports a failure that came after a success", () => {
    const out = latestSyncOutcome([
      job("ok", "COMPLETED", "2026-10-01T10:00:00Z"),
      job("bad", "FAILED", "2026-10-01T12:00:00Z"),
    ]);
    expect(out).toEqual({ status: "FAILED", job: expect.objectContaining({ id: "bad" }) });
  });

  it("reports a success that came after a failure", () => {
    const out = latestSyncOutcome([
      job("bad", "FAILED", "2026-10-01T10:00:00Z"),
      job("ok", "COMPLETED", "2026-10-01T12:00:00Z"),
    ]);
    expect(out?.status).toBe("COMPLETED");
    expect(out?.job.id).toBe("ok");
  });

  it("picks the newest of each status regardless of list order", () => {
    const out = latestSyncOutcome([
      job("old", "COMPLETED", "2026-09-01T00:00:00Z"),
      job("new", "COMPLETED", "2026-10-01T00:00:00Z"),
      job("mid", "FAILED", "2026-09-15T00:00:00Z"),
    ]);
    expect(out?.job.id).toBe("new");
  });

  it("reports a failure without a completion time when nothing succeeded", () => {
    expect(latestSyncOutcome([job("bad", "FAILED", null)])?.status).toBe("FAILED");
  });

  it("ignores active and cancelled jobs", () => {
    expect(latestSyncOutcome([job("r", "RUNNING", null), job("c", "CANCELLED", "2026-10-01T00:00:00Z")])).toBeNull();
  });
});
