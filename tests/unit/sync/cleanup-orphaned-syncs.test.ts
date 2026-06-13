import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRawUnsafe: vi.fn(),
  },
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/logger", () => ({
  logger: mockLogger,
}));

import { cleanupOrphanedSyncJobs } from "@/lib/sync/cleanup-orphaned-syncs";

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
    expect(sql).toContain("'RUNNING', 'PENDING'");

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

  it("logs the singular-message count for a single orphan", async () => {
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
