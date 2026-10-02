import { describe, it, expect } from "vitest";
import { isSyncRequestSettled, type PendingSyncRequest } from "@/lib/sync/sync-request";

const REQUESTED_AT = "2026-09-25T12:00:00.000Z";

function request(overrides: Partial<PendingSyncRequest> = {}): PendingSyncRequest {
  return { id: 1, serverId: "srv-1", requestedAt: REQUESTED_AT, ...overrides };
}

function servers(job: { status: string; startedAt: string } | null) {
  return [{ id: "srv-1", syncJobs: job ? [job] : [] }];
}

describe("isSyncRequestSettled", () => {
  it("is not settled by the previous run's finished row", () => {
    // The original bug: the newest job at the moment Sync is pressed is the
    // previous run's COMPLETED row, and reading its status ended the request
    // before this run existed.
    const previous = { status: "COMPLETED", startedAt: "2026-09-25T11:00:00.000Z" };
    expect(isSyncRequestSettled(request(), servers(previous))).toBe(false);
  });

  it("is not settled while the POST is still in flight", () => {
    const finished = { status: "COMPLETED", startedAt: "2026-09-25T12:00:01.000Z" };
    expect(isSyncRequestSettled(request({ requestedAt: null }), servers(finished))).toBe(false);
  });

  it("is not settled while this request's run is still going", () => {
    for (const status of ["PENDING", "RUNNING"]) {
      const job = { status, startedAt: "2026-09-25T12:00:01.000Z" };
      expect(isSyncRequestSettled(request(), servers(job))).toBe(false);
    }
  });

  it("is settled once a run started at or after the request ends, however it ends", () => {
    for (const status of ["COMPLETED", "FAILED", "CANCELLED"]) {
      expect(isSyncRequestSettled(request(), servers({ status, startedAt: REQUESTED_AT }))).toBe(true);
      expect(
        isSyncRequestSettled(request(), servers({ status, startedAt: "2026-09-25T12:03:00.000Z" })),
      ).toBe(true);
    }
  });

  it("is not settled when the server has no job yet, or is not in the list", () => {
    expect(isSyncRequestSettled(request(), servers(null))).toBe(false);
    expect(isSyncRequestSettled(request({ serverId: "srv-2" }), servers(null))).toBe(false);
  });
});
