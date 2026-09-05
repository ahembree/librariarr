import { prisma } from "@/lib/db";
import { eventBus } from "@/lib/events/event-bus";
import { logger } from "@/lib/logger";

/**
 * Announce that a server's stored play data changed.
 *
 * Deliberately its own event type rather than `sync:completed`. The two answer
 * different questions and have very different costs:
 *
 * - `sync:completed` means "this server's library was re-scanned", and sixteen
 *   subscribers respond by refetching whole media listings. Firing it here
 *   would be a refetch storm: the Tracearr backfill emits once per five-minute
 *   slice for as long as a multi-hour archive walk takes, so every library page
 *   would re-pull tens of thousands of rows, over and over, for hours.
 * - `watch-history:updated` means "plays moved", which concerns only the
 *   play-derived surfaces — the History page, watch statistics, and the
 *   per-item play lists.
 *
 * Distinct from `tracearr:import-progress`, which reports that an import is
 * *in flight* and drives only the "still importing" notice. This one says the
 * data itself is different and should be re-read.
 *
 * Carries no counts that a consumer could render as truth — like
 * `tracearr:import-progress`, the receiving page refetches the route that owns
 * the numbers, so there is only ever one place they are computed.
 *
 * Best-effort: a sync must never fail because an event could not be emitted.
 */
export async function emitWatchHistoryUpdated(
  serverId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    // These jobs are scheduler- and realtime-driven, so there is no session to
    // read the owner from — resolve it from the server record.
    const server = await prisma.mediaServer.findUnique({
      where: { id: serverId },
      select: { userId: true },
    });
    if (!server) return;

    eventBus.emit({
      type: "watch-history:updated",
      userId: server.userId,
      meta: { serverId, ...meta },
    });
  } catch (error) {
    logger.warn("WatchHistory", "Failed to emit watch-history:updated", {
      serverId,
      error: String(error),
    });
  }
}
