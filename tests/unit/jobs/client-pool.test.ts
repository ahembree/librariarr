/**
 * The jobs pool's connection handling and release: every client the pool hands
 * out gets an error handler (a dropped backend connection must not crash the
 * process), and releasing is safe to repeat.
 */
import { describe, it, expect, vi } from "vitest";

const m = vi.hoisted(() => ({
  on: vi.fn(),
  end: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
  release: vi.fn().mockResolvedValue(undefined),
  addJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("graphile-worker", () => ({
  makeWorkerUtils: vi.fn(async () => ({ addJob: m.addJob, release: m.release })),
}));
vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.on = m.on;
    this.end = m.end;
    this.query = m.query;
  }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { enqueueJob, getJobsPool, queuedSyncJobIds, releaseJobsClient } from "@/lib/jobs/client";

describe("jobs pool", () => {
  it("attaches an error handler to every client the pool connects", () => {
    getJobsPool();
    const connect = m.on.mock.calls.find((c) => c[0] === "connect")?.[1] as (c: unknown) => void;
    const clientOn = vi.fn();
    connect({ on: clientOn });
    expect(clientOn).toHaveBeenCalledWith("error", expect.any(Function));
    // The handler swallows the error rather than rethrowing it.
    expect(() => (clientOn.mock.calls[0][1] as (e: Error) => void)(new Error("terminated"))).not.toThrow();
  });

  it("ignores queued jobs that carry no sync row", async () => {
    m.query.mockResolvedValueOnce({ rows: [{ key: "sync:a", syncJobId: null }, { key: "sync:b", syncJobId: "row-b" }] });
    expect(await queuedSyncJobIds(["sync:a", "sync:b"])).toEqual(new Map([["sync:b", "row-b"]]));
  });

  it("releases utils and pool once, and a second release is a no-op", async () => {
    m.query.mockResolvedValue({ rows: [] });
    await enqueueJob("t", {}, { jobKey: "k" });
    await releaseJobsClient();
    await releaseJobsClient();
    expect(m.release).toHaveBeenCalledTimes(1);
    expect(m.end).toHaveBeenCalledTimes(1);
  });
});
