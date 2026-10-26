import { describe, it, expect } from "vitest";
import { mergeSyncProgress, type SyncStatusJob } from "@/app/(authenticated)/settings/sync-progress";
import type { MediaServer } from "@/app/(authenticated)/settings/types";

type Job = MediaServer["syncJobs"][number];

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    status: "RUNNING",
    startedAt: "2026-10-26T10:00:00.000Z",
    completedAt: null,
    itemsProcessed: 10,
    totalItems: 100,
    currentLibrary: "Movies",
    error: null,
    ...overrides,
  };
}

function server(id: string, jobs: Job[]): MediaServer {
  return {
    id,
    name: `Server ${id}`,
    url: "http://plex.lan:32400",
    type: "PLEX",
    machineId: null,
    tlsSkipVerify: false,
    enabled: true,
    tracearrServerId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    libraries: [],
    syncJobs: jobs,
  };
}

/** A row as `/api/sync/status` sends it: the SyncJob plus its server. */
function statusJob(serverId: string, overrides: Partial<Job> = {}): SyncStatusJob {
  return { ...job(overrides), mediaServerId: serverId, cancelRequested: false } as SyncStatusJob;
}

describe("mergeSyncProgress", () => {
  it("moves a running sync's figures", () => {
    const servers = [server("s1", [job()])];
    const merged = mergeSyncProgress(servers, [statusJob("s1", { itemsProcessed: 55, currentLibrary: "Shows" })]);
    expect(merged[0].syncJobs[0]).toMatchObject({ id: "job-1", itemsProcessed: 55, currentLibrary: "Shows" });
    // The rest of the server row is untouched.
    expect(merged[0].libraries).toBe(servers[0].libraries);
  });

  it("shows a queued row as running once it starts", () => {
    const servers = [server("s1", [job({ status: "PENDING", itemsProcessed: 0, totalItems: 0 })])];
    const merged = mergeSyncProgress(servers, [statusJob("s1", { status: "RUNNING", itemsProcessed: 3, totalItems: 40 })]);
    expect(merged[0].syncJobs[0]).toMatchObject({ status: "RUNNING", itemsProcessed: 3, totalItems: 40 });
  });

  it("prefers the running row over a queued one, as the server list does", () => {
    const servers = [server("s1", [job({ id: "queued", status: "PENDING" })])];
    const merged = mergeSyncProgress(servers, [
      statusJob("s1", { id: "queued", status: "PENDING" }),
      statusJob("s1", { id: "running", status: "RUNNING", itemsProcessed: 70 }),
    ]);
    expect(merged[0].syncJobs[0]).toMatchObject({ id: "running", status: "RUNNING", itemsProcessed: 70 });
  });

  it("never starts or ends a sync's display", () => {
    // The list shows the previous run finished; a progress read cannot bring
    // a RUNNING row back over it (only a server-list read starts the display).
    const finished = [server("s1", [job({ status: "COMPLETED", completedAt: "2026-10-26T10:05:00.000Z" })])];
    expect(mergeSyncProgress(finished, [statusJob("s1", { status: "RUNNING" })])).toBe(finished);

    // And a finished row in the status list does not end a running one: the
    // `sync:completed` refetch does, which `isSyncRequestSettled` reads.
    const running = [server("s1", [job()])];
    const merged = mergeSyncProgress(running, [statusJob("s1", { status: "COMPLETED", itemsProcessed: 100 })]);
    expect(merged).toBe(running);
  });

  it("reads only the server's own jobs", () => {
    const servers = [server("s1", [job()]), server("s2", [job({ id: "job-2" })])];
    const merged = mergeSyncProgress(servers, [statusJob("s2", { id: "job-2", itemsProcessed: 90 })]);
    expect(merged[0]).toBe(servers[0]);
    expect(merged[1].syncJobs[0].itemsProcessed).toBe(90);
  });

  it("returns the same list when nothing moved", () => {
    const servers = [server("s1", [job()]), server("s2", [])];
    expect(mergeSyncProgress(servers, [statusJob("s1")])).toBe(servers);
    expect(mergeSyncProgress(servers, [])).toBe(servers);
  });

  it("ignores a row without the figures it would copy", () => {
    const servers = [server("s1", [job()])];
    const malformed = { id: "job-1", status: "RUNNING", mediaServerId: "s1" } as SyncStatusJob;
    expect(mergeSyncProgress(servers, [malformed])).toBe(servers);
  });
});
