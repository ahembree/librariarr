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
    error: vi.fn(),
  };
});
const { addJob, makeWorkerUtils, poolEnd, poolOn, error } = m;

vi.mock("graphile-worker", () => ({ makeWorkerUtils: m.makeWorkerUtils }));
vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.on = m.poolOn;
    this.end = m.poolEnd;
  }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: m.error },
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

  afterAll(async () => {
    await releaseJobsClient();
  });
});
