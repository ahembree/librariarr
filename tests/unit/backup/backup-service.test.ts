import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { gzipSync, gunzipSync } from "zlib";

// ---------------------------------------------------------------------------
// Mocks — must use vi.hoisted() since they're referenced in vi.mock() factories
// ---------------------------------------------------------------------------

const { mockPrismaModels, TABLE_NAMES, mockFs } = vi.hoisted(() => {
  const TABLE_NAMES = [
    "systemConfig", "user", "appSettings", "mediaServer", "library",
    "mediaItem", "mediaItemExternalId", "mediaStream", "syncJob",
    "sonarrInstance", "radarrInstance", "lidarrInstance", "seerrInstance",
    "tracearrInstance", "trashManagedResource", "collection",
    "ruleSet", "ruleMatch", "lifecycleAction", "lifecycleException",
    "watchHistory", "blackoutSchedule", "prerollPreset",
    "prerollSchedule", "savedQuery", "logEntry",
  ];

  type MockFn = ReturnType<typeof import("vitest")["vi"]["fn"]>;
  const mockPrismaModels: Record<string, { findMany: MockFn; createMany: MockFn; aggregate: MockFn }> = {};
  for (const t of TABLE_NAMES) {
    mockPrismaModels[t] = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      // Restore reads the highest session version in use before truncating.
      aggregate: vi.fn().mockResolvedValue({ _max: { sessionVersion: null } }),
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

  it("fails, writing no file, when a table cannot be read", async () => {
    // A read error used to be stored as an empty table: the file was reported
    // as a good backup, and restoring it emptied that table.
    mockPrismaModels.appSettings.findMany.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    await expect(createBackup()).rejects.toThrow("Connection terminated unexpectedly");
    expect(mockFs.writeFile).not.toHaveBeenCalled();
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

  it("preserves SSO fields on User and AppSettings in the exported payload", async () => {
    // Regression guard: SSO config lives in plain columns on User + AppSettings,
    // so backups must capture them. If someone later switches to a column-filtering
    // select(), this test fails and forces an explicit decision.
    mockPrismaModels.user.findMany.mockResolvedValue([
      {
        id: "u1",
        username: "admin",
        ssoSubject: "ak-abc123",
        ssoProvider: "Authentik",
        ssoEnabled: true,
      },
    ]);
    mockPrismaModels.appSettings.findMany.mockResolvedValue([
      {
        id: "s1",
        userId: "u1",
        ssoEnabled: true,
        ssoMode: "OIDC",
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "client-xyz",
        oidcClientSecret: "super-secret",
        oidcScopes: "openid profile email",
        oidcUsernameClaim: "preferred_username",
        forwardAuthUserHeader: "Remote-User",
        forwardAuthEmailHeader: "Remote-Email",
        forwardAuthNameHeader: "Remote-Name",
      },
    ]);

    await createBackup();

    const buffer = mockFs.writeFile.mock.calls[0][1] as Buffer;
    const parsed = JSON.parse(gunzipSync(buffer).toString("utf-8"));

    expect(parsed.data.user[0]).toMatchObject({
      ssoSubject: "ak-abc123",
      ssoProvider: "Authentik",
      ssoEnabled: true,
    });
    expect(parsed.data.appSettings[0]).toMatchObject({
      ssoEnabled: true,
      ssoMode: "OIDC",
      oidcIssuer: "https://idp.example.com",
      oidcClientId: "client-xyz",
      oidcClientSecret: "super-secret",
      oidcScopes: "openid profile email",
      oidcUsernameClaim: "preferred_username",
      forwardAuthUserHeader: "Remote-User",
      forwardAuthEmailHeader: "Remote-Email",
      forwardAuthNameHeader: "Remote-Name",
    });
  });
});

describe("restoreBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops columns the current schema no longer has", async () => {
    // Migration 0010 dropped six collection* columns from RuleSet. Prisma
    // validates createMany arguments client-side, so a single unknown key
    // rejects the whole batch and aborts the restore — without this filter a
    // config backup taken before that released migration is permanently
    // unrestorable.
    const backupData = {
      metadata: { version: 1, appVersion: "1.0.0", createdAt: new Date().toISOString(), tables: { ruleSet: 1 } },
      data: {
        ruleSet: [{
          id: "rs1", userId: "u1", name: "Old rule", type: "MOVIE", rules: {},
          collectionEnabled: true, collectionName: "Leaving Soon", collectionSort: "ACTION_DATE",
        }],
      },
    };
    mockFs.readFile.mockResolvedValue(gzipSync(Buffer.from(JSON.stringify(backupData))));

    await restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz");

    const call = mockPrismaModels.ruleSet.createMany.mock.calls.at(-1);
    expect(call).toBeDefined();
    const row = call![0].data[0];
    expect(row).not.toHaveProperty("collectionEnabled");
    expect(row).not.toHaveProperty("collectionName");
    expect(row).not.toHaveProperty("collectionSort");
    // Fields the schema still has must survive untouched.
    expect(row).toMatchObject({ id: "rs1", userId: "u1", name: "Old rule" });
  });

  it("keeps every column the current schema still has", async () => {
    const backupData = {
      metadata: { version: 1, appVersion: "1.0.0", createdAt: new Date().toISOString(), tables: { user: 1 } },
      data: { user: [{ id: "u1", username: "admin", createdAt: "2024-01-01T00:00:00.000Z" }] },
    };
    mockFs.readFile.mockResolvedValue(gzipSync(Buffer.from(JSON.stringify(backupData))));

    await restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz");

    const row = mockPrismaModels.user.createMany.mock.calls.at(-1)![0].data[0];
    expect(row).toMatchObject({ id: "u1", username: "admin" });
    // Passed on as written: Prisma's DateTime input takes the ISO string, and
    // only a DateTime field reads it as a date.
    expect(row.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("never turns a value into a Date by its shape", async () => {
    // A String column whose whole value is a timestamp used to come back as a
    // Date, and Prisma refused the batch — the backup could not be restored.
    const backupData = {
      metadata: { version: 1, appVersion: "1.0.0", createdAt: new Date().toISOString(), tables: { ruleSet: 1 } },
      data: { ruleSet: [{ id: "rs1", userId: "u1", name: "2024-01-01T00:00:00Z", type: "MOVIE", rules: {} }] },
    };
    mockFs.readFile.mockResolvedValue(gzipSync(Buffer.from(JSON.stringify(backupData))));

    await restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz");

    const row = mockPrismaModels.ruleSet.createMany.mock.calls.at(-1)![0].data[0];
    expect(row.name).toBe("2024-01-01T00:00:00Z");
  });

  it("gives restored users a session version above the file's and the one in use", async () => {
    // Restoring the file's version verbatim moved it back, and every cookie
    // sealed at that value — revoked since — was honoured again.
    mockPrismaModels.user.aggregate.mockResolvedValueOnce({ _max: { sessionVersion: 7 } });
    const backupData = {
      metadata: { version: 1, appVersion: "1.0.0", createdAt: new Date().toISOString(), tables: { user: 2 } },
      data: {
        user: [
          { id: "u1", username: "admin", sessionVersion: 3 },
          { id: "u2", username: "later", sessionVersion: 12 },
        ],
      },
    };
    mockFs.readFile.mockResolvedValue(gzipSync(Buffer.from(JSON.stringify(backupData))));
    // Five seconds past the floor's epoch: the floor (5) is below both.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-01-01T00:00:05Z"));
    try {
      await restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz");
    } finally {
      vi.useRealTimers();
    }

    const rows = mockPrismaModels.user.createMany.mock.calls.at(-1)![0].data;
    expect(rows.map((r: { sessionVersion: number }) => r.sessionVersion)).toEqual([8, 13]);
  });

  it("puts a setup-time restore past every version issued before it", async () => {
    // No user row is left, so the version in use reads 0; the seconds since
    // 2024 stand in for it, which no version issued earlier can reach.
    mockPrismaModels.user.aggregate.mockResolvedValueOnce({ _max: { sessionVersion: null } });
    const backupData = {
      metadata: { version: 1, appVersion: "1.0.0", createdAt: new Date().toISOString(), tables: { user: 1 } },
      data: { user: [{ id: "u1", username: "admin", sessionVersion: 3 }] },
    };
    mockFs.readFile.mockResolvedValue(gzipSync(Buffer.from(JSON.stringify(backupData))));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      await restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz");
    } finally {
      vi.useRealTimers();
    }

    const rows = mockPrismaModels.user.createMany.mock.calls.at(-1)![0].data;
    const secondsSince2024 = (Date.UTC(2026, 0, 1) - Date.UTC(2024, 0, 1)) / 1000;
    expect(rows[0].sessionVersion).toBe(secondsSince2024 + 1);
    expect(rows[0].sessionVersion).toBeLessThan(2 ** 31);
  });

  it("rejects invalid filenames", async () => {
    await expect(restoreBackup("../etc/passwd")).rejects.toThrow("Invalid backup filename");
    await expect(restoreBackup("evil; rm -rf /")).rejects.toThrow("Invalid backup filename");
  });

  it("requires passphrase for encrypted backups", async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from("fake"));

    await expect(restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz.enc")).rejects.toThrow(
      "This backup is encrypted — a passphrase is required to restore it",
    );
    // Refused before the file is even read.
    expect(mockFs.readFile).not.toHaveBeenCalled();
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

    // decrypt, truncate, then the one table's start and its single batch, then complete
    const phases = onProgress.mock.calls.map((c) => c[0].phase);
    expect(phases).toEqual(["decrypt", "truncate", "restore", "restore", "complete"]);
    expect(onProgress.mock.calls[3][0]).toMatchObject({
      table: "user",
      rowsInserted: 1,
      totalRows: 1,
      message: "Restoring user (1/1)...",
    });

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

  it("restores SSO fields on User and AppSettings", async () => {
    const backupData = {
      metadata: {
        version: 1,
        appVersion: "1.0.0",
        createdAt: new Date().toISOString(),
        tables: { user: 1, appSettings: 1 },
      },
      data: {
        user: [
          {
            id: "u1",
            username: "admin",
            ssoSubject: "ak-abc123",
            ssoProvider: "Authentik",
            ssoEnabled: true,
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ],
        appSettings: [
          {
            id: "s1",
            userId: "u1",
            ssoEnabled: true,
            ssoMode: "OIDC",
            oidcIssuer: "https://idp.example.com",
            oidcClientId: "client-xyz",
            oidcClientSecret: "super-secret",
            oidcScopes: "openid profile email",
            oidcUsernameClaim: "preferred_username",
            forwardAuthUserHeader: "Remote-User",
            forwardAuthEmailHeader: "Remote-Email",
            forwardAuthNameHeader: "Remote-Name",
          },
        ],
      },
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify(backupData)));
    mockFs.readFile.mockResolvedValue(compressed);

    await restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz");

    expect(mockPrismaModels.user.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            ssoSubject: "ak-abc123",
            ssoProvider: "Authentik",
            ssoEnabled: true,
          }),
        ]),
      }),
    );
    expect(mockPrismaModels.appSettings.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            ssoEnabled: true,
            ssoMode: "OIDC",
            oidcIssuer: "https://idp.example.com",
            oidcClientId: "client-xyz",
            oidcClientSecret: "super-secret",
            oidcUsernameClaim: "preferred_username",
            forwardAuthUserHeader: "Remote-User",
          }),
        ]),
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

  it("renames legacy searchAfterDelete to searchAfterAction on restore", async () => {
    // Backups taken before migration 0008 use `searchAfterDelete`. Without
    // the per-table key rename, Prisma createMany would reject the legacy
    // field and break disaster recovery for upgrading users.
    const backupData = {
      metadata: {
        version: 1,
        appVersion: "1.0.0",
        createdAt: new Date().toISOString(),
        tables: { ruleSet: 1, lifecycleAction: 1 },
      },
      data: {
        ruleSet: [
          {
            id: "rs1",
            name: "Old Rule",
            type: "MOVIE",
            searchAfterDelete: true,
          },
        ],
        lifecycleAction: [
          {
            id: "la1",
            ruleSetId: "rs1",
            actionType: "UNMONITOR_DELETE_FILES_RADARR",
            searchAfterDelete: true,
          },
        ],
      },
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify(backupData)));
    mockFs.readFile.mockResolvedValue(compressed);

    await restoreBackup("librariarr-backup-2024-01-01T00-00-00.json.gz");

    expect(mockPrismaModels.ruleSet.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ id: "rs1", searchAfterAction: true }),
        ]),
      }),
    );
    const ruleSetCall = mockPrismaModels.ruleSet.createMany.mock.calls[0][0];
    expect(ruleSetCall.data[0]).not.toHaveProperty("searchAfterDelete");

    expect(mockPrismaModels.lifecycleAction.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ id: "la1", searchAfterAction: true }),
        ]),
      }),
    );
    const actionCall = mockPrismaModels.lifecycleAction.createMany.mock.calls[0][0];
    expect(actionCall.data[0]).not.toHaveProperty("searchAfterDelete");
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
    expect(result).toEqual([
      {
        filename: "librariarr-backup-2024-01-01T00-00-00.json.gz.enc",
        // Unreadable without the passphrase: dated by the file itself.
        createdAt: new Date("2024-01-01").toISOString(),
        size: 2048,
        tables: {},
        encrypted: true,
        configOnly: undefined,
      },
    ]);
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
    expect(result.map((b) => b.filename)).toEqual([
      "librariarr-backup-2024-06-15T12-00-00.json.gz",
      "librariarr-backup-2024-01-01T00-00-00.json.gz",
    ]);
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
    // Each pruned backup goes with its sidecar; the newest is kept.
    const unlinked = mockFs.unlink.mock.calls.map(([p]) => path.basename(p as string)).sort();
    expect(unlinked).toEqual([
      "librariarr-backup-2024-01-01T00-00-00.json.gz",
      "librariarr-backup-2024-01-01T00-00-00.json.gz.meta.json",
      "librariarr-backup-2024-02-01T00-00-00.json.gz",
      "librariarr-backup-2024-02-01T00-00-00.json.gz.meta.json",
    ]);
  });
});

