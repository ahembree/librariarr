import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gunzipSync } from "zlib";

const { mockPrisma, mockLogger, mockFs } = vi.hoisted(() => ({
  mockPrisma: {
    appSettings: { findFirst: vi.fn() },
    logEntry: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockFs: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));
vi.mock("fs/promises", () => ({ default: mockFs, ...mockFs }));

import { archiveLogs } from "@/lib/logs/archive";

// LOG_ARCHIVE_DIR is read at module-eval (before this file's body runs, since
// ESM imports are hoisted), so the module uses the default. fs is fully mocked,
// so no real path is touched — we just assert against the computed default.
const ARCHIVE_DIR = "/config/logs";

describe("archiveLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Pin "today" so the day-walk is bounded and deterministic.
    vi.setSystemTime(new Date("2026-06-13T12:00:00Z"));
    mockPrisma.appSettings.findFirst.mockResolvedValue({ logRetentionDays: 7 });
    mockFs.readdir.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing (no archive written) when there are no logs before today", async () => {
    mockPrisma.logEntry.findFirst.mockResolvedValue(null);

    await archiveLogs();

    expect(mockFs.mkdir).toHaveBeenCalledWith(ARCHIVE_DIR, { recursive: true });
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(mockPrisma.logEntry.deleteMany).not.toHaveBeenCalled();
  });

  it("writes a gzipped tar archive for a day's logs and deletes the rows", async () => {
    // Oldest log is the day before today.
    mockPrisma.logEntry.findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-12T05:00:00Z"),
    });
    // No existing archive file → fs.access rejects.
    mockFs.access.mockRejectedValue(new Error("ENOENT"));

    const rows = [
      { id: "l1", level: "INFO", message: "hello", createdAt: new Date("2026-06-12T05:00:00Z") },
      { id: "l2", level: "WARN", message: "uh oh", createdAt: new Date("2026-06-12T06:00:00Z") },
    ];
    mockPrisma.logEntry.findMany.mockResolvedValue(rows);
    mockPrisma.logEntry.deleteMany.mockResolvedValue({ count: 2 });

    await archiveLogs();

    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenData] = mockFs.writeFile.mock.calls[0];
    expect(writtenPath).toBe(`${ARCHIVE_DIR}/logs-2026-06-12.tar.gz`);

    // The written buffer must be valid gzip and the tar must embed the JSON.
    const tar = gunzipSync(writtenData as Buffer);
    const text = tar.toString("utf-8");
    expect(text).toContain("logs-2026-06-12.json"); // tar header filename
    expect(text).toContain('"id": "l1"');
    expect(text).toContain("uh oh");

    // Rows removed after archiving.
    expect(mockPrisma.logEntry.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { gte: expect.any(Date), lt: expect.any(Date) } },
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      "LogArchive",
      "Archived 2 log entries for 2026-06-12",
    );
  });

  it("does not write but still cleans the DB when the archive already exists", async () => {
    mockPrisma.logEntry.findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-12T05:00:00Z"),
    });
    // fs.access resolves → archive exists.
    mockFs.access.mockResolvedValue(undefined);
    mockPrisma.logEntry.deleteMany.mockResolvedValue({ count: 3 });

    await archiveLogs();

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(mockPrisma.logEntry.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "LogArchive",
      "Cleaned 3 already-archived entries for 2026-06-12",
    );
  });

  it("skips writing a day with no log rows", async () => {
    mockPrisma.logEntry.findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-12T05:00:00Z"),
    });
    mockFs.access.mockRejectedValue(new Error("ENOENT"));
    mockPrisma.logEntry.findMany.mockResolvedValue([]);

    await archiveLogs();

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    // findMany returned empty → no delete for that day.
    expect(mockPrisma.logEntry.deleteMany).not.toHaveBeenCalled();
  });

  it("uses the default retention of 7 days when settings are missing", async () => {
    mockPrisma.appSettings.findFirst.mockResolvedValue(null);
    mockPrisma.logEntry.findFirst.mockResolvedValue(null);
    // Prune reads the directory.
    mockFs.readdir.mockResolvedValue([
      "logs-2020-01-01.tar.gz", // very old → should be pruned
      "logs-2026-06-13.tar.gz", // today → kept
      "not-an-archive.txt", // ignored
    ]);

    await archiveLogs();

    // Old archive pruned; recent one kept.
    expect(mockFs.unlink).toHaveBeenCalledWith(`${ARCHIVE_DIR}/logs-2020-01-01.tar.gz`);
    expect(mockFs.unlink).not.toHaveBeenCalledWith(`${ARCHIVE_DIR}/logs-2026-06-13.tar.gz`);
  });

  it("prunes nothing when the archive directory cannot be read", async () => {
    mockPrisma.logEntry.findFirst.mockResolvedValue(null);
    mockFs.readdir.mockRejectedValue(new Error("ENOENT"));

    await expect(archiveLogs()).resolves.toBeUndefined();
    expect(mockFs.unlink).not.toHaveBeenCalled();
  });
});
