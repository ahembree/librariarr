import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import { MAIN_QUEUE, TASK_TRACEARR_BACKFILL } from "@/lib/jobs/constants";
import { logger } from "@/lib/logger";

/**
 * The one jobKey every `TASK_TRACEARR_BACKFILL` enqueue uses — the task's own
 * re-enqueue, `syncWatchHistory`'s, and the ones below — so all of them
 * collapse onto one queued slice per server, and the status route reads the
 * job's state under it.
 */
export function tracearrBackfillJobKey(serverId: string): string {
  return `tracearr-backfill:${serverId}`;
}

/**
 * Queue a Tracearr backfill slice right away, after something that was
 * stopping the import has been put right: a mapping set or changed, a server
 * re-enabled, a Tracearr instance created, re-enabled, or re-pointed.
 *
 * Without it, nothing ran until the next watch-history sync — hours with
 * realtime off — while Settings went on reporting the state the fix had just
 * changed: a job parked by the old cause read "History import failing", and a
 * fresh mapping waited with nothing queued. A keyed add REPLACES a parked row
 * with a fresh one (attempts reset), which is what clears the failing state —
 * deliberately without `isJobRetrying`'s backoff check, since the cause the
 * backoff was waiting out is the one just fixed.
 *
 * Only servers the import can actually run for, and safely:
 *  - mapped and enabled, with an enabled Tracearr instance on the account (a
 *    slice for anything else fails or no-ops, and would only burn attempts);
 *  - holding items in an enabled library — the importer refuses to walk into
 *    an empty library (no play could be attributed), and the first sync's
 *    watch-history step queues the slice once there is something to join to;
 *  - NOT waiting on a re-sync after `restartTracearrBackfill` (cursor moved,
 *    no walk since): a purge or a restore removed items the archive's plays
 *    belong to, and a walk run before the re-sync brings them back skips those
 *    plays as unresolved and can mark the archive complete without them — for
 *    good. The next watch-history sync queues that walk, after the items.
 *
 * Best-effort: never throws. A failed read or enqueue is logged and leaves the
 * import to the next watch-history sync, exactly as before. Returns the ids
 * queued.
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
        // The restart state — see above.
        NOT: { tracearrBackfillLastWalkAt: null, tracearrBackfillCursorAt: { not: null } },
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
