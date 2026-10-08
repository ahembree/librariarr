import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import { MAIN_QUEUE, TASK_TRACEARR_BACKFILL } from "@/lib/jobs/constants";
import { logger } from "@/lib/logger";

/**
 * The one jobKey for every `TASK_TRACEARR_BACKFILL` enqueue, so they collapse
 * onto one queued slice per server; the status route reads the job under it.
 */
export function tracearrBackfillJobKey(serverId: string): string {
  return `tracearr-backfill:${serverId}`;
}

/**
 * Queue a Tracearr backfill slice right away, after something that stopped the
 * import was put right (a mapping set or changed, a server re-enabled, an
 * instance created, re-enabled or re-pointed) — otherwise nothing ran until the
 * next watch-history sync. A keyed add REPLACES a parked job with a fresh one,
 * which is what clears "failing"; deliberately no `isJobRetrying` check, since
 * the cause the backoff waited out was just fixed.
 *
 * Only servers the import can run for: mapped and enabled with an enabled
 * instance; holding items in an enabled library (the importer refuses an empty
 * one); and NOT under the library-resync hold, read from the recorded hold —
 * a walk before the releasing sync would skip the missing items' plays and can
 * complete without them for good, and that sync queues the walk itself.
 *
 * Best-effort: never throws (failures are logged). Returns the ids queued.
 */
export async function enqueueTracearrBackfill(
  scope: { serverIds: string[] } | { userId: string },
  reason: string,
): Promise<string[]> {
  if ("serverIds" in scope && scope.serverIds.length === 0) return [];
  let serverIds: string[];
  try {
    const servers = await prisma.mediaServer.findMany({
      where: {
        ...("serverIds" in scope ? { id: { in: scope.serverIds } } : { userId: scope.userId }),
        enabled: true,
        tracearrServerId: { not: null },
        user: { tracearrInstances: { some: { enabled: true } } },
        libraries: { some: { enabled: true, mediaItems: { some: {} } } },
        // The library-resync hold — see above.
        libraryResyncRequiredAt: null,
      },
      select: { id: true },
    });
    serverIds = servers.map((server) => server.id);
  } catch (error) {
    logger.warn("Jobs", `Could not queue the Tracearr history import (${reason})`, {
      error: String(error),
    });
    return [];
  }

  const queued: string[] = [];
  for (const serverId of serverIds) {
    // `enqueueJob` logs and answers false rather than throwing; caught anyway,
    // since the save that called this has already committed.
    const ok = await enqueueJob(
      TASK_TRACEARR_BACKFILL,
      { serverId },
      { jobKey: tracearrBackfillJobKey(serverId), queueName: MAIN_QUEUE, maxAttempts: 3 },
    ).catch(() => false);
    if (ok) queued.push(serverId);
  }
  if (queued.length > 0) {
    logger.info(
      "Jobs",
      `Queued the Tracearr history import for ${queued.length} server(s) — ${reason}`,
    );
  }
  return queued;
}
