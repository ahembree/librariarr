import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return {
    stop,
    query,
    pool: { query },
    runner: { promise: Promise.resolve(), stop },
    run: vi.fn(),
    runMigrations: vi.fn().mockResolvedValue(undefined),
    parseCrontab: vi.fn().mockReturnValue([{ task: "dispatch-scheduled" }]),
  };
});
const { stop, run, runMigrations, parseCrontab, query } = m;
run.mockResolvedValue(m.runner);

vi.mock("graphile-worker", () => ({ run: m.run, runMigrations: m.runMigrations, parseCrontab: m.parseCrontab }));
vi.mock("@/lib/jobs/client", () => ({ getJobsPool: vi.fn(() => m.pool) }));
vi.mock("@/lib/jobs/tasks", () => ({ taskList: { "dispatch-scheduled": vi.fn() } }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { startWorker, stopWorker, recoverOrphanedWorkerLocks } from "@/lib/jobs/worker";

describe("worker runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMigrations.mockResolvedValue(undefined);
    query.mockResolvedValue({ rows: [] });
    run.mockResolvedValue(m.runner);
  });

  it("starts the runner once and is idempotent", async () => {
    await startWorker();
    await startWorker();
    expect(run).toHaveBeenCalledTimes(1);

    const opts = run.mock.calls[0][0];
    expect(opts.taskList).toBeDefined();
    expect(opts.parsedCronItems).toEqual([{ task: "dispatch-scheduled" }]);
    expect(opts.noHandleSignals).toBe(false);
    expect(opts.concurrency).toBeGreaterThan(0);
    expect(parseCrontab).toHaveBeenCalledOnce();

    await stopWorker();
  });

  it("builds a crontab that includes the dispatcher every minute", async () => {
    await startWorker();
    const crontab = parseCrontab.mock.calls[0][0] as string;
    expect(crontab).toMatch(/^\* \* \* \* \* dispatch-scheduled$/m);
    await stopWorker();
  });

  it("stopWorker stops the runner and allows a fresh start", async () => {
    await startWorker();
    await stopWorker();
    expect(stop).toHaveBeenCalled();

    await startWorker();
    expect(run).toHaveBeenCalledTimes(2);
    await stopWorker();
  });

  it("clears stale queue and job locks before starting the runner", async () => {
    const order: string[] = [];
    runMigrations.mockImplementation(async () => { order.push("migrate"); });
    query.mockImplementation(async (sql: string) => {
      order.push(/job_queues/.test(sql) ? "clear-queues" : "clear-jobs");
      return { rows: [] };
    });
    run.mockImplementation(async () => { order.push("run"); return m.runner; });

    await startWorker();

    // Both lock tables are cleared, and all recovery happens before run().
    expect(query).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["migrate", "clear-queues", "clear-jobs", "run"]);

    const queueSql = query.mock.calls.find((c) => /_private_job_queues/.test(c[0] as string))?.[0] as string;
    const jobSql = query.mock.calls.find((c) => /_private_jobs/.test(c[0] as string))?.[0] as string;
    expect(queueSql).toMatch(/set\s+locked_at = null, locked_by = null/);
    expect(queueSql).toMatch(/where locked_at is not null/);
    expect(jobSql).toMatch(/set\s+locked_at = null, locked_by = null/);

    await stopWorker();
  });

  it("starts the runner even if lock recovery fails", async () => {
    query.mockRejectedValueOnce(new Error("db down"));

    // Recovery errors are swallowed so a transient DB hiccup can't block boot.
    await expect(startWorker()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);

    await stopWorker();
  });

  it("recoverOrphanedWorkerLocks migrates then clears both lock tables", async () => {
    await recoverOrphanedWorkerLocks(m.pool as never);

    expect(runMigrations).toHaveBeenCalledWith({ pgPool: m.pool });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some((c) => /_private_job_queues/.test(c[0] as string))).toBe(true);
    expect(query.mock.calls.some((c) => /_private_jobs/.test(c[0] as string))).toBe(true);
  });

  it("allows a restart after the runner dies unexpectedly", async () => {
    // Runner whose promise rejects to simulate an unexpected death.
    let rejectPromise: (e: unknown) => void = () => {};
    const dyingRunner = {
      promise: new Promise((_resolve, reject) => { rejectPromise = reject; }),
      stop,
    };
    run.mockResolvedValueOnce(dyingRunner);

    await startWorker();
    expect(run).toHaveBeenCalledTimes(1);

    // Trigger the unexpected-death handler and let microtasks flush.
    rejectPromise(new Error("connection lost"));
    await new Promise((r) => setTimeout(r, 0));

    // A subsequent start should spin up a brand new runner, not return stale state.
    await startWorker();
    expect(run).toHaveBeenCalledTimes(2);
    await stopWorker();
  });
});
