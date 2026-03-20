import { describe, it, expect, vi, beforeEach } from "vitest";
import { gzipSync, gunzipSync } from "zlib";

// ---------------------------------------------------------------------------
// Mocks — must use vi.hoisted() since they're referenced in vi.mock() factories
// ---------------------------------------------------------------------------

const { mockPrismaModels, TABLE_NAMES, mockFs } = vi.hoisted(() => {
  const TABLE_NAMES = [
    "systemConfig", "user", "appSettings", "mediaServer", "library",
    "mediaItem", "mediaItemExternalId", "mediaStream", "syncJob",
    "sonarrInstance", "radarrInstance", "lidarrInstance", "seerrInstance",
    "ruleSet", "ruleMatch", "lifecycleAction", "lifecycleException",
    "watchHistory", "blackoutSchedule", "prerollPreset",
    "prerollSchedule", "savedQuery", "logEntry",
  ];

  const mockPrismaModels: Record<string, { findMany: ReturnType<typeof import("vitest")["vi"]["fn"]>; createMany: ReturnType<typeof import("vitest")["vi"]["fn"]> }> = {};
  for (const t of TABLE_NAMES) {
    mockPrismaModels[t] = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
  }

  const mockFs = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
  };

  return { mockPrismaModels, TABLE_NAMES, mockFs };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    ...Object.fromEntries(TABLE_NAMES.map((t: string) => [t, mockPrismaModels[t]])),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const txProxy = new Proxy({}, {
        get(_target, prop: string) {
          if (prop === "$executeRawUnsafe") return vi.fn().mockResolvedValue(undefined);
          const model = mockPrismaModels[prop];
          if (model) return model;
          return undefined;
        },
      });
      return fn(txProxy);
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("fs/promises", () => ({
  default: mockFs,
  ...mockFs,
}));

import {
  createBackup,
  listBackups,
  deleteBackup,
  getBackupFilePath,
  getBackupPassphrase,
  restoreBackup,
  pruneBackups,
} from "@/lib/backup/backup-service";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const t of TABLE_NAMES) {
      mockPrismaModels[t].findMany.mockResolvedValue([]);
    }
  });

  it("creates an unencrypted gzipped backup file", async () => {
    mockPrismaModels.user.findMany.mockResolvedValue([{ id: "u1", username: "admin" }]);

    const filename = await createBackup();

    expect(filename).toMatch(/^librariarr-backup-.*\.json\.gz$/);
    expect(mockFs.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    // Should write backup file + sidecar meta file
    expect(mockFs.writeFile).toHaveBeenCalledTimes(2);

    // Verify the backup content is valid gzip
    const backupCall = mockFs.writeFile.mock.calls[0];
    const buffer = backupCall[1] as Buffer;
    const decompressed = gunzipSync(buffer).toString("utf-8");
    const parsed = JSON.parse(decompressed);
    expect(parsed.metadata.version).toBe(1);
    expect(parsed.metadata.configOnly).toBe(true);
    expect(parsed.data.user).toEqual([{ id: "u1", username: "admin" }]);
  });

  it("creates an encrypted backup when passphrase is provided", async () => {
    const filename = await createBackup("my-secret-passphrase");

    expect(filename).toMatch(/\.json\.gz\.enc$/);
    expect(mockFs.writeFile).toHaveBeenCalledTimes(2);

    // Encrypted file should start with LBRENC01 magic bytes
    const backupCall = mockFs.writeFile.mock.calls[0];
    const buffer = backupCall[1] as Buffer;
    expect(buffer.subarray(0, 8).toString()).toBe("LBRENC01");
  });

  it("skips media-dependent tables in config-only mode (default)", async () => {
    await createBackup();

    // Media-dependent tables should NOT be queried
    expect(mockPrismaModels.mediaItem.findMany).not.toHaveBeenCalled();
    expect(mockPrismaModels.mediaStream.findMany).not.toHaveBeenCalled();
    expect(mockPrismaModels.syncJob.findMany).not.toHaveBeenCalled();
    expect(mockPrismaModels.logEntry.findMany).not.toHaveBeenCalled();
    expect(mockPrismaModels.ruleMatch.findMany).not.toHaveBeenCalled();
    expect(mockPrismaModels.lifecycleAction.findMany).not.toHaveBeenCalled();
    expect(mockPrismaModels.lifecycleException.findMany).not.toHaveBeenCalled();
    expect(mockPrismaModels.watchHistory.findMany).not.toHaveBeenCalled();

    // Config tables should be queried
    expect(mockPrismaModels.user.findMany).toHaveBeenCalled();
    expect(mockPrismaModels.appSettings.findMany).toHaveBeenCalled();
  });

  it("includes all tables when configOnly is false", async () => {
    await createBackup(undefined, false);

    expect(mockPrismaModels.mediaItem.findMany).toHaveBeenCalled();
    expect(mockPrismaModels.mediaStream.findMany).toHaveBeenCalled();
    expect(mockPrismaModels.syncJob.findMany).toHaveBeenCalled();
    expect(mockPrismaModels.logEntry.findMany).toHaveBeenCalled();
    expect(mockPrismaModels.ruleMatch.findMany).toHaveBeenCalled();
    expect(mockPrismaModels.lifecycleAction.findMany).toHaveBeenCalled();
    expect(mockPrismaModels.lifecycleException.findMany).toHaveBeenCalled();
    expect(mockPrismaModels.watchHistory.findMany).toHaveBeenCalled();
  });
});

