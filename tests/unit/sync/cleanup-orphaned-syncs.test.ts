import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma, mockLogger, mockEmit } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRawUnsafe: vi.fn(),
    syncJob: { findMany: vi.fn(), updateMany: vi.fn() },
    mediaServer: { findUnique: vi.fn() },
  },
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockEmit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/logger", () => ({
  logger: mockLogger,
}));

vi.mock("@/lib/events/event-bus", () => ({
  eventBus: { emit: mockEmit },
}));

import { cleanupOrphanedSyncJobs, closeDeadSyncJobs, DEAD_SYNC_RUN_ERROR } from "@/lib/sync/cleanup-orphaned-syncs";
import { beginSyncRun, endSyncRun } from "@/lib/sync/live-sync-runs";

describe("cleanupOrphanedSyncJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks orphaned RUNNING/PENDING jobs as FAILED and logs the count", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ count: 3n }]);

    await cleanupOrphanedSyncJobs();

    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE "SyncJob"');
    expect(sql).toContain("SET \"status\" = 'FAILED'");
    expect(sql).toContain('"completedAt" = NOW()');
    expect(sql).toContain("\"error\" = 'Server restarted while sync was in progress'");
    expect(sql).toContain("WHERE \"status\" IN ('RUNNING', 'PENDING')");

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Sync",
      "Cleaned up 3 orphaned sync job(s) from previous run",
    );
  });

  it("does not log when there are no orphaned jobs", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ count: 0n }]);

    await cleanupOrphanedSyncJobs();

    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("treats a missing/empty result row as zero (no log)", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    await cleanupOrphanedSyncJobs();

    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("handles an undefined count field as zero (no log)", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ count: undefined }]);

    await cleanupOrphanedSyncJobs();

    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("logs a count of one for a single orphan", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ count: 1n }]);

    await cleanupOrphanedSyncJobs();

    expect(mockLogger.info).toHaveBeenCalledWith(
      "Sync",
      "Cleaned up 1 orphaned sync job(s) from previous run",
    );
  });

  it("propagates a DB error to the caller", async () => {
    mockPrisma.$queryRawUnsafe.mockRejectedValueOnce(new Error("db down"));

    await expect(cleanupOrphanedSyncJobs()).rejects.toThrow("db down");
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});

describe("closeDeadSyncJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.mediaServer.findUnique.mockResolvedValue({ userId: "u1" });
  });

  it("does nothing when the server has no RUNNING row", async () => {
    mockPrisma.syncJob.findMany.mockResolvedValueOnce([]);

    expect(await closeDeadSyncJobs("s1")).toBe(0);

    expect(mockPrisma.syncJob.findMany).toHaveBeenCalledWith({
      where: { mediaServerId: "s1", status: "RUNNING" },
      select: { id: true },
    });
    expect(mockPrisma.syncJob.updateMany).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("leaves a row whose run is live alone", async () => {
    mockPrisma.syncJob.findMany.mockResolvedValueOnce([{ id: "live" }]);
    beginSyncRun("live");
    try {
      expect(await closeDeadSyncJobs("s1")).toBe(0);
    } finally {
      endSyncRun("live");
    }
    expect(mockPrisma.syncJob.updateMany).not.toHaveBeenCalled();
  });

  it("closes only the dead rows, still RUNNING, and announces it", async () => {
    mockPrisma.syncJob.findMany.mockResolvedValueOnce([{ id: "live" }, { id: "dead" }]);
    mockPrisma.syncJob.updateMany.mockResolvedValueOnce({ count: 1 });
    beginSyncRun("live");
    try {
      expect(await closeDeadSyncJobs("s1")).toBe(1);
    } finally {
      endSyncRun("live");
    }

    // Conditional on RUNNING: a run that ends between the read and the write
    // keeps its own outcome.
    expect(mockPrisma.syncJob.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["dead"] }, status: "RUNNING" },
      data: { status: "FAILED", completedAt: expect.any(Date), error: DEAD_SYNC_RUN_ERROR, currentLibrary: null },
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Sync",
      "Closed 1 sync job(s) for server s1 left RUNNING by a run that had already ended",
    );
    expect(mockEmit).toHaveBeenCalledWith({ type: "sync:failed", userId: "u1", meta: { serverId: "s1" } });
  });

  it("announces nothing when the row ended on its own meanwhile", async () => {
    mockPrisma.syncJob.findMany.mockResolvedValueOnce([{ id: "dead" }]);
    mockPrisma.syncJob.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await closeDeadSyncJobs("s1")).toBe(0);

    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
