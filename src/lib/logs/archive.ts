import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { createGzip, gzipSync } from "zlib";

// Runtime data directory: env-resolved and outside the project (under /config in
// the container), so Turbopack's build-time tracer cannot resolve it statically and
// falls back to tracing the WHOLE project into the standalone output ("Dynamic
// filesystem access causes tracing of the whole project"). Nothing here is a build
// input, so every fs/path call it flags carries `/* turbopackIgnore: true */`.
const LOG_ARCHIVE_DIR = process.env.LOG_ARCHIVE_DIR || "/config/logs";

/** Date string in YYYY-MM-DD format */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Get start-of-day (00:00:00.000) in UTC for a given date */
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Build a minimal POSIX tar archive buffer containing a single file.
 * Tar format: 512-byte header + data padded to 512-byte boundary + 1024 zero bytes (end-of-archive).
 */
function buildTarBuffer(filename: string, data: Buffer): Buffer {
  const header = buildTarHeader(filename, data.length);

  // Data padded to 512-byte boundary
  const padding = (512 - (data.length % 512)) % 512;
  const dataPadded = Buffer.concat([data, Buffer.alloc(padding, 0)]);

  // End-of-archive marker (two 512-byte zero blocks)
  const endMarker = Buffer.alloc(1024, 0);

  return Buffer.concat([header, dataPadded, endMarker]);
}

/** The 512-byte ustar header of one regular file of `size` bytes. */
function buildTarHeader(filename: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);

  // Name (0–99)
  header.write(filename, 0, Math.min(filename.length, 100), "utf-8");
  // Mode (100–107)
  header.write("0000644\0", 100, 8, "utf-8");
  // UID (108–115)
  header.write("0001000\0", 108, 8, "utf-8");
  // GID (116–123)
  header.write("0001000\0", 116, 8, "utf-8");
  // Size in octal (124–135)
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "utf-8");
  // Mtime in octal (136–147)
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "utf-8");
  // Type flag: regular file (156)
  header.write("0", 156, 1, "utf-8");
  // USTAR magic (257–264)
  header.write("ustar\0", 257, 6, "utf-8");
  // USTAR version (263–264)
  header.write("00", 263, 2, "utf-8");

  // Compute checksum: sum of all bytes in header, treating checksum field (148–155) as spaces
  header.fill(0x20, 148, 156); // spaces for checksum field
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");

  return header;
}

/**
 * Archive previous days' logs to .tar.gz files and remove them from the DB.
 * Each archive contains a single JSON file with all log entries for that day.
 * Tarballs older than the retention period are deleted.
 */