describe("restoreBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid filenames", async () => {
    await expect(restoreBackup("../etc/passwd")).rejects.toThrow("Invalid backup filename");
    await expect(restoreBackup("evil; rm -rf /")).rejects.toThrow("Invalid backup filename");
  });

  it("requires passphrase for encrypted backups", async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from("fake"));

    await expect(restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz.enc")).rejects.toThrow(
      "encrypted",
    );
  });

  it("restores from an unencrypted gzipped backup", async () => {
    const backupData = {
      metadata: { version: 1, appVersion: "1.0.0", createdAt: new Date().toISOString(), tables: { user: 1 } },
      data: {
        user: [{ id: "u1", username: "admin", createdAt: "2024-01-01T00:00:00.000Z" }],
      },
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify(backupData)));
    mockFs.readFile.mockResolvedValue(compressed);

    const onProgress = vi.fn();

    await restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz", undefined, onProgress);

    // Should call progress for decrypt, truncate, restore, complete
    const phases = onProgress.mock.calls.map((c) => c[0].phase);
    expect(phases).toContain("decrypt");
    expect(phases).toContain("truncate");
    expect(phases).toContain("complete");

    // Should have attempted to create user records
    expect(mockPrismaModels.user.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ id: "u1", username: "admin" }),
        ]),
        skipDuplicates: true,
      }),
    );
  });

  it("rejects invalid backup structure", async () => {
    const compressed = gzipSync(Buffer.from(JSON.stringify({ invalid: true })));
    mockFs.readFile.mockResolvedValue(compressed);

    await expect(
      restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz"),
    ).rejects.toThrow("Invalid backup file structure");
  });
});

describe("listBackups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no files exist", async () => {
    mockFs.readdir.mockResolvedValue([]);
    const result = await listBackups();
    expect(result).toEqual([]);
  });

  it("filters out non-backup files", async () => {
    mockFs.readdir.mockResolvedValue(["readme.txt", "photo.jpg", ".gitkeep"]);
    const result = await listBackups();
    expect(result).toEqual([]);
  });

  it("reads sidecar metadata when available", async () => {
    mockFs.readdir.mockResolvedValue([
      "librariarr-backup-2024-01-01T00-00-00.json.gz",
      "librariarr-backup-2024-01-01T00-00-00.json.gz.meta.json",
    ]);
    mockFs.stat.mockResolvedValue({ size: 1024, mtime: new Date("2024-01-01") });
    mockFs.readFile.mockImplementation((filepath: string) => {
      if (filepath.endsWith(".meta.json")) {
        return Promise.resolve(
          JSON.stringify({ createdAt: "2024-01-01T00:00:00.000Z", tables: { user: 5 }, encrypted: false, configOnly: true }),
        );
      }
      return Promise.reject(new Error("should not read backup file"));
    });

    const result = await listBackups();
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("librariarr-backup-2024-01-01T00-00-00.json.gz");
    expect(result[0].size).toBe(1024);
    expect(result[0].encrypted).toBe(false);
    expect(result[0].configOnly).toBe(true);
    expect(result[0].tables).toEqual({ user: 5 });
  });

  it("returns basic info for encrypted files without sidecar", async () => {
    mockFs.readdir.mockResolvedValue(["librariarr-backup-2024-01-01T00-00-00.json.gz.enc"]);
    mockFs.stat.mockResolvedValue({ size: 2048, mtime: new Date("2024-01-01") });
    // No sidecar available
    mockFs.readFile.mockRejectedValue(new Error("not found"));

    const result = await listBackups();
    expect(result).toHaveLength(1);
    expect(result[0].encrypted).toBe(true);
    expect(result[0].tables).toEqual({});
  });

  it("sorts backups newest first", async () => {
    mockFs.readdir.mockResolvedValue([
      "librariarr-backup-2024-01-01T00-00-00.json.gz",
      "librariarr-backup-2024-06-15T12-00-00.json.gz",
    ]);
    mockFs.stat.mockResolvedValue({ size: 512, mtime: new Date() });
    mockFs.readFile.mockImplementation((filepath: string) => {
      if (filepath.includes("2024-01-01") && filepath.endsWith(".meta.json")) {
        return Promise.resolve(
          JSON.stringify({ createdAt: "2024-01-01T00:00:00.000Z", tables: {}, encrypted: false }),
        );
      }
      if (filepath.includes("2024-06-15") && filepath.endsWith(".meta.json")) {
        return Promise.resolve(
          JSON.stringify({ createdAt: "2024-06-15T12:00:00.000Z", tables: {}, encrypted: false }),
        );
      }
      return Promise.reject(new Error("not found"));
    });

    const result = await listBackups();
    expect(result).toHaveLength(2);
    expect(result[0].filename).toContain("2024-06-15");
    expect(result[1].filename).toContain("2024-01-01");
  });

  it("handles readdir failure gracefully", async () => {
    mockFs.readdir.mockRejectedValue(new Error("ENOENT"));
    const result = await listBackups();
    expect(result).toEqual([]);
  });
});

