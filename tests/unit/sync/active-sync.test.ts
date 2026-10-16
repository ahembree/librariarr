import { describe, it, expect } from "vitest";
import { activeSyncPerServer } from "@/lib/sync/active-sync";

const job = (id: string, mediaServerId: string, status: string, startedAt: string) => ({
  id, mediaServerId, status, startedAt,
});

describe("activeSyncPerServer", () => {
  it("draws one line per server, preferring the running sync", () => {
    const jobs = [
      job("queued-2", "plex", "PENDING", "2026-01-01T00:02:00Z"),
      job("running", "plex", "RUNNING", "2026-01-01T00:00:00Z"),
      job("queued-1", "plex", "PENDING", "2026-01-01T00:01:00Z"),
      job("other", "jelly", "PENDING", "2026-01-01T00:03:00Z"),
    ];
    expect(activeSyncPerServer(jobs).map((j) => j.id)).toEqual(["running", "other"]);
  });

  it("shows the oldest queued row of a server with nothing running", () => {
    const jobs = [
      job("later", "plex", "PENDING", "2026-01-01T00:02:00Z"),
      job("first", "plex", "PENDING", "2026-01-01T00:01:00Z"),
    ];
    expect(activeSyncPerServer(jobs).map((j) => j.id)).toEqual(["first"]);
  });

  it("leaves finished rows out", () => {
    const jobs = [
      job("done", "plex", "COMPLETED", "2026-01-01T00:00:00Z"),
      job("failed", "jelly", "FAILED", "2026-01-01T00:00:00Z"),
    ];
    expect(activeSyncPerServer(jobs)).toEqual([]);
  });
});
