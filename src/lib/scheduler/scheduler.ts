import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { prisma } from "@/lib/db";
import { syncMediaServer } from "@/lib/sync/sync-server";
import {
  processLifecycleRules,
  executeLifecycleActions,
} from "@/lib/lifecycle/processor";
import { logger } from "@/lib/logger";
import { createBackup, getBackupPassphrase, pruneBackups } from "@/lib/backup/backup-service";

/** Known preset schedule names (used by presetToCron) */
const PRESET_SCHEDULES = new Set(["EVERY_6H", "EVERY_12H", "DAILY", "WEEKLY"]);

/**
 * Get the system's IANA timezone identifier.
 * Respects the TZ environment variable (common in Docker containers).
 * Falls back to the Node.js runtime's resolved timezone.
 */
export function getSystemTimezone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Convert a preset schedule + time-of-day anchor into a cron expression.
 * Returns null for MANUAL or unknown presets.
 */
export function presetToCron(preset: string, timeOfDay: string): string | null {
  if (!PRESET_SCHEDULES.has(preset)) return null;

  const [hours, minutes] = timeOfDay.split(":").map(Number);

  switch (preset) {
    case "DAILY":
      return `${minutes} ${hours} * * *`;
    case "EVERY_12H":
      return `${minutes} ${hours},${(hours + 12) % 24} * * *`;
    case "EVERY_6H":
      return `${minutes} ${hours},${(hours + 6) % 24},${(hours + 12) % 24},${(hours + 18) % 24} * * *`;
    case "WEEKLY":
      return `${minutes} ${hours} * * 1`;
    default:
      return null;
  }
}

let initialized = false;
let isRunning = false;

export function initializeScheduler() {
  if (initialized) return;
  initialized = true;

  // Clean up stale RUNNING sync jobs from a previous crash
  prisma.syncJob.updateMany({
    where: { status: "RUNNING" },
    data: { status: "FAILED", error: "Process restarted during sync" },
  }).then((result) => {
    if (result.count > 0) {
      logger.info("Scheduler", `Cleaned up ${result.count} stale RUNNING sync jobs from previous crash`);
    }
  }).catch(() => {});

  // Check every minute for precise schedule adherence
  cron.schedule("* * * * *", async () => {
    if (isRunning) {
      return;
    }
    isRunning = true;

    try {
      // Fetch all user settings once, shared across sync/lifecycle/backup tasks
      const allSettings = await prisma.appSettings.findMany({
        include: {
          user: {
            include: { mediaServers: true },
          },
        },
      });

      try {
        await runScheduledSyncs(allSettings);
      } catch (error) {
        logger.error("Scheduler", "Error running scheduled syncs", { error: String(error) });
      }

      try {
        await runScheduledLifecycleDetection(allSettings);
      } catch (error) {
        logger.error("Scheduler", "Error in lifecycle detection", { error: String(error) });
      }

      try {
        await runScheduledLifecycleExecution(allSettings);
      } catch (error) {
        logger.error("Scheduler", "Error in lifecycle execution", { error: String(error) });
      }

      try {
        await cleanupOldLogs();
      } catch (error) {
        logger.error("Scheduler", "Error cleaning up old logs", { error: String(error) });
      }

      try {
        await cleanupOldActions();
      } catch (error) {
        logger.error("Scheduler", "Error cleaning up old actions", { error: String(error) });
      }

      try {
        await runScheduledBackups();
      } catch (error) {
        logger.error("Scheduler", "Error in scheduled backup", { error: String(error) });
      }

    } finally {
      isRunning = false;
    }
  });

  logger.info("Scheduler", "Initialized - checking every minute");
}

/** Check if a schedule is due based on cron expression (preset or custom) */
function isScheduleDue(
  schedule: string,
  lastRun: Date | null,
  now: Date,
  scheduledJobTime: string
): boolean {
  if (schedule === "MANUAL") return false;

  // Convert preset schedules to cron using the user's configured time anchor
  const cronExpr = presetToCron(schedule, scheduledJobTime) ?? schedule;

  try {
    const tz = getSystemTimezone();
    const interval = CronExpressionParser.parse(cronExpr, { currentDate: now, tz });
    const prevRun = interval.prev().toDate();
    return !lastRun || prevRun.getTime() > lastRun.getTime();
  } catch {
    return false;
  }
}

type SchedulerSettings = Awaited<ReturnType<typeof prisma.appSettings.findMany<{
  include: { user: { include: { mediaServers: true } } };
}>>>;

