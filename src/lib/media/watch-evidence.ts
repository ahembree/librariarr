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
 * How many withdrawals this process has made, per server and install-wide.
 *
 * The marker is a nullable timestamp, and a withdrawal writes null — so a
 * withdrawal landing on a server whose marker is ALREADY null (a first sync
 * still in flight, or one that started after an earlier pause) changes nothing
 * a later compare-and-set could see. These counters make that null → null
 * withdrawal visible. In-process is enough: the worker runs inside the app
 * process, every withdrawal goes through the helpers below, and a sync that
 * spans a restart dies with the process anyway. Pinned to `globalThis` because
 * the writers (route bundles) and the reader (the job worker) are different
 * module instances under Next.js.
 */
interface WithdrawalCounters {
  all: number;
  perServer: Map<string, number>;
}
const globalForEvidence = globalThis as unknown as {
  __watchEvidenceWithdrawals?: WithdrawalCounters;
};
const withdrawals: WithdrawalCounters = (globalForEvidence.__watchEvidenceWithdrawals ??= {
  all: 0,
  perServer: new Map(),
});

function recordWithdrawal(serverIds: string[] | "all"): void {
  if (serverIds === "all") {
    withdrawals.all++;
    return;
  }
  for (const id of serverIds) {
    withdrawals.perServer.set(id, (withdrawals.perServer.get(id) ?? 0) + 1);
  }
}

function withdrawalGeneration(serverId: string): string {
  return `${withdrawals.all}:${withdrawals.perServer.get(serverId) ?? 0}`;
}

/**
 * What a sync saw of a server's marker when it STARTED — handed back to
 * `markWatchHistoryEstablishedIfUnchanged` when it finishes.
 */
export interface WatchEvidenceSnapshot {
  serverId: string;
  /** `watchHistorySyncedAt` as read at the start of the run. */
  marker: Date | null;
  generation: string;
}

/**
 * Capture the marker at the start of a sync. `marker` must come from the same
 * read the sync starts from (it is not re-read here, so a caller that already
 * loads the server row pays no extra query).
 */
export function snapshotWatchEvidence(
  serverId: string,
  marker: Date | null | undefined,
): WatchEvidenceSnapshot {
  return { serverId, marker: marker ?? null, generation: withdrawalGeneration(serverId) };
}

/**
 * `markWatchHistoryEstablished` for a sync that may have been overtaken by a
 * withdrawal while it ran. Returns whether the marker was written.
 *
 * An unconditional write lost the withdrawal: a native full replace takes
 * tens of seconds of fetching before it writes, and a purge, a source switch or
 * a disable-with-delete landing in that window destroyed rows and withdrew the
 * marker — which the finishing sync then put straight back, vouching for a
 * history it never saw. Two checks, because each covers what the other cannot:
 *
 *  - The UPDATE is a compare-and-set on the marker the run started with, which
 *    catches any established → null withdrawal, from any writer.
 *  - The withdrawal counters catch a null → null one, which leaves the column
 *    unchanged. They are read before the write (skip early) and again after it,
 *    and a withdrawal counted in between is undone by putting the marker back
 *    to null — but only if it still holds the value this call wrote. Because a
 *    withdrawal counts BEFORE it writes null, every interleaving ends null.
 *
 * Losing a race with another sync that marked first fails the compare as well;
 * that is harmless, since the marker is then already set.
 */
export async function markWatchHistoryEstablishedIfUnchanged(
  snapshot: WatchEvidenceSnapshot,
): Promise<boolean> {
  const { serverId, marker, generation } = snapshot;
  if (withdrawalGeneration(serverId) !== generation) return false;
  const now = new Date();
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: serverId, watchHistorySyncedAt: marker },
    data: { watchHistorySyncedAt: now },
  });
  if (count === 0) return false;
  if (withdrawalGeneration(serverId) !== generation) {
    await prisma.mediaServer.updateMany({
      where: { id: serverId, watchHistorySyncedAt: now },
      data: { watchHistorySyncedAt: null },
    });
    return false;
  }
  return true;
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
  // Counted before the write, and even for a server whose marker is already
  // null, so a sync in flight cannot re-mark it (`markWatchHistoryEstablishedIfUnchanged`).
  recordWithdrawal(serverIds);
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
  // The caller rewrote the whole database (restore), so no sync that started
  // before it may vouch for what it now holds — whichever servers the query
  // below happens to find.
  recordWithdrawal("all");
  const servers = await prisma.mediaServer.findMany({
    where: { watchHistorySyncedAt: { not: null }, watchHistory: { none: {} } },
    select: { id: true },
  });
  return invalidateWatchHistoryEvidence(servers.map((s) => s.id));
}

/**
 * Restart the Tracearr archive walk for these servers from the newest play.
 *
 * The companion to `invalidateWatchHistoryEvidence` for a Tracearr-mapped
 * server, called from the paths that destroy its rows in bulk: purge,
 * disable-with-delete, a restore whose file lacked the server's Tracearr rows,
 * and a full sync that removed a vanished library holding imported plays. Destroying a server's
 * rows does not touch `tracearrBackfillComplete`, and once that is true only the
 * one-hour forward pass runs — so the purged items' plays, which Tracearr still
 * holds, were never imported again and the items read as never watched.
 *
 * Moving the resume cursor to now (rather than clearing it) is what restarts
 * the walk from the top while other rows remain: with no cursor the walk
 * resumes below the OLDEST stored row, which after a partial purge is the far
 * end of the archive. It also makes a backfill slice that is running right now
 * discard its own progress write, which expects the cursor it started with.
 * Servers with no Tracearr mapping are untouched.
 *
 * Deliberately queues NOTHING. Every caller has just removed items whose plays
 * the restarted walk exists to bring back, and only a sync re-creates them: a
 * walk run first skips those plays as unresolved and, on reaching the end,
 * marks the archive complete without them — for good (a purge of one library
 * leaves the server's others populated, so the importer's empty-library gate
 * does not stop it). The next watch-history sync queues the walk; until then
 * the status route reports `awaiting-sync`, and `enqueueTracearrBackfill`
 * refuses a server in this state (cursor moved, no walk since).
 */
export async function restartTracearrBackfill(serverIds: string[]): Promise<number> {
  if (serverIds.length === 0) return 0;
  // A slice running right now keeps walking from its old, deep position, and
  // its live reach would beat the cursor moved to "now" below in the status
  // readout. Marked first: the mark is sticky, so no page it commits after
  // this can bring the stale reach back. Imported lazily — the registry is a
  // leaf module pinned to `globalThis`, so this is the same instance the
  // importer writes.
  const { supersedeTracearrImports } = await import("@/lib/sync/tracearr-import-activity");
  for (const id of serverIds) supersedeTracearrImports(id);
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: { in: serverIds }, tracearrServerId: { not: null } },
    // The forward floor goes too: the restarted walk starts at the newest play
    // and covers whatever gap it recorded on its way down. The last-walk stamp
    // goes because it describes a walk of the history that was just destroyed:
    // until the restarted walk runs, "walked and found nothing" is not true.
    data: {
      tracearrBackfillComplete: false,
      tracearrBackfillCursorAt: new Date(),
      tracearrForwardFloorAt: null,
      tracearrBackfillLastWalkAt: null,
    },
  });
  return count;
}
