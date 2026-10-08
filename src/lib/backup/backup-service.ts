import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import fs from "fs/promises";
import path from "path";
import { gzipSync, gunzipSync } from "zlib";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "crypto";
import {
  forgetLibraryResyncHoldRequests,
  invalidateServersWithoutWatchHistory,
  requireLibraryResync,
} from "@/lib/media/watch-evidence";
import { notePlayHistoryPauseForRestoredMatches } from "@/lib/lifecycle/evaluability";

// Runtime data directory: env-resolved and outside the project (under /config in
// the container), so Turbopack's build-time tracer cannot resolve it statically and
// falls back to tracing the WHOLE project into the standalone output ("Dynamic
// filesystem access causes tracing of the whole project"). Nothing here is a build
// input, so every fs/path call it flags carries `/* turbopackIgnore: true */`.
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

// Table export/import order respecting FK dependencies. Every model must be
// either here or in `BACKUP_EXCLUDED_TABLES` — asserted over Prisma's model
// list by tests/unit/backup/table-order.test.ts, because restore begins with
// `TRUNCATE "User" CASCADE`: a table missing from both is destroyed by every
// restore and never refilled. `collection` and `trashManagedResource` were
// missing that way, and since `RuleSet.collectionId` references `Collection`,
// a backup holding any rule set assigned to a Plex collection could not be
// restored at all.
export const BACKUP_TABLE_ORDER = [
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
  "tracearrInstance",
  "trashManagedResource",
  "collection",
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

/**
 * Models deliberately left out of backups.
 *
 * `apiKey`: a restore wipes every API key (via the `User` CASCADE) instead of
 * restoring the set the backup captured — which would bring back any key
 * deleted since, silently undoing a revocation. Third-party apps need new keys
 * after a restore; a backup file never carries key material, not even hashes.
 */
export const BACKUP_EXCLUDED_TABLES = ["apiKey"] as const;

const TABLE_ORDER = BACKUP_TABLE_ORDER;

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
  // Owner-only: a backup holds every integration's API key and the Plex token
  // (encrypted only when a passphrase is set), and the container's umask would
  // otherwise leave it readable by every user on the host.
  await fs.writeFile(filepath, output, { mode: 0o600 });

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

  const filepath = path.join(/* turbopackIgnore: true */ BACKUP_DIR, filename);
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
      const fileData = await fs.readFile(/* turbopackIgnore: true */ filepath);
      return decryptBuffer(fileData, passphrase);
    })();
    raw = gunzipSync(compressed).toString("utf-8");
  } else if (filename.endsWith(".gz")) {
    const compressed = await fs.readFile(/* turbopackIgnore: true */ filepath);
    raw = gunzipSync(compressed).toString("utf-8");
  } else {
    raw = await fs.readFile(/* turbopackIgnore: true */ filepath, "utf-8");
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

    // A rule set may point at a collection the file does not hold: every
    // backup taken before `collection` joined TABLE_ORDER is like that. Detach
    // those rule sets rather than fail the FK and with it the whole restore —
    // their rules and actions come back, the collection has to be re-picked.
    const restorableCollectionIds = new Set(
      (backup.data.collection ?? []).map((row) => (row as { id?: unknown }).id),
    );

    // Step 3: Re-insert data in dependency order, freeing each table after processing
    for (let tableIdx = 0; tableIdx < TABLE_ORDER.length; tableIdx++) {
      const table = TABLE_ORDER[tableIdx];
      let rows = backup.data[table];
      delete backup.data[table]; // Allow GC of previous tables' data
      if (!rows || rows.length === 0) continue;

      if (table === "ruleSet") {
        rows = detachMissingCollections(rows, restorableCollectionIds);
      }

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
            data: batch.map((row) => deserializeRow(row as Record<string, unknown>, table)),
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

  // Restore TRUNCATEs every table in `TABLE_ORDER` — `MediaItem` and
  // `WatchHistory` included — and then re-inserts only what the file actually
  // holds. A config-only backup holds neither, so it empties both and refills
  // neither: the media comes back on the next sync, and so does the history —
  // native history is re-fetched, and a Tracearr server's archive walk is
  // restarted below.
  //
  // An empty `WatchHistory` reads as "nobody watched anything", so without this
  // the first detection run after a restore-plus-resync matches the WHOLE
  // library on any `watchedByUser` negative. Done outside the transaction: it
  // is a safety marker, not part of the restore's atomicity, and it is asked of
  // the rows rather than of the operation so it cannot miss a server.
  const marked = await invalidateServersWithoutWatchHistory();
  if (marked > 0) {
    logger.info(
      "Backup",
      `Marked ${marked} media server(s) as having no watch history yet — ` +
        `watchedByUser lifecycle rules are paused for them until a sync refills it`,
    );
  }

  // EVERY restored server is held until a full sync (`requireLibraryResync`),
  // not only one restored without its media (every server after a config-only
  // restore). A full backup is a snapshot too: whatever was added after it was
  // taken comes back on the next sync as fresh rows with none of their plays,
  // and no restored row holds those plays either. Until a full sync has
  // re-added them, no history pass may vouch for the server's play history:
  // one that ran first (a playback's realtime job, a History-page Refresh)
  // would mark it established over items that do not exist yet, and they would
  // then read "nobody watched anything". Asked of the rows, like the withdrawal
  // above, since the restored ids are not known up front.
  //
  // The hold also restarts a Tracearr-mapped server's archive walk from the
  // newest play (`restartTracearrBackfill`) and keeps it from running until
  // that sync: the row comes back verbatim, its walk state describing an
  // archive whose rows the file may not hold (every config-only backup, a full
  // one taken while the walk had stored nothing — "complete" would then import
  // nothing ever again, and a restored mid-walk cursor would resume deep in the
  // archive and never read the newer stretch), and even the rows it does hold
  // stop at the backup. The plays of what came back since are read only by a
  // walk that runs after the sync has re-added it.
  //
  // Releasing it takes one full sync. A hold waits only for the libraries
  // holding no item created (a minute or more) before it, so after a full
  // restore — its libraries hold the file's items, created before it — the
  // next full sync releases it whatever it can list, and after a config-only
  // restore the first full sync that brings every library's media back.
  //
  // The restore rewrote every server's hold column from the file, so the hold
  // requests this process noted against the old rows describe nothing now:
  // forgotten first, leaving the restore's own the outstanding one. Likewise
  // every library's recorded shortfall (`Library.shortPassSeenAt`): it
  // described a pass of rows the restore replaced, so the next pass counts
  // afresh. Cleared AFTER the holds are noted, so a library pass still running
  // from before the restore records none after the clear: it now sees a
  // request newer than its start (`libraryResyncRequestedSince`).
  forgetLibraryResyncHoldRequests();
  const restoredServers = await prisma.mediaServer.findMany({ select: { id: true } });
  const heldIds = restoredServers.map((server) => server.id);
  if (heldIds.length > 0) {
    await requireLibraryResync(heldIds);
    logger.info(
      "Backup",
      `Holding the play history of ${heldIds.length} restored media server(s) until a full sync ` +
        `has brought back the media the backup did not hold`,
    );
  }
  await prisma.library.updateMany({
    where: { shortPassSeenAt: { not: null } },
    data: { shortPassSeenAt: null },
  });

  // A FULL backup also brings back its lifecycle matches and actions, and they
  // are as old as the backup: an item watched since it was taken still holds
  // its match. The hold above keeps play-activity rule sets from being
  // evaluated until the next full sync, but it lifts there — and an execution
  // that ran after that sync and before detection would act on the backup's
  // matches. So every rule set the file brought matches back for is latched
  // like one detection skipped (`notePlayHistoryPauseForRestoredMatches`): its
  // actions wait until a detection run has evaluated it. A config-only backup
  // holds no matches, so this latches nothing. Taken after the holds, so a
  // detection run that began before them cannot lift it.
  const latched = await notePlayHistoryPauseForRestoredMatches();
  if (latched > 0) {
    logger.info(
      "Backup",
      `The backup brought back the lifecycle matches of ${latched} rule set(s), as old as the ` +
        `backup — the actions of those that read play activity are held until detection has ` +
        `evaluated each again`,
    );
  }

  onProgress?.({ phase: "complete", message: "Restore completed" });
  logger.info("Backup", `Restore completed from ${filename}`);
}

export async function listBackups(): Promise<BackupInfo[]> {
  await ensureBackupDir();

  let files: string[];
  try {
    files = await fs.readdir(/* turbopackIgnore: true */ BACKUP_DIR);
  } catch {
    return [];
  }

  const backupFiles = files.filter((f) => FILENAME_REGEX.test(f) && !f.endsWith(".meta.json"));

  const backups = await Promise.all(
    backupFiles.map(async (file): Promise<BackupInfo | null> => {
      try {
        const filepath = path.join(/* turbopackIgnore: true */ BACKUP_DIR, file);
        const metaPath = filepath + ".meta.json";

        const stat = await fs.stat(/* turbopackIgnore: true */ filepath);

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
          const compressed = await fs.readFile(/* turbopackIgnore: true */ filepath);
          raw = gunzipSync(compressed).toString("utf-8");
        } else {
          raw = await fs.readFile(/* turbopackIgnore: true */ filepath, "utf-8");
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

  const filepath = path.join(/* turbopackIgnore: true */ BACKUP_DIR, filename);
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
  return path.join(/* turbopackIgnore: true */ BACKUP_DIR, filename);
}

// Map a Prisma delegate name to its PostgreSQL table: the model name, which is
// the delegate with its first letter upper-cased (no model uses @@map). Derived
// rather than listed, because a name missing from a hand-kept list fell through
// unchanged, and a TRUNCATE of a table that does not exist aborts the restore's
// whole transaction — every statement after it fails.
function tableToDbName(table: string): string {
  return table.charAt(0).toUpperCase() + table.slice(1);
}

// Per-table rename map for legacy field names from older schema versions.
// Keys are the legacy column name in the backup file, values are the current
// model field name. Without this, restores of pre-rename backups would crash
// on `createMany` with "Unknown argument" errors.
const LEGACY_FIELD_RENAMES: Record<string, Record<string, string>> = {
  ruleSet: { searchAfterDelete: "searchAfterAction" },
  lifecycleAction: { searchAfterDelete: "searchAfterAction" },
};

// Strict, FULLY-ANCHORED ISO-8601 datetime matcher (matches what serializeRow
// emits via Date#toISOString, plus common offset/precision variants). The old
// matcher was unanchored at the end, so any string value that merely STARTED
// ISO-like — a media title, rule name, log message, or a collection label such
// as "2024-01-01T00:00:00 Retrospective" — was coerced to a Date, corrupting
// string columns or failing the whole-table createMany. Anchoring both ends
// means only a value that is ENTIRELY a timestamp is converted.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * Field names the CURRENT schema has for a table, from Prisma's generated
 * per-model scalar-field enums. Generated, so it cannot drift from the schema.
 */
function knownFieldsFor(table: string): Set<string> | null {
  const cached = knownFieldCache.get(table);
  if (cached !== undefined) return cached;
  const enumName = `${table.charAt(0).toUpperCase()}${table.slice(1)}ScalarFieldEnum`;
  const fieldEnum = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[enumName];
  const fields = fieldEnum ? new Set(Object.keys(fieldEnum)) : null;
  knownFieldCache.set(table, fields);
  return fields;
}
const knownFieldCache = new Map<string, Set<string> | null>();

/** Columns already reported as dropped, so one restore logs each table once. */
const droppedFieldsReported = new Set<string>();

function detachMissingCollections(rows: unknown[], collectionIds: Set<unknown>): unknown[] {
  let detached = 0;
  const result = rows.map((row) => {
    const r = row as Record<string, unknown>;
    if (r.collectionId == null || collectionIds.has(r.collectionId)) return row;
    detached++;
    return { ...r, collectionId: null };
  });
  if (detached > 0) {
    logger.warn(
      "Backup",
      `Restore: ${detached} rule set(s) pointed at a collection this backup does not contain — detached; reassign their collection in the rule editor`,
    );
  }
  return result;
}

// Deserialize date strings back to Date objects for Prisma, and migrate any
// legacy field names so older backups still restore cleanly.
function deserializeRow(row: Record<string, unknown>, table?: string): Record<string, unknown> {
  const renames = table ? LEGACY_FIELD_RENAMES[table] : undefined;
  // Drop columns the current schema no longer has. Prisma validates createMany
  // arguments client-side, so a single unknown key rejects the whole batch and
  // aborts the restore — a backup taken before a column was dropped would be
  // permanently unrestorable. Renames above handle fields that moved; this
  // handles fields that went away entirely.
  const known = table ? knownFieldsFor(table) : null;
  const result: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    const mappedKey = renames?.[key] ?? key;
    if (known && !known.has(mappedKey)) {
      dropped.push(mappedKey);
      continue;
    }
    // Only coerce when the ENTIRE string is a valid ISO timestamp.
    if (typeof value === "string" && ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value))) {
      result[mappedKey] = new Date(value);
    } else {
      result[mappedKey] = value;
    }
  }
  if (dropped.length > 0 && table && !droppedFieldsReported.has(table)) {
    droppedFieldsReported.add(table);
    logger.info(
      "Backup",
      `Restore: ignoring ${dropped.length} column(s) on "${table}" that this schema no longer has: ${dropped.join(", ")}`,
    );
  }
  return result;
}
