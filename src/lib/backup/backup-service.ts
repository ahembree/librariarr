import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import fs from "fs/promises";
import path from "path";
import { gzipSync, gunzipSync } from "zlib";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "crypto";

const BACKUP_DIR = process.env.BACKUP_DIR || "/config/backups";
const FILENAME_REGEX = /^librariarr-backup-[\w.-]+\.json(\.gz(\.enc)?)?$/;

// Encryption constants
const ENC_MAGIC = Buffer.from("LBRENC01"); // 8-byte magic header
const SALT_LEN = 32;
const IV_LEN = 12; // AES-256-GCM nonce
const TAG_LEN = 16; // GCM auth tag

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32) as Buffer;
}

function encryptBuffer(data: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENC_MAGIC, salt, iv, tag, encrypted]);
}

function decryptBuffer(data: Buffer, passphrase: string): Buffer {
  if (data.length < ENC_MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error("Invalid encrypted backup file");
  }
  const magic = data.subarray(0, ENC_MAGIC.length);
  if (!magic.equals(ENC_MAGIC)) {
    throw new Error("Not an encrypted backup file");
  }
  let offset = ENC_MAGIC.length;
  const salt = data.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;
  const iv = data.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const tag = data.subarray(offset, offset + TAG_LEN);
  offset += TAG_LEN;
  const encrypted = data.subarray(offset);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("Decryption failed — wrong passphrase or corrupted backup");
  }
}

export interface BackupMetadata {
  version: number;
  appVersion: string;
  createdAt: string;
  tables: Record<string, number>;
  configOnly?: boolean;
}

export interface BackupInfo {
  filename: string;
  createdAt: string;
  size: number;
  tables: Record<string, number>;
  encrypted: boolean;
  configOnly?: boolean;
}

// Custom JSON replacer/reviver for BigInt serialization
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __bigint__: value.toString() };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__bigint__" in (value as Record<string, unknown>)) {
    return BigInt((value as { __bigint__: string }).__bigint__);
  }
  return value;
}

// Table export/import order respecting FK dependencies
const TABLE_ORDER = [
  "systemConfig",
  "user",
  "appSettings",
  "mediaServer",
  "library",
  "mediaItem",
  "mediaItemExternalId",
  "mediaStream",
  "syncJob",
  "sonarrInstance",
  "radarrInstance",
  "lidarrInstance",
  "seerrInstance",
  "ruleSet",
  "ruleMatch",
  "lifecycleAction",
  "lifecycleException",
  "watchHistory",
  "blackoutSchedule",
  "prerollPreset",
  "prerollSchedule",
  "savedQuery",
  "logEntry",
] as const;

// Tables that depend on mediaItem or are populated by sync — excluded from config-only backups
const MEDIA_DEPENDENT_TABLES = new Set([
  "mediaItem", "mediaItemExternalId", "mediaStream", "syncJob",
  "ruleMatch", "lifecycleAction", "lifecycleException", "watchHistory",
  "logEntry",
]);