export async function archiveLogs() {
  const settings = await prisma.appSettings.findFirst({
    select: { logRetentionDays: true },
  });
  const retentionDays = settings?.logRetentionDays ?? 7;

  await fs.mkdir(LOG_ARCHIVE_DIR, { recursive: true });

  const today = startOfDay(new Date());

  // Find the oldest log entry that predates today
  const oldestLog = await prisma.logEntry.findFirst({
    where: { createdAt: { lt: today } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  if (oldestLog) {
    const current = startOfDay(oldestLog.createdAt);
    while (current < today) {
      const dayStart = new Date(current);
      const dayEnd = new Date(current);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

      const dateStr = formatDate(dayStart);
      const archivePath = path.join(LOG_ARCHIVE_DIR, `logs-${dateStr}.tar.gz`);

      // If archive already exists, just clean remaining DB entries for that day
      try {
        await fs.access(archivePath);
        const deleted = await prisma.logEntry.deleteMany({
          where: { createdAt: { gte: dayStart, lt: dayEnd } },
        });
        if (deleted.count > 0) {
          logger.debug("LogArchive", `Cleaned ${deleted.count} already-archived entries for ${dateStr}`);
        }
        current.setUTCDate(current.getUTCDate() + 1);
        continue;
      } catch {
        // File doesn't exist — proceed to archive
      }

      const logs = await prisma.logEntry.findMany({
        where: { createdAt: { gte: dayStart, lt: dayEnd } },
        orderBy: { createdAt: "asc" },
      });

      if (logs.length > 0) {
        const jsonContent = JSON.stringify(logs, null, 2);
        const jsonBuffer = Buffer.from(jsonContent, "utf-8");
        const tarBuffer = buildTarBuffer(`logs-${dateStr}.json`, jsonBuffer);
        const compressed = gzipSync(tarBuffer);
        await fs.writeFile(archivePath, compressed);

        await prisma.logEntry.deleteMany({
          where: { createdAt: { gte: dayStart, lt: dayEnd } },
        });

        logger.info("LogArchive", `Archived ${logs.length} log entries for ${dateStr}`);
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }
  }

  // Prune tarballs older than retention period
  await pruneArchives(retentionDays);
}

/** Rows read per query when the whole log table is archived. */
export const PRE_RESTORE_PAGE_SIZE = 5000;

const PRE_RESTORE_ARCHIVE_PATTERN = /^logs-\d{4}-\d{2}-\d{2}-pre-restore-\d+\.tar\.gz$/;

/**
 * Write every log row currently in the database to an archive file, without
 * deleting any. Called before a restore, which truncates `LogEntry` along with
 * everything else and refills it from the backup (a config-only backup holds
 * no log rows at all): the record of what happened on this instance up to the
 * restore — who signed in, what was changed — would otherwise be gone, the
 * "Restoring from backup" line included.
 *
 * The table can be large (a day of `LOG_DEBUG` output), so it is never held in
 * memory: rows are read a page at a time and written to a temporary JSON file
 * — one array, a row per line — which is then streamed into the tarball.
 *
 * Named `logs-<date>-pre-restore-<epoch ms>.tar.gz`, so it sits beside the
 * daily archives and is pruned with them. Returns the file name, or `null`
 * when there was nothing to keep. A restore that then fails calls
 * `discardPreRestoreArchive`: the rows it archived are still in the table.
 */
export async function archiveLogsBeforeRestore(): Promise<string | null> {
  if ((await prisma.logEntry.count()) === 0) return null;

  await fs.mkdir(LOG_ARCHIVE_DIR, { recursive: true });
  const now = new Date();
  const base = `logs-${formatDate(now)}-pre-restore-${now.getTime()}`;
  const jsonPath = path.join(/* turbopackIgnore: true */ LOG_ARCHIVE_DIR, `${base}.json.tmp`);
  const archivePath = path.join(/* turbopackIgnore: true */ LOG_ARCHIVE_DIR, `${base}.tar.gz`);

  try {
    // Pass 1: the rows, a page at a time, as one JSON array.
    let written = 0;
    await pipeline(async function* rows() {
      let cursor: string | undefined;
      for (;;) {
        const page = await prisma.logEntry.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: PRE_RESTORE_PAGE_SIZE,
          ...(cursor !== undefined && { cursor: { id: cursor }, skip: 1 }),
        });
        if (page.length === 0) break;
        for (const row of page) {
          yield `${written === 0 ? "[\n" : ",\n"}${JSON.stringify(row)}`;
          written++;
        }
        cursor = page[page.length - 1].id;
        if (page.length < PRE_RESTORE_PAGE_SIZE) break;
      }
      yield written === 0 ? "[]\n" : "\n]\n";
    }, createWriteStream(jsonPath, { mode: 0o600 }));
    if (written === 0) return null;

    // Pass 2: that file as the single entry of a gzipped tar. Log rows quote
    // server names and addresses: owner-only, like a backup.
    const { size } = await fs.stat(jsonPath);
    await pipeline(
      async function* tar() {
        yield buildTarHeader(`${base}.json`, size);
        yield* createReadStream(jsonPath);
        yield Buffer.alloc((512 - (size % 512)) % 512 + 1024, 0);
      },
      createGzip(),
      createWriteStream(archivePath, { mode: 0o600 }),
    );
    return `${base}.tar.gz`;
  } catch (error) {
    await fs.unlink(archivePath).catch(() => {});
    throw error;
  } finally {
    await fs.unlink(jsonPath).catch(() => {});
  }
}

/**
 * Remove an archive `archiveLogsBeforeRestore` wrote, for a restore that
 * failed: its transaction rolled back, the rows are still in the table, and
 * each further attempt would otherwise leave another copy. Only a name of
 * that function's own shape is ever removed.
 */
export async function discardPreRestoreArchive(name: string): Promise<void> {
  if (!PRE_RESTORE_ARCHIVE_PATTERN.test(name)) return;
  await fs.unlink(path.join(/* turbopackIgnore: true */ LOG_ARCHIVE_DIR, name)).catch(() => {});
}

/**
 * Delete archive tarballs older than the retention period.
 */
async function pruneArchives(retentionDays: number) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = formatDate(cutoff);

  let files: string[];
  try {
    files = await fs.readdir(/* turbopackIgnore: true */ LOG_ARCHIVE_DIR);
  } catch {
    return;
  }

  // The daily archives, and the ones a restore leaves (`archiveLogsBeforeRestore`).
  const archivePattern = /^logs-(\d{4}-\d{2}-\d{2})(?:-pre-restore-\d+)?\.tar\.gz$/;

  for (const file of files) {
    const match = file.match(archivePattern);
    if (!match) continue;

    if (match[1] < cutoffStr) {
      await fs.unlink(path.join(/* turbopackIgnore: true */ LOG_ARCHIVE_DIR, file));
      logger.info("LogArchive", `Pruned old archive ${file}`);
    }
  }
}
