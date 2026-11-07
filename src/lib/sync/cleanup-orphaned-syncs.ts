import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { eventBus } from "@/lib/events/event-bus";
import { isSyncRunLive } from "@/lib/sync/live-sync-runs";

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

export const DEAD_SYNC_RUN_ERROR = "The sync stopped without recording how it ended";

/**
 * Close the server's RUNNING rows whose run is no longer in progress, and
 * return how many it closed.
 *
 * A run records its own end, but that write can fail: a database outage
 * mid-sync fails the catch's FAILED update too, and the row stays RUNNING with
 * nothing left to end it. Every guard that reads a RUNNING row — the sync
 * task's "already running", the watch-history task and the incremental sync
 * ("full sync in progress"), the sync route's 409, Stop — then treated the
 * server as busy until a restart ran `cleanupOrphanedSyncJobs`. Each of them
 * calls this first. A row is live only while `live-sync-runs` holds it, and
 * a live run is never touched; the update is conditional on RUNNING, so a run
 * that ends between the read and the write keeps its own outcome.
 */
export async function closeDeadSyncJobs(serverId: string): Promise<number> {
  const running = await prisma.syncJob.findMany({
    where: { mediaServerId: serverId, status: "RUNNING" },
    select: { id: true },
  });
  const dead = running.map((row) => row.id).filter((id) => !isSyncRunLive(id));
  if (dead.length === 0) return 0;

  const { count } = await prisma.syncJob.updateMany({
    where: { id: { in: dead }, status: "RUNNING" },
    data: { status: "FAILED", completedAt: new Date(), error: DEAD_SYNC_RUN_ERROR, currentLibrary: null },
  });
  if (count > 0) {
    logger.warn(
      "Sync",
      `Closed ${count} sync job(s) for server ${serverId} left RUNNING by a run that had already ended`,
    );
    // The status surfaces still show the row as running; they refetch on this.
    const server = await prisma.mediaServer.findUnique({ where: { id: serverId }, select: { userId: true } });
    if (server) eventBus.emit({ type: "sync:failed", userId: server.userId, meta: { serverId } });
  }
  return count;
}
