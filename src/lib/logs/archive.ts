import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import fs from "fs/promises";
import path from "path";
import { gzipSync } from "zlib";

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
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf-8");
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

  // Data padded to 512-byte boundary
  const padding = (512 - (data.length % 512)) % 512;
  const dataPadded = Buffer.concat([data, Buffer.alloc(padding, 0)]);

  // End-of-archive marker (two 512-byte zero blocks)
  const endMarker = Buffer.alloc(1024, 0);

  return Buffer.concat([header, dataPadded, endMarker]);
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

/**
 * Delete archive tarballs older than the retention period.
 */
async function pruneArchives(retentionDays: number) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = formatDate(cutoff);

  let files: string[];
  try {
    files = await fs.readdir(LOG_ARCHIVE_DIR);
  } catch {
    return;
  }

  const archivePattern = /^logs-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;

  for (const file of files) {
    const match = file.match(archivePattern);
    if (!match) continue;

    if (match[1] < cutoffStr) {
      await fs.unlink(path.join(LOG_ARCHIVE_DIR, file));
      logger.info("LogArchive", `Pruned old archive ${file}`);
    }
  }
}

/**
 * List available log archives with their metadata.
 */
export async function listArchives(): Promise<Array<{
  filename: string;
  date: string;
  size: number;
}>> {
  await fs.mkdir(LOG_ARCHIVE_DIR, { recursive: true });

  let files: string[];
  try {
    files = await fs.readdir(LOG_ARCHIVE_DIR);
  } catch {
    return [];
  }

  const archivePattern = /^logs-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;
  const archives: Array<{ filename: string; date: string; size: number }> = [];

  for (const file of files) {
    const match = file.match(archivePattern);
    if (!match) continue;

    const stat = await fs.stat(path.join(LOG_ARCHIVE_DIR, file));
    archives.push({
      filename: file,
      date: match[1],
      size: stat.size,
    });
  }

  return archives.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Get the full path to an archive file (validated).
 * Returns null if the file doesn't exist or the filename is invalid.
 */
export async function getArchivePath(filename: string): Promise<string | null> {
  if (!/^logs-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(filename)) {
    return null;
  }

  const filePath = path.join(LOG_ARCHIVE_DIR, filename);
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    return null;
  }
}