async function runScheduledSyncs(allSettings: SchedulerSettings) {
  for (const settings of allSettings) {
    if (!isScheduleDue(settings.syncSchedule, settings.lastScheduledSync, new Date(), settings.scheduledJobTime)) {
      continue;
    }

    // Update timestamp BEFORE running so a crash won't cause a retry storm
    await prisma.appSettings.update({
      where: { id: settings.id },
      data: { lastScheduledSync: new Date() },
    });

    for (const server of settings.user.mediaServers) {
      // Skip disabled servers
      if (!server.enabled) continue;

      // Skip if there's already a running sync for this server
      const runningJob = await prisma.syncJob.findFirst({
        where: {
          mediaServerId: server.id,
          status: { in: ["RUNNING", "PENDING"] },
        },
      });
      if (runningJob) continue;

      try {
        logger.info("Scheduler", `Starting sync for server "${server.name}" (user: ${settings.user.username})`);
        await syncMediaServer(server.id);
      } catch (error) {
        logger.error("Scheduler", `Sync failed for server "${server.name}"`, { error: String(error) });
      }
    }
  }
}

async function runScheduledLifecycleDetection(allSettings: SchedulerSettings) {
  for (const settings of allSettings) {
    if (!isScheduleDue(
      settings.lifecycleDetectionSchedule,
      settings.lastScheduledLifecycleDetection,
      new Date(),
      settings.scheduledJobTime
    )) {
      continue;
    }

    // Update timestamp BEFORE running so a crash won't cause a retry storm
    await prisma.appSettings.update({
      where: { id: settings.id },
      data: { lastScheduledLifecycleDetection: new Date() },
    });

    logger.info("Scheduler", `Running lifecycle detection for user ${settings.user.username}`);

    try {
      await processLifecycleRules(settings.userId);
    } catch (error) {
      logger.error("Scheduler", `Lifecycle detection failed for user ${settings.user.username}`, { error: String(error) });
    }
  }
}

async function runScheduledLifecycleExecution(allSettings: SchedulerSettings) {
  for (const settings of allSettings) {
    if (!isScheduleDue(
      settings.lifecycleExecutionSchedule,
      settings.lastScheduledLifecycleExecution,
      new Date(),
      settings.scheduledJobTime
    )) {
      continue;
    }

    // Update timestamp BEFORE running so a crash won't cause a retry storm
    await prisma.appSettings.update({
      where: { id: settings.id },
      data: { lastScheduledLifecycleExecution: new Date() },
    });

    logger.info("Scheduler", `Running lifecycle execution for user ${settings.user.username}`);

    try {
      await executeLifecycleActions(settings.userId);
    } catch (error) {
      logger.error("Scheduler", `Lifecycle execution failed for user ${settings.user.username}`, { error: String(error) });
    }
  }
}

const MAX_LOG_ENTRIES = 50000;

async function cleanupOldLogs() {
  const settings = await prisma.appSettings.findFirst({
    select: { logRetentionDays: true },
  });
  const retentionDays = settings?.logRetentionDays ?? 7;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const deleted = await prisma.logEntry.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (deleted.count > 0) {
    logger.info("Scheduler", `Log cleanup: removed ${deleted.count} entries older than ${retentionDays} days`);
  }

  // Safety cap: if total logs exceed limit, delete oldest excess
  const totalCount = await prisma.logEntry.count();
  if (totalCount > MAX_LOG_ENTRIES) {
    const excess = totalCount - MAX_LOG_ENTRIES;
    const oldest = await prisma.logEntry.findMany({
      orderBy: { createdAt: "asc" },
      take: excess,
      select: { id: true },
    });
    await prisma.logEntry.deleteMany({
      where: { id: { in: oldest.map((l) => l.id) } },
    });
    logger.info("Scheduler", `Log cleanup: trimmed ${excess} entries to stay under ${MAX_LOG_ENTRIES} cap`);
  }
}

async function cleanupOldActions() {
  const settings = await prisma.appSettings.findFirst({
    select: { actionHistoryRetentionDays: true },
  });
  const retentionDays = settings?.actionHistoryRetentionDays ?? 30;
  if (retentionDays === 0) return; // 0 = keep forever

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const deleted = await prisma.lifecycleAction.deleteMany({
    where: {
      status: { not: "PENDING" },
      createdAt: { lt: cutoff },
    },
  });

  if (deleted.count > 0) {
    logger.info("Scheduler", `Action cleanup: removed ${deleted.count} entries older than ${retentionDays} days`);
  }
}

async function runScheduledBackups() {
  const settings = await prisma.appSettings.findFirst({
    select: { backupSchedule: true, backupRetentionCount: true, lastBackupAt: true, scheduledJobTime: true },
  });

  if (!settings || settings.backupSchedule === "MANUAL") return;

  if (!isScheduleDue(settings.backupSchedule, settings.lastBackupAt, new Date(), settings.scheduledJobTime)) return;

  // Update timestamp before running to prevent retry storms
  await prisma.appSettings.updateMany({
    data: { lastBackupAt: new Date() },
  });

  try {
    const passphrase = await getBackupPassphrase();
    await createBackup(passphrase);
    await pruneBackups(settings.backupRetentionCount);
    logger.info("Scheduler", "Scheduled backup completed");
  } catch (error) {
    logger.error("Scheduler", "Scheduled backup failed", { error: String(error) });
  }
}