describe("deleteBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid filenames", async () => {
    await expect(deleteBackup("../../etc/shadow")).rejects.toThrow("Invalid backup filename");
  });

  it("returns true on successful deletion", async () => {
    mockFs.unlink.mockResolvedValue(undefined);
    const result = await deleteBackup("librariarr-backup-2024-01-01T00-00-00.json.gz");
    expect(result).toBe(true);
    // Should also attempt to delete sidecar
    expect(mockFs.unlink).toHaveBeenCalledTimes(2);
  });

  it("returns false when file does not exist", async () => {
    mockFs.unlink.mockRejectedValue(new Error("ENOENT"));
    const result = await deleteBackup("librariarr-backup-2024-01-01T00-00-00.json.gz");
    expect(result).toBe(false);
  });
});

describe("pruneBackups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not delete when under retention count", async () => {
    // listBackups returns empty
    mockFs.readdir.mockResolvedValue([]);
    const deleted = await pruneBackups(5);
    expect(deleted).toBe(0);
  });

  it("deletes oldest backups beyond retention count", async () => {
    // Set up 3 backups
    mockFs.readdir.mockResolvedValue([
      "librariarr-backup-2024-01-01T00-00-00.json.gz",
      "librariarr-backup-2024-02-01T00-00-00.json.gz",
      "librariarr-backup-2024-03-01T00-00-00.json.gz",
    ]);
    mockFs.stat.mockResolvedValue({ size: 100, mtime: new Date() });
    mockFs.readFile.mockImplementation((filepath: string) => {
      if (filepath.includes("2024-01-01") && filepath.endsWith(".meta.json")) {
        return Promise.resolve(JSON.stringify({ createdAt: "2024-01-01T00:00:00.000Z", tables: {}, encrypted: false }));
      }
      if (filepath.includes("2024-02-01") && filepath.endsWith(".meta.json")) {
        return Promise.resolve(JSON.stringify({ createdAt: "2024-02-01T00:00:00.000Z", tables: {}, encrypted: false }));
      }
      if (filepath.includes("2024-03-01") && filepath.endsWith(".meta.json")) {
        return Promise.resolve(JSON.stringify({ createdAt: "2024-03-01T00:00:00.000Z", tables: {}, encrypted: false }));
      }
      return Promise.reject(new Error("not found"));
    });
    mockFs.unlink.mockResolvedValue(undefined);

    // Keep only 1 — should delete 2 oldest
    const deleted = await pruneBackups(1);
    expect(deleted).toBe(2);
  });
});

describe("getBackupFilePath", () => {
  it("returns path for valid filename", () => {
    const result = getBackupFilePath("librariarr-backup-2024-01-01T00-00-00.json.gz");
    expect(result).toContain("librariarr-backup-2024-01-01T00-00-00.json.gz");
  });

  it("returns null for invalid filename", () => {
    expect(getBackupFilePath("../../etc/passwd")).toBeNull();
    expect(getBackupFilePath("malicious.sh")).toBeNull();
  });

  it("accepts encrypted backup filenames", () => {
    const result = getBackupFilePath("librariarr-backup-2024-01-01T00-00-00.json.gz.enc");
    expect(result).not.toBeNull();
  });
});

describe("getBackupPassphrase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns passphrase from settings", async () => {
    mockPrismaModels.appSettings.findMany.mockImplementation(() => {
      throw new Error("should not call findMany");
    });
    // getBackupPassphrase uses findFirst
    const { prisma } = await import("@/lib/db");
    (prisma as unknown as Record<string, unknown>).appSettings = {
      ...mockPrismaModels.appSettings,
      findFirst: vi.fn().mockResolvedValue({ backupEncryptionPassword: "secret123" }),
    };

    const result = await getBackupPassphrase();
    expect(result).toBe("secret123");
  });

  it("returns undefined when no settings exist", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma as unknown as Record<string, unknown>).appSettings = {
      ...mockPrismaModels.appSettings,
      findFirst: vi.fn().mockResolvedValue(null),
    };

    const result = await getBackupPassphrase();
    expect(result).toBeUndefined();
  });
});
