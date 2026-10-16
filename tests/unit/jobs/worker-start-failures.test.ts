/**
 * `startWorker` under failure: concurrent callers share one start, a start
 * that fails is retried by the next call instead of being latched, and a
 * runner that dies later can be restarted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  run: vi.fn(),
  query: vi.fn().mockResolvedValue({ rows: [] }),
  error: vi.fn(),
}));

vi.mock("graphile-worker", () => ({
  run: m.run,
  runMigrations: vi.fn(),
  parseCrontab: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/jobs/client", () => ({ getJobsPool: vi.fn(() => ({ query: m.query })) }));
vi.mock("@/lib/jobs/tasks", () => ({ taskList: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: m.error },
}));

import { startWorker, stopWorker } from "@/lib/jobs/worker";

function runner(promise: Promise<void> = new Promise(() => {})) {
  return { promise, stop: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(async () => {
  await stopWorker();
  vi.clearAllMocks();
  m.query.mockResolvedValue({ rows: [] });
});

describe("startWorker", () => {
  it("shares one in-flight start between concurrent callers", async () => {
    let resolve!: (r: unknown) => void;
    m.run.mockReturnValue(new Promise((r) => { resolve = r; }));

    const first = startWorker();
    const second = startWorker();
    await Promise.resolve();
    resolve(runner());
    await Promise.all([first, second]);

    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it("rethrows a failed start and lets the next call try again", async () => {
    m.run.mockRejectedValueOnce(new Error("migrations failed"));
    await expect(startWorker()).rejects.toThrow("migrations failed");
    expect(m.error).toHaveBeenCalledWith("Jobs", "Failed to start Graphile worker", { error: "Error: migrations failed" });

    m.run.mockResolvedValueOnce(runner());
    await expect(startWorker()).resolves.toBeUndefined();
    expect(m.run).toHaveBeenCalledTimes(2);
  });

  it("still starts when lock recovery fails", async () => {
    m.query.mockRejectedValueOnce(new Error("no schema yet"));
    m.run.mockResolvedValueOnce(runner());

    await startWorker();

    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.error).toHaveBeenCalledWith("Jobs", "Failed to recover orphaned worker locks", { error: "Error: no schema yet" });
  });

  it("can be restarted after the runner stops unexpectedly", async () => {
    let fail!: (e: Error) => void;
    m.run.mockResolvedValueOnce(runner(new Promise((_, reject) => { fail = reject; })));
    await startWorker();

    fail(new Error("connection lost"));
    await new Promise((r) => setImmediate(r));
    expect(m.error).toHaveBeenCalledWith("Jobs", "Graphile worker stopped unexpectedly", { error: "Error: connection lost" });

    m.run.mockResolvedValueOnce(runner());
    await startWorker();
    expect(m.run).toHaveBeenCalledTimes(2);
  });
});
