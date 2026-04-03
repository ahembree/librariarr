import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Mark any RUNNING or PENDING sync jobs as FAILED on startup.
 * These are orphaned from a previous process that exited before completing.
 */
export async function cleanupOrphanedSyncJobs(): Promise<void> {
  const result = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `WITH updated AS (
       UPDATE "SyncJob"
       SET "status" = 'FAILED',
           "completedAt" = NOW(),
           "error" = 'Server restarted while sync was in progress',
           "currentLibrary" = NULL
       WHERE "status" IN ('RUNNING', 'PENDING')
       RETURNING 1
     )
     SELECT COUNT(*)::bigint AS count FROM updated`,
  );

  const count = Number(result[0]?.count ?? 0);
  if (count > 0) {
    logger.info("Sync", `Cleaned up ${count} orphaned sync job(s) from previous run`);
  }
}
