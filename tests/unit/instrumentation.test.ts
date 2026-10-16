import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Boot order in `src/instrumentation.ts`. The orphaned-SyncJob cleanup must
 * finish before the worker starts — the worker's first job can be the sync a
 * restart interrupted, and its "already running" guard reads the RUNNING row
 * the cleanup clears, so racing it made the retry skip itself — and a cleanup
 * that fails must neither block boot nor surface as an unhandled rejection.
 */

const { order, cleanup, startWorker, logError } = vi.hoisted(() => ({
  order: [] as string[],
  cleanup: vi.fn(),
  startWorker: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/sync/cleanup-orphaned-syncs", () => ({ cleanupOrphanedSyncJobs: cleanup }));
vi.mock("@/lib/jobs/worker", () => ({ startWorker }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError },
}));
vi.mock("@/lib/maintenance/enforcer", () => ({
  initializeMaintenanceEnforcer: vi.fn(),
  initializePrerollEnforcer: vi.fn(),
}));
vi.mock("@/lib/media-server/realtime", () => ({ startRealtime: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ runBackfillIfNeeded: vi.fn() }));
vi.mock("@/lib/version/update-checker", () => ({ warmVersionCache: vi.fn() }));

import { register } from "@/instrumentation";

describe("instrumentation register()", () => {
  const runtime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    process.env.NEXT_RUNTIME = "nodejs";
    // `register` arms a 6-hour version-cache refresh.
    vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    startWorker.mockImplementation(async () => {
      order.push("worker");
    });
  });

  afterEach(() => {
    process.env.NEXT_RUNTIME = runtime;
    vi.restoreAllMocks();
  });

  it("finishes the orphaned-sync cleanup before starting the worker", async () => {
    cleanup.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("cleanup");
    });

    await register();

    expect(order).toEqual(["cleanup", "worker"]);
  });

  it("logs a failed cleanup and still starts the worker", async () => {
    cleanup.mockRejectedValue(new Error("database is starting up"));

    await expect(register()).resolves.toBeUndefined();

    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      "Sync",
      "Failed to clean up orphaned sync jobs",
      expect.objectContaining({ error: expect.stringContaining("database is starting up") }),
    );
  });
});
