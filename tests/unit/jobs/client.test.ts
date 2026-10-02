import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const m = vi.hoisted(() => {
  const addJob = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn().mockResolvedValue(undefined);
  return {
    addJob,
    release,
    makeWorkerUtils: vi.fn().mockResolvedValue({ addJob, release }),
    poolEnd: vi.fn().mockResolvedValue(undefined),
    poolOn: vi.fn(),
    poolQuery: vi.fn().mockResolvedValue({ rows: [] }),
    error: vi.fn(),
    warn: vi.fn(),
  };
});
const { addJob, makeWorkerUtils, poolEnd, poolOn, poolQuery, error, warn } = m;

vi.mock("graphile-worker", () => ({ makeWorkerUtils: m.makeWorkerUtils }));
vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.on = m.poolOn;
    this.end = m.poolEnd;
    this.query = m.poolQuery;
  }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: m.warn, error: m.error },
}));

import { enqueueJob, getJobsPool, releaseJobsClient } from "@/lib/jobs/client";

describe("jobs client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a single shared pool with error handlers", () => {
    const a = getJobsPool();
    const b = getJobsPool();
    expect(a).toBe(b);
    // error + connect handlers attached
    expect(poolOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(poolOn).toHaveBeenCalledWith("connect", expect.any(Function));
  });

  it("enqueues a job via worker utils, reusing the utils instance", async () => {
    await expect(enqueueJob("task-a", { x: 1 }, { jobKey: "k" })).resolves.toBe(true);
    await expect(enqueueJob("task-b", { y: 2 })).resolves.toBe(true);
    expect(makeWorkerUtils).toHaveBeenCalledTimes(1); // cached
    expect(addJob).toHaveBeenCalledWith("task-a", { x: 1 }, { jobKey: "k" });
    expect(addJob).toHaveBeenCalledWith("task-b", { y: 2 }, undefined);
  });

  it("logs enqueue errors and resolves false (never throws)", async () => {
    addJob.mockRejectedValueOnce(new Error("db down"));
    await expect(enqueueJob("task-c", {})).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith("Jobs", expect.stringContaining("task-c"), expect.any(Object));
  });

  describe("a keyed enqueue replacing a queued job", () => {
    it("keeps the queued job's priority when it is more urgent", async () => {
      // A requested sync waits at -10 under `sync:<id>`; the scheduler's
      // default-priority enqueue under the same key must not demote it.
      poolQuery.mockResolvedValueOnce({ rows: [{ priority: -10 }] });
      await enqueueJob("sync-server", { serverId: "s1" }, { jobKey: "sync:s1", queueName: "main" });
      expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining("graphile_worker.jobs"), ["sync:s1"]);
      expect(addJob).toHaveBeenCalledWith(
        "sync-server",
        { serverId: "s1" },
        { jobKey: "sync:s1", queueName: "main", priority: -10 },
      );
    });

    it("applies a more urgent new priority", async () => {
      poolQuery.mockResolvedValueOnce({ rows: [{ priority: 0 }] });
      await enqueueJob("sync-server", {}, { jobKey: "sync:s1", priority: -10 });
      expect(addJob).toHaveBeenCalledWith("sync-server", {}, { jobKey: "sync:s1", priority: -10 });
    });

    it("leaves the spec alone when nothing is queued under the key", async () => {
      await enqueueJob("sync-server", {}, { jobKey: "sync:s1" });
      expect(addJob).toHaveBeenCalledWith("sync-server", {}, { jobKey: "sync:s1" });
    });

    it("does not look anything up for an unkeyed job", async () => {
      await enqueueJob("task", {}, { queueName: "main" });
      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("still enqueues when the lookup fails", async () => {
      poolQuery.mockRejectedValueOnce(new Error("no such relation"));
      await expect(enqueueJob("sync-server", {}, { jobKey: "sync:s1" })).resolves.toBe(true);
      expect(addJob).toHaveBeenCalledWith("sync-server", {}, { jobKey: "sync:s1" });
      expect(warn).toHaveBeenCalled();
    });
  });

  afterAll(async () => {
    await releaseJobsClient();
  });
});
