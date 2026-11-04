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
const { addJob, makeWorkerUtils, poolOn, poolQuery, error, warn } = m;

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

import { Pool } from "pg";
import { enqueueJob, getJobsPool, isJobRetrying, queuedSyncJobIds, releaseJobsClient } from "@/lib/jobs/client";

describe("jobs client", () => {
  beforeEach(async () => {
    // The pool and the worker utils are module singletons: release them so
    // every test starts from a cold client, whatever ran before it.
    await releaseJobsClient();
    vi.clearAllMocks();
  });

  it("creates a single shared pool with error handlers", () => {
    const a = getJobsPool();
    const b = getJobsPool();
    expect(a).toBe(b);
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledWith({ connectionString: process.env.DATABASE_URL, max: 4 });
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

  it("tries again on the next enqueue after the worker utils could not be made", async () => {
    // The database was briefly unreachable at the first enqueue. Caching that
    // failure made every later enqueue of the bundle fail until a restart.
    makeWorkerUtils.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(enqueueJob("task-a", {})).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith("Jobs", 'Failed to enqueue job "task-a"', { error: "Error: ECONNREFUSED" });

    await expect(enqueueJob("task-b", { y: 2 })).resolves.toBe(true);
    expect(makeWorkerUtils).toHaveBeenCalledTimes(2);
    expect(addJob).toHaveBeenCalledWith("task-b", { y: 2 }, undefined);

    // ...and once made, the utils are cached again.
    await expect(enqueueJob("task-c", {})).resolves.toBe(true);
    expect(makeWorkerUtils).toHaveBeenCalledTimes(2);
  });

  it("gives every enqueue waiting on a failed attempt its error, then retries once", async () => {
    let rejectAttempt!: (error: Error) => void;
    makeWorkerUtils.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectAttempt = reject; }));
    const first = enqueueJob("task-a", {});
    const second = enqueueJob("task-b", {});
    await vi.waitFor(() => expect(makeWorkerUtils).toHaveBeenCalledTimes(1));
    rejectAttempt(new Error("ECONNREFUSED"));
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);

    await expect(enqueueJob("task-c", {})).resolves.toBe(true);
    expect(makeWorkerUtils).toHaveBeenCalledTimes(2);
  });

  it("logs enqueue errors and resolves false (never throws)", async () => {
    addJob.mockRejectedValueOnce(new Error("db down"));
    await expect(enqueueJob("task-c", {})).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith("Jobs", 'Failed to enqueue job "task-c"', { error: "Error: db down" });
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
      expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining("graphile_worker.jobs"), ["sync:s1"]);
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
      expect(warn).toHaveBeenCalledWith("Jobs", 'Could not read the queued priority for "sync:s1"', {
        error: "Error: no such relation",
      });
    });
  });

  describe("a realtime watch-history enqueue replacing a queued job", () => {
    const spec = { jobKey: "watch-history:s1", queueName: "main", maxAttempts: 3 };

    it("keeps a queued full replace instead of making it incremental", async () => {
      // by-type's deferred refresh is waiting under the key as a full replace.
      poolQuery.mockResolvedValueOnce({ rows: [{ incremental: null }] });
      await enqueueJob("sync-watch-history", { serverId: "s1", incremental: true }, spec);
      const [sql, params] = poolQuery.mock.calls[0];
      // The payload is only on the private table; a running job is not replaced.
      expect(sql).toContain("graphile_worker._private_jobs");
      expect(sql).toContain('"locked_at" IS NULL');
      expect(params).toEqual(["watch-history:s1"]);
      expect(addJob).toHaveBeenCalledWith("sync-watch-history", { serverId: "s1" }, spec);
    });

    it("keeps a queued full replace that says incremental: false", async () => {
      poolQuery.mockResolvedValueOnce({ rows: [{ incremental: "false" }] });
      await enqueueJob("sync-watch-history", { serverId: "s1", incremental: true }, spec);
      expect(addJob).toHaveBeenCalledWith("sync-watch-history", { serverId: "s1" }, spec);
    });

    it("stays incremental when the queued job is incremental too", async () => {
      poolQuery.mockResolvedValueOnce({ rows: [{ incremental: "true" }] });
      await enqueueJob("sync-watch-history", { serverId: "s1", incremental: true }, spec);
      expect(addJob).toHaveBeenCalledWith("sync-watch-history", { serverId: "s1", incremental: true }, spec);
    });

    it("stays incremental when nothing is queued under the key", async () => {
      await enqueueJob("sync-watch-history", { serverId: "s1", incremental: true }, spec);
      expect(addJob).toHaveBeenCalledWith("sync-watch-history", { serverId: "s1", incremental: true }, spec);
    });

    it("looks nothing up for a full replace or another task", async () => {
      await enqueueJob("sync-watch-history", { serverId: "s1" }, spec);
      await enqueueJob("sync-server", { serverId: "s1", incremental: true }, { jobKey: "sync:s1" });
      expect(poolQuery.mock.calls.some(([sql]) => String(sql).includes("_private_jobs"))).toBe(false);
    });

    it("looks nothing up for an unkeyed enqueue", async () => {
      await enqueueJob("sync-watch-history", { serverId: "s1", incremental: true }, { queueName: "main" });
      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("still enqueues as asked when the lookup fails", async () => {
      poolQuery.mockRejectedValueOnce(new Error("no such relation"));
      await expect(enqueueJob("sync-watch-history", { serverId: "s1", incremental: true }, spec)).resolves.toBe(true);
      expect(addJob).toHaveBeenCalledWith("sync-watch-history", { serverId: "s1", incremental: true }, spec);
      expect(warn).toHaveBeenCalledWith("Jobs", 'Could not read the queued watch-history refresh for "watch-history:s1"', {
        error: "Error: no such relation",
      });
    });
  });

  describe("isJobRetrying", () => {
    it("asks for a job that failed and still has attempts left", async () => {
      poolQuery.mockResolvedValueOnce({ rows: [{ retrying: true }] });
      await expect(isJobRetrying("tracearr-backfill:s1")).resolves.toBe(true);
      const [sql, params] = poolQuery.mock.calls[0];
      expect(sql).toContain('"attempts" > 0');
      // A parked job (attempts used up) is not backing off — enqueueing it is
      // how it gets a fresh start.
      expect(sql).toContain('"attempts" < "max_attempts"');
      expect(sql).toContain('"locked_at" IS NULL');
      expect(params).toEqual(["tracearr-backfill:s1"]);
    });

    it("answers false when nothing is backing off", async () => {
      poolQuery.mockResolvedValueOnce({ rows: [{ retrying: false }] });
      await expect(isJobRetrying("k")).resolves.toBe(false);
    });

    it("answers false when the lookup fails, so the caller enqueues as before", async () => {
      poolQuery.mockRejectedValueOnce(new Error("no such relation"));
      await expect(isJobRetrying("k")).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith("Jobs", 'Could not read the retry state of "k"', {
        error: "Error: no such relation",
      });
    });
  });

  describe("queuedSyncJobIds", () => {
    it("reads the row each still-queued job carries, by key", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [
          { key: "sync:s1:m1", syncJobId: "row-1" },
          { key: "sync:s1:m2", syncJobId: null }, // a job queued with no row (the scheduler's)
        ],
      });
      await expect(queuedSyncJobIds(["sync:s1:m1", "sync:s1:m2"])).resolves.toEqual(new Map([["sync:s1:m1", "row-1"]]));
      const [sql, params] = poolQuery.mock.calls[0];
      // The payload is only on the private table; a running job is not replaced.
      expect(sql).toContain("graphile_worker._private_jobs");
      expect(sql).toContain('"locked_at" IS NULL');
      expect(params).toEqual([["sync:s1:m1", "sync:s1:m2"]]);
    });

    it("asks nothing for no keys", async () => {
      await expect(queuedSyncJobIds([])).resolves.toEqual(new Map());
      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("answers null when the lookup fails, so the caller does not guess", async () => {
      poolQuery.mockRejectedValueOnce(new Error("no such relation"));
      await expect(queuedSyncJobIds(["k"])).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith("Jobs", "Could not read the queued sync jobs", {
        error: "Error: no such relation",
      });
    });
  });

  afterAll(async () => {
    await releaseJobsClient();
  });
});