async function ensureBackupDir(): Promise<void> {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

/**
 * Returns the saved backup encryption password from settings, or undefined if none is set.
 */
export async function getBackupPassphrase(): Promise<string | undefined> {
  const settings = await prisma.appSettings.findFirst({
    select: { backupEncryptionPassword: true },
  });
  return settings?.backupEncryptionPassword ?? undefined;
}

export async function createBackup(passphrase?: string, configOnly = true): Promise<string> {
  await ensureBackupDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const encrypted = !!passphrase;
  const filename = `librariarr-backup-${timestamp}.json.gz${encrypted ? ".enc" : ""}`;
  const filepath = path.join(BACKUP_DIR, filename);

  const data: Record<string, unknown[]> = {};
  const tables: Record<string, number> = {};

  for (const table of TABLE_ORDER) {
    if (configOnly && MEDIA_DEPENDENT_TABLES.has(table)) {
      data[table] = [];
      tables[table] = 0;
      continue;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (prisma as any)[table].findMany();
      data[table] = rows;
      tables[table] = rows.length;
    } catch {
      // Table may not exist in some schema versions
      data[table] = [];
      tables[table] = 0;
    }
  }

  const metadata: BackupMetadata = {
    version: 1,
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
    createdAt: new Date().toISOString(),
    tables,
    configOnly,
  };

  const backup = { metadata, data };
  const json = JSON.stringify(backup, replacer, 2);
  const compressed = gzipSync(Buffer.from(json, "utf-8"));

  const output = encrypted ? encryptBuffer(compressed, passphrase!) : compressed;
  await fs.writeFile(filepath, output);

  // Write sidecar metadata file so listBackups() doesn't need to decompress
  const metaPath = filepath + ".meta.json";
  await fs.writeFile(metaPath, JSON.stringify({ createdAt: metadata.createdAt, tables, encrypted, configOnly }));

  const label = [encrypted ? "(encrypted)" : "", configOnly ? "(config only)" : ""].filter(Boolean).join(" ");
  logger.info("Backup", `Backup created: ${filename}${label ? " " + label : ""} (${Object.values(tables).reduce((a, b) => a + b, 0)} total rows)`);

  return filename;
}

export interface RestoreProgress {
  phase: "decrypt" | "truncate" | "restore" | "complete";
  message: string;
  table?: string;
  tableIndex?: number;
  tableCount?: number;
  rowsInserted?: number;
  totalRows?: number;
}

export async function restoreBackup(
  filename: string,
  passphrase?: string,
  onProgress?: (progress: RestoreProgress) => void,
): Promise<void> {
  if (!FILENAME_REGEX.test(filename)) {
    throw new Error("Invalid backup filename");
  }

  const filepath = path.join(BACKUP_DIR, filename);
  const BATCH_SIZE = 100;
  const tableCount = TABLE_ORDER.length;

  // Step 1: Read, decrypt, decompress — free intermediate buffers to reduce peak memory
  onProgress?.({ phase: "decrypt", message: "Reading and decompressing backup..." });
  let raw: string;
  if (filename.endsWith(".enc")) {
    if (!passphrase) {
      throw new Error("This backup is encrypted — a passphrase is required to restore it");
    }
    // Block-scope so fileData can be GC'd after decrypt
    const compressed = await (async () => {
      const fileData = await fs.readFile(filepath);
      return decryptBuffer(fileData, passphrase);
    })();
    raw = gunzipSync(compressed).toString("utf-8");
  } else if (filename.endsWith(".gz")) {
    const compressed = await fs.readFile(filepath);
    raw = gunzipSync(compressed).toString("utf-8");
  } else {
    raw = await fs.readFile(filepath, "utf-8");
  }

  // Parse then immediately release the raw string to reduce peak memory
  const backup = JSON.parse(raw, reviver) as {
    metadata: BackupMetadata;
    data: Record<string, unknown[]>;
  };
  raw = "";
  global.gc?.();

  if (!backup.metadata || !backup.data) {
    throw new Error("Invalid backup file structure");
  }

  logger.info("Backup", `Restoring from backup: ${filename}`);

  // Wrap truncate + insert in a transaction so a mid-restore failure rolls back cleanly
  await prisma.$transaction(async (tx) => {
    // Step 2: Truncate all tables in reverse dependency order
    onProgress?.({ phase: "truncate", message: "Clearing existing data..." });
    const reversedTables = [...TABLE_ORDER].reverse();
    for (const table of reversedTables) {
      try {
        await tx.$executeRawUnsafe(`TRUNCATE TABLE "${tableToDbName(table)}" CASCADE`);
      } catch {
        // Table may not exist
      }
    }

    // Step 3: Re-insert data in dependency order, freeing each table after processing
    for (let tableIdx = 0; tableIdx < TABLE_ORDER.length; tableIdx++) {
      const table = TABLE_ORDER[tableIdx];
      const rows = backup.data[table];
      delete backup.data[table]; // Allow GC of previous tables' data
      if (!rows || rows.length === 0) continue;

      onProgress?.({
        phase: "restore",
        message: `Restoring ${table} (${rows.length} rows)...`,
        table,
        tableIndex: tableIdx,
        tableCount,
        rowsInserted: 0,
        totalRows: rows.length,
      });

      try {
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (tx as any)[table].createMany({
            data: batch.map((row) => deserializeRow(row as Record<string, unknown>)),
            skipDuplicates: true,
          });

          const inserted = Math.min(i + BATCH_SIZE, rows.length);
          onProgress?.({
            phase: "restore",
            message: `Restoring ${table} (${inserted}/${rows.length})...`,
            table,
            tableIndex: tableIdx,
            tableCount,
            rowsInserted: inserted,
            totalRows: rows.length,
          });
        }
      } catch (error) {
        logger.error("Backup", `Failed to restore table ${table}`, { error: String(error) });
        throw new Error(`Failed to restore table ${table}: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Force GC after large tables to reclaim row arrays
      if (rows.length > 1000) global.gc?.();
    }
  }, { timeout: 300000 }); // 5 min timeout for large restores

  onProgress?.({ phase: "complete", message: "Restore completed" });
  logger.info("Backup", `Restore completed from ${filename}`);
}

export async function listBackups(): Promise<BackupInfo[]> {
  await ensureBackupDir();

  let files: string[];
  try {
    files = await fs.readdir(BACKUP_DIR);
  } catch {
    return [];
  }

  const backupFiles = files.filter((f) => FILENAME_REGEX.test(f) && !f.endsWith(".meta.json"));

  const backups = await Promise.all(
    backupFiles.map(async (file): Promise<BackupInfo | null> => {
      try {
        const filepath = path.join(BACKUP_DIR, file);
        const metaPath = filepath + ".meta.json";

        const stat = await fs.stat(filepath);

        // Try sidecar metadata file first (instant)
        try {
          const metaRaw = await fs.readFile(metaPath, "utf-8");
          const meta = JSON.parse(metaRaw) as { createdAt: string; tables: Record<string, number>; encrypted?: boolean; configOnly?: boolean };
          return {
            filename: file,
            createdAt: meta.createdAt,
            size: stat.size,
            tables: meta.tables,
            encrypted: meta.encrypted ?? file.endsWith(".enc"),
            configOnly: meta.configOnly,
          };
        } catch {
          // No sidecar — fall back to reading the full backup (legacy)
        }

        const encrypted = file.endsWith(".enc");

        // Encrypted files can't be read without the passphrase — return basic info from stat
        if (encrypted) {
          return { filename: file, createdAt: stat.mtime.toISOString(), size: stat.size, tables: {}, encrypted, configOnly: undefined };
        }

        let raw: string;
        if (file.endsWith(".gz")) {
          const compressed = await fs.readFile(filepath);
          raw = gunzipSync(compressed).toString("utf-8");
        } else {
          raw = await fs.readFile(filepath, "utf-8");
        }
        const parsed = JSON.parse(raw) as { metadata: BackupMetadata };

        const createdAt = parsed.metadata?.createdAt ?? stat.mtime.toISOString();
        const tables = parsed.metadata?.tables ?? {};

        const configOnly = parsed.metadata?.configOnly;

        // Write sidecar so future listings are fast
        await fs.writeFile(metaPath, JSON.stringify({ createdAt, tables, encrypted, configOnly })).catch(() => {});

        return { filename: file, createdAt, size: stat.size, tables, encrypted, configOnly };
      } catch {
        return null;
      }
    }),
  );

  return backups
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteBackup(filename: string): Promise<boolean> {
  if (!FILENAME_REGEX.test(filename)) {
    throw new Error("Invalid backup filename");
  }

  const filepath = path.join(BACKUP_DIR, filename);
  try {
    await fs.unlink(filepath);
    // Also remove sidecar metadata file
    await fs.unlink(filepath + ".meta.json").catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function pruneBackups(retentionCount: number): Promise<number> {
  const backups = await listBackups();

  if (backups.length <= retentionCount) return 0;

  const toDelete = backups.slice(retentionCount);
  let deleted = 0;
  for (const backup of toDelete) {
    if (await deleteBackup(backup.filename)) {
      deleted++;
    }
  }

  if (deleted > 0) {
    logger.info("Backup", `Pruned ${deleted} old backup(s), keeping ${retentionCount}`);
  }

  return deleted;
}

export function getBackupFilePath(filename: string): string | null {
  if (!FILENAME_REGEX.test(filename)) return null;
  return path.join(BACKUP_DIR, filename);
}

// Map Prisma model names to actual PostgreSQL table names
function tableToDbName(table: string): string {
  const map: Record<string, string> = {
    systemConfig: "SystemConfig",
    user: "User",
    appSettings: "AppSettings",
    mediaServer: "MediaServer",
    library: "Library",
    mediaItem: "MediaItem",
    mediaItemExternalId: "MediaItemExternalId",
    mediaStream: "MediaStream",
    syncJob: "SyncJob",
    sonarrInstance: "SonarrInstance",
    radarrInstance: "RadarrInstance",
    lidarrInstance: "LidarrInstance",
    seerrInstance: "SeerrInstance",
    ruleSet: "RuleSet",
    ruleMatch: "RuleMatch",
    lifecycleAction: "LifecycleAction",
    lifecycleException: "LifecycleException",
    watchHistory: "WatchHistory",
    blackoutSchedule: "BlackoutSchedule",
    prerollPreset: "PrerollPreset",
    prerollSchedule: "PrerollSchedule",
    savedQuery: "SavedQuery",
    logEntry: "LogEntry",
  };
  return map[table] ?? table;
}

// Deserialize date strings back to Date objects for Prisma
function deserializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      result[key] = new Date(value);
    }
  }
  return result;
}
