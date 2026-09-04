import { prisma } from "@/lib/db";

/**
 * The write half of `MediaServer.watchHistorySyncedAt` — the marker recording
 * whether a server's play history has been ESTABLISHED. Its read half is
 * `checkWatchHistoryCompleteness` in `lifecycle/evaluability.ts`, which refuses
 * to evaluate any play-activity criterion for a server that has none.
 *
 * The marker exists because an EMPTY `WatchHistory` is indistinguishable from
 * "nobody watched anything", and the two demand opposite behaviour. Every
 * play-activity field has a negative form that goes vacuously true against
 * absent evidence — `watchedByUser is not alice` compiles to
 * `watchHistory: { none: … }`, `playCount = 0` and `lastPlayedAt is null` match
 * everything once the denormalized columns were never established. On a DELETE
 * rule set that is the whole library.
 */

/**
 * Record that a sync has established what was played on these servers.
 *
 * Called only after a SUCCESSFUL sync — including one that legitimately finds
 * no plays at all. That case matters: a server nobody watches is a real steady
 * state, and leaving it unmarked would pause its play-activity rules forever. A
 * failed fetch must NOT call this; the history is still unknown.
 */
export async function markWatchHistoryEstablished(serverIds: string[]): Promise<number> {
  if (serverIds.length === 0) return 0;
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: { in: serverIds } },
    data: { watchHistorySyncedAt: new Date() },
  });
  return count;
}

/**
 * Withdraw that record — the server's history is no longer known.
 *
 * **Every path that destroys watch history in bulk has to call this**, not just
 * the one it was written for. `WatchHistory.mediaItem` is a required FK with
 * `onDelete: Cascade`, so the rows are destroyed by more than the obvious
 * route: changing a server's watch-history source (the `/api/servers/[id]` PUT,
 * which deletes them directly), purging a library or a whole media type,
 * disabling a server with `deleteData`, and restoring a backup (which
 * `TRUNCATE`s every table in `TABLE_ORDER` — `MediaItem` and `WatchHistory`
 * included — before re-inserting only what the file holds, so a config-only
 * backup empties both and refills neither).
 *
 * Re-established by the next successful sync, so this pauses play-activity
 * rules rather than disabling them.
 */
export async function invalidateWatchHistoryEvidence(serverIds: string[]): Promise<number> {
  if (serverIds.length === 0) return 0;
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: { in: serverIds }, watchHistorySyncedAt: { not: null } },
    data: { watchHistorySyncedAt: null },
  });
  return count;
}

/**
 * Withdraw it from every server that currently holds no watch history at all.
 *
 * For callers that cannot enumerate the servers they affected — restore being
 * the case that matters, since it truncates the whole database and then
 * re-inserts servers from the backup file, so the surviving ids are not known
 * until afterwards. Asked of the rows rather than of the operation, so it
 * cannot miss a server the operation reached indirectly.
 */
export async function invalidateServersWithoutWatchHistory(): Promise<number> {
  const servers = await prisma.mediaServer.findMany({
    where: { watchHistorySyncedAt: { not: null }, watchHistory: { none: {} } },
    select: { id: true },
  });
  return invalidateWatchHistoryEvidence(servers.map((s) => s.id));
}
