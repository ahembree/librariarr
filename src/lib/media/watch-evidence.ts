import { prisma } from "@/lib/db";

/**
 * Mark media servers as having no trustworthy watch history until a sync
 * refills it — the write half of `MediaServer.watchHistoryClearedAt`, whose
 * read half is `checkWatchHistoryCompleteness` in `lifecycle/evaluability.ts`.
 *
 * The marker exists because an EMPTY `WatchHistory` is indistinguishable from
 * "nobody watched anything", and the two demand opposite behaviour:
 * `watchedByUser`'s negative forms compile to `watchHistory: { none: … }`,
 * which is trivially true for every item against an empty relation. On a DELETE
 * rule set that is the whole library.
 *
 * **Every path that destroys watch history in bulk has to call this**, not just
 * the one it was written for. `WatchHistory.mediaItem` is a required FK with
 * `onDelete: Cascade`, so it is destroyed by more than the obvious route:
 * changing a server's watch-history source (the `/api/servers/[id]` PUT, which
 * deletes the rows directly), purging a library or a whole media type,
 * disabling a server with `deleteData`, and restoring a backup (which
 * `TRUNCATE`s every table in `TABLE_ORDER` — including `MediaItem` and
 * `WatchHistory` — before re-inserting only what the file holds, so a
 * config-only backup empties both and refills neither).
 *
 * Cleared again only by a SUCCESSFUL sync: `syncWatchHistory` on both of its
 * native full-replace exits, and the Tracearr importer in the same guarded
 * write that sets `tracearrBackfillComplete`. A guard that never releases is
 * its own outage.
 *
 * Idempotent — `watchHistoryClearedAt` is only set where it is currently null,
 * so re-marking an already-marked server keeps the ORIGINAL timestamp rather
 * than sliding it forward on every call.
 */
export async function markWatchHistoryCleared(serverIds: string[]): Promise<number> {
  if (serverIds.length === 0) return 0;
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: { in: serverIds }, watchHistoryClearedAt: null },
    data: { watchHistoryClearedAt: new Date() },
  });
  return count;
}

/**
 * Mark every server that currently holds no watch history at all.
 *
 * For callers that cannot enumerate the servers they affected — restore being
 * the case that matters, since it truncates the whole database and then
 * re-inserts servers from the backup file, so the surviving server ids are not
 * known until afterwards. Asked of the rows rather than of the operation, so it
 * cannot miss a server the operation happened to reach indirectly.
 */
export async function markServersWithoutWatchHistory(): Promise<number> {
  const servers = await prisma.mediaServer.findMany({
    where: { watchHistoryClearedAt: null, watchHistory: { none: {} } },
    select: { id: true },
  });
  return markWatchHistoryCleared(servers.map((s) => s.id));
}
