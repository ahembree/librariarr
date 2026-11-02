import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { gzipSync } from "zlib";

// Real files in a throwaway directory (never /config): BACKUP_DIR is read when
// the module loads, so it is set before the import below.
const { backupDir, models, executeRaw } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("path") as typeof import("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("os") as typeof import("os");
  const base = process.env.CLAUDE_SCRATCH_DIR || nodeOs.tmpdir();
  const dir = nodeFs.mkdtempSync(nodePath.join(base, "librariarr-backup-test-"));
  process.env.BACKUP_DIR = dir;
  const models: Record<string, { findMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> }> = {};
  return { backupDir: dir, models, executeRaw: vi.fn() };
});

function model(name: string) {
  models[name] ??= {
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    aggregate: vi.fn().mockResolvedValue({ _max: { sessionVersion: null } }),
  };
  return models[name];
}

vi.mock("@/lib/db", () => {
  const get = (_t: object, prop: string) => {
    if (prop === "$executeRawUnsafe") return executeRaw;
    if (prop === "$transaction") return async (fn: (tx: unknown) => Promise<void>) => fn(new Proxy({}, { get }));
    return model(prop);
  };
  return { prisma: new Proxy({}, { get }) };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { invalidate } = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("@/lib/media/watch-evidence", () => ({ invalidateServersWithoutWatchHistory: invalidate }));

import { logger } from "@/lib/logger";
import { createBackup, restoreBackup, listBackups, pruneBackups, deleteBackup } from "@/lib/backup/backup-service";

function clearDir() {
  for (const entry of fs.readdirSync(backupDir)) fs.rmSync(path.join(backupDir, entry), { recursive: true, force: true });
}

beforeEach(() => {
  clearDir();
  vi.clearAllMocks();
  for (const m of Object.values(models)) {
    m.findMany.mockResolvedValue([]);
    m.createMany.mockResolvedValue({ count: 0 });
    m.aggregate.mockResolvedValue({ _max: { sessionVersion: null } });
  }
  executeRaw.mockResolvedValue(undefined);
  invalidate.mockResolvedValue(0);
});

afterAll(() => {
  fs.rmSync(backupDir, { recursive: true, force: true });
});

function writeBackup(name: string, content: Buffer | string) {
  fs.writeFileSync(path.join(backupDir, name), content);
}

const backupJson = (data: Record<string, unknown[]>, metadata: Record<string, unknown> = { createdAt: "2024-05-01T00:00:00.000Z", tables: { systemConfig: 1 } }) =>
  JSON.stringify({ metadata: { version: 1, appVersion: "t", ...metadata }, data });

describe("encrypted backups round-trip through real AES-GCM", () => {
  it("restores what it encrypted with the right passphrase, and rejects a wrong one", async () => {
    model("systemConfig").findMany.mockResolvedValue([{ id: "singleton", plexClientId: "client-1", setupCompleted: true }]);
    const filename = await createBackup("correct horse");
    expect(filename).toMatch(/\.json\.gz\.enc$/);
    const raw = fs.readFileSync(path.join(backupDir, filename));
    expect(raw.subarray(0, 8).toString()).toBe("LBRENC01");

    await expect(restoreBackup(filename, "wrong")).rejects.toThrow("Decryption failed — wrong passphrase or corrupted backup");
    expect(model("systemConfig").createMany).not.toHaveBeenCalled();

    const progress = vi.fn();
    invalidate.mockResolvedValue(2);
    await restoreBackup(filename, "correct horse", progress);
    expect(model("systemConfig").createMany).toHaveBeenCalledWith({
      data: [{ id: "singleton", plexClientId: "client-1", setupCompleted: true }],
      skipDuplicates: true,
    });
    expect(progress.mock.calls.at(-1)?.[0]).toEqual({ phase: "complete", message: "Restore completed" });
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith("Backup", expect.stringMatching(/^Marked 2 media server\(s\)/));
  });

  it("refuses a file too short to be encrypted, or one without the magic header", async () => {
    writeBackup("librariarr-backup-short.json.gz.enc", Buffer.from("tiny"));
    await expect(restoreBackup("librariarr-backup-short.json.gz.enc", "p")).rejects.toThrow("Invalid encrypted backup file");

    writeBackup("librariarr-backup-nomagic.json.gz.enc", Buffer.alloc(100, 1));
    await expect(restoreBackup("librariarr-backup-nomagic.json.gz.enc", "p")).rejects.toThrow("Not an encrypted backup file");
  });
});

describe("restoreBackup file formats and failures", () => {
  it("restores a plain .json backup a hundred rows at a time", async () => {
    const logs = Array.from({ length: 1001 }, (_, i) => ({ id: `l${i}` }));
    writeBackup("librariarr-backup-plain.json", backupJson({ logEntry: logs }));
    await restoreBackup("librariarr-backup-plain.json");
    // 1001 rows go in batches of 100, in order.
    const calls = model("logEntry").createMany.mock.calls as Array<[{ data: Array<{ id: string }> }]>;
    expect(calls).toHaveLength(11);
    expect(calls.map(([arg]) => arg.data.length)).toEqual([...Array(10).fill(100), 1]);
    expect(calls[10][0].data).toEqual([{ id: "l1000" }]);
  });

  it("names the table that failed and rolls the restore back", async () => {
    writeBackup("librariarr-backup-bad.json.gz", gzipSync(backupJson({ systemConfig: [{ id: "x" }] })));
    model("systemConfig").createMany.mockRejectedValueOnce(new Error("duplicate key"));
    await expect(restoreBackup("librariarr-backup-bad.json.gz")).rejects.toThrow("Failed to restore table systemConfig: duplicate key");

    model("systemConfig").createMany.mockRejectedValueOnce("weird");
    await expect(restoreBackup("librariarr-backup-bad.json.gz")).rejects.toThrow("Failed to restore table systemConfig: weird");
    expect(invalidate).not.toHaveBeenCalled();
  });

  // A failed TRUNCATE aborts the Postgres transaction: carrying on only made
  // the next statement fail with "current transaction is aborted", naming a
  // later table instead of the cause.
  it("fails with the TRUNCATE's own error, inserting nothing", async () => {
    writeBackup("librariarr-backup-ok.json", backupJson({ systemConfig: [{ id: "x" }] }));
    executeRaw.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error("permission denied for table Foo"));
    await expect(restoreBackup("librariarr-backup-ok.json")).rejects.toThrow(
      /^Failed to clear table \w+: permission denied for table Foo$/,
    );
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(model("systemConfig").createMany).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("listBackups without sidecars", () => {
  it("reads gzipped and plain legacy files, writes a sidecar, and skips unreadable ones", async () => {
    writeBackup("librariarr-backup-a.json.gz", gzipSync(backupJson({}, { createdAt: "2024-01-01T00:00:00.000Z", tables: { user: 1 }, configOnly: true })));
    writeBackup("librariarr-backup-b.json", backupJson({}, {}));
    writeBackup("librariarr-backup-c.json", "{not json");
    writeBackup("librariarr-backup-d.json.gz.meta.json", "{}");

    const list = await listBackups();
    const byName = Object.fromEntries(list.map((b) => [b.filename, b]));
    expect(Object.keys(byName).sort()).toEqual(["librariarr-backup-a.json.gz", "librariarr-backup-b.json"]);
    expect(byName["librariarr-backup-a.json.gz"]).toMatchObject({
      createdAt: "2024-01-01T00:00:00.000Z",
      tables: { user: 1 },
      encrypted: false,
      configOnly: true,
    });
    // No metadata in the file: falls back to the file's mtime and no tables.
    expect(byName["librariarr-backup-b.json"].tables).toEqual({});
    expect(byName["librariarr-backup-b.json"].createdAt).toBe(
      fs.statSync(path.join(backupDir, "librariarr-backup-b.json")).mtime.toISOString(),
    );

    const sidecar = JSON.parse(fs.readFileSync(path.join(backupDir, "librariarr-backup-a.json.gz.meta.json"), "utf-8"));
    expect(sidecar).toEqual({ createdAt: "2024-01-01T00:00:00.000Z", tables: { user: 1 }, encrypted: false, configOnly: true });
  });

  it("infers encryption from the filename when a sidecar omits it", async () => {
    writeBackup("librariarr-backup-e.json.gz.enc", Buffer.alloc(80));
    writeBackup("librariarr-backup-e.json.gz.enc.meta.json", JSON.stringify({ createdAt: "2024-02-02T00:00:00.000Z", tables: {} }));
    const [entry] = await listBackups();
    expect(entry).toMatchObject({ filename: "librariarr-backup-e.json.gz.enc", encrypted: true });
  });
});

describe("pruneBackups", () => {
  it("counts only the backups it actually deleted", async () => {
    // A directory with a backup's name lists as an encrypted backup but cannot be unlinked.
    fs.mkdirSync(path.join(backupDir, "librariarr-backup-0-old.json.gz.enc"));
    writeBackup("librariarr-backup-0-old.json.gz.enc.meta.json", JSON.stringify({ createdAt: "2020-01-01T00:00:00.000Z", tables: {} }));
    writeBackup("librariarr-backup-new.json.gz", gzipSync(backupJson({})));
    writeBackup("librariarr-backup-new.json.gz.meta.json", JSON.stringify({ createdAt: "2030-01-01T00:00:00.000Z", tables: {} }));

    expect(await pruneBackups(1)).toBe(0);
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith("Backup", expect.stringMatching(/^Pruned/));
    expect(await deleteBackup("librariarr-backup-new.json.gz")).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "librariarr-backup-new.json.gz.meta.json"))).toBe(false);
  });
});

describe("createBackup on disk", () => {
  it("writes an owner-only file and a sidecar describing it", async () => {
    const filename = await createBackup(undefined, false);
    const stat = fs.statSync(path.join(backupDir, filename));
    expect(stat.mode & 0o777).toBe(0o600);
    const meta = JSON.parse(fs.readFileSync(path.join(backupDir, `${filename}.meta.json`), "utf-8"));
    expect(meta).toMatchObject({ encrypted: false, configOnly: false });
    // Every table is read for a full backup; the mocked database holds none of them.
    expect(Object.values(meta.tables as Record<string, number>).every((n) => n === 0)).toBe(true);
    expect(Object.keys(meta.tables)).toContain("mediaItem");
  });
});
