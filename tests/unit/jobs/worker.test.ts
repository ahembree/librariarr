import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const stop = vi.fn().mockResolvedValue(undefined);
  return {
    stop,
    runner: { promise: Promise.resolve(), stop },
    run: vi.fn(),
    parseCrontab: vi.fn().mockReturnValue([{ task: "dispatch-scheduled" }]),
  };
});
const { stop, run, parseCrontab } = m;
run.mockResolvedValue(m.runner);

vi.mock("graphile-worker", () => ({ run: m.run, parseCrontab: m.parseCrontab }));
vi.mock("@/lib/jobs/client", () => ({ getJobsPool: vi.fn(() => ({ fake: "pool" })) }));
vi.mock("@/lib/jobs/tasks", () => ({ taskList: { "dispatch-scheduled": vi.fn() } }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { startWorker, stopWorker } from "@/lib/jobs/worker";

describe("worker runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