describe("getBackupFilePath", () => {
  it("returns path for valid filename", () => {
    const result = getBackupFilePath("librariarr-backup-2024-01-01T00-00-00.json.gz");
    expect(result).toBe(
      path.join(process.env.BACKUP_DIR || "/config/backups", "librariarr-backup-2024-01-01T00-00-00.json.gz"),
    );
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
  let original: unknown;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { prisma } = await import("@/lib/db");
    original = (prisma as unknown as Record<string, unknown>).appSettings;
  });

  // The tests swap the delegate for one with `findFirst`; put it back so no
  // other test sees it.
  afterEach(async () => {
    const { prisma } = await import("@/lib/db");
    (prisma as unknown as Record<string, unknown>).appSettings = original;
    mockPrismaModels.appSettings.findMany.mockReset();
    mockPrismaModels.appSettings.findMany.mockResolvedValue([]);
  });

  it("returns passphrase from settings", async () => {
    mockPrismaModels.appSettings.findMany.mockImplementation(() => {
      throw new Error("should not call findMany");
    });
    // getBackupPassphrase uses findFirst
    const { prisma } = await import("@/lib/db");
    (prisma as unknown as Record<string, unknown>).appSettings = {
      ...mockPrismaModels.appSettings,
      // file deepcode ignore NoHardcodedPasswords/test: test file
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
