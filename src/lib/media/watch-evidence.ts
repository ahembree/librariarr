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
 *
 * Refused while a library-resync hold is set (`requireLibraryResync`): a pass
 * run before the missing items were re-added cannot have attached their plays.
 */
export async function markWatchHistoryEstablished(serverIds: string[]): Promise<number> {
  if (serverIds.length === 0) return 0;
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: { in: serverIds }, libraryResyncRequiredAt: null },
    data: { watchHistorySyncedAt: new Date() },
  });
  return count;
}

/**
 * Withdrawals this process has made, per server and install-wide. A withdrawal
 * onto a marker that is already null changes nothing a compare-and-set could
 * see; these counters make it visible. In-process suffices (a sync dies with its
 * process); pinned to `globalThis` because route bundles and the job worker are
 * different module instances.
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

/** Capture the marker at the start of a sync; `marker` must be the value the sync started from. */
export function snapshotWatchEvidence(
  serverId: string,
  marker: Date | null | undefined,
): WatchEvidenceSnapshot {
  return { serverId, marker: marker ?? null, generation: withdrawalGeneration(serverId) };
}

/**
 * `markWatchHistoryEstablished` for a sync a withdrawal may have overtaken while
 * it ran (a purge or source switch during a long fetch). Returns whether the
 * marker was written. Two checks, each covering what the other cannot:
 *  - a compare-and-set on the marker the run started with (established → null);
 *  - the withdrawal counters (null → null), read before and after the write; a
 *    withdrawal counted in between is undone by nulling the marker again if it
 *    still holds this call's value. Withdrawals count BEFORE writing null, so
 *    every interleaving ends null.
 * Refused while a library-resync hold is set, like `markWatchHistoryEstablished`.
 */
export async function markWatchHistoryEstablishedIfUnchanged(
  snapshot: WatchEvidenceSnapshot,
): Promise<boolean> {
  const { serverId, marker, generation } = snapshot;
  if (withdrawalGeneration(serverId) !== generation) return false;
  const now = new Date();
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: serverId, watchHistorySyncedAt: marker, libraryResyncRequiredAt: null },
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
 * **Every path that destroys watch history in bulk has to withdraw it.**
 * `WatchHistory.mediaItem` cascades, so besides a source switch (the
 * `/api/servers/[id]` PUT, which deletes the rows and calls this) every bulk
 * delete of MEDIA destroys plays — a purge, disable-with-`deleteData`, a
 * vanished library, a restore. Those go through `requireLibraryResync`, which
 * withdraws the same way and also holds the marker until the items exist again.
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
  // A restore rewrote the database: no sync that started before it may vouch for any server.
  recordWithdrawal("all");
  const servers = await prisma.mediaServer.findMany({
    where: { watchHistorySyncedAt: { not: null }, watchHistory: { none: {} } },
    select: { id: true },
  });
  return invalidateWatchHistoryEvidence(servers.map((s) => s.id));
}

/**
 * Hold requests made since each server's hold was last released: how many, and
 * the latest instant asked for. The column keeps the EARLIEST request
 * (`requireLibraryResync`), so it cannot say whether another arrived after a
 * sync began its library pass — which both releases must refuse. In-process and
 * on `globalThis`, like the withdrawal counters.
 */
interface HoldRequests {
  count: number;
  /** Epoch ms of the latest instant requested. */
  latestAt: number;
}
const globalForHolds = globalThis as unknown as {
  __libraryResyncHoldRequests?: Map<string, HoldRequests>;
};
const holdRequests: Map<string, HoldRequests> = (globalForHolds.__libraryResyncHoldRequests ??= new Map());

function noteHoldRequest(serverIds: string[], at: Date): void {
  for (const id of serverIds) {
    const prior = holdRequests.get(id);
    holdRequests.set(id, {
      count: (prior?.count ?? 0) + 1,
      latestAt: Math.max(prior?.latestAt ?? Number.NEGATIVE_INFINITY, at.getTime()),
    });
  }
}

/** Forget noted hold requests (all, or the given servers') — for a restore, which rewrites the hold column. */
export function forgetLibraryResyncHoldRequests(serverIds?: string[]): void {
  if (!serverIds) {
    holdRequests.clear();
    return;
  }
  for (const id of serverIds) holdRequests.delete(id);
}

/**
 * Whether an outstanding hold request asks for an instant after `since`. A
 * library pass that began at `since` ran beside that request's delete or
 * restore, so it records no `Library.shortPassSeenAt`.
 */
export function libraryResyncRequestedSince(serverId: string, since: Date): boolean {
  const requests = holdRequests.get(serverId);
  return requests !== undefined && requests.latestAt > since.getTime();
}

/** Forget every hold request — a process restart, for tests. */
export function _resetLibraryResyncHoldRequestsForTesting(): void {
  holdRequests.clear();
}

/**
 * Record that some of these servers' media rows are MISSING until a complete
 * library sync brings them back. The items return with none of their plays, so
 * meanwhile no marker write succeeds, the evaluability guard refuses the server
 * and a Tracearr walk is held. Callers that delete take it BEFORE deleting, so a
 * history pass already running cannot vouch for the gap.
 *
 * Steps, in order:
 *  1. Count a withdrawal (a pass in flight cannot mark after it) and note the
 *     request (`holdRequests`).
 *  2. Write the hold at `at` (default now) only where none is set, keeping the
 *     EARLIEST unreleased request: every cause leaves its library with no item
 *     created before its own instant, which is how a release tells awaited
 *     libraries from untouched ones, and a later instant would make a
 *     half-populated library read as untouched. Before the marker is nulled, so
 *     a crash between them still refuses.
 *  3. Null the marker.
 *  4. Restart a mapped server's archive walk (`restartTracearrBackfill`).
 *
 * Released by `releaseLibraryResyncHold`, or `releaseOwnPopulationHold` for a
 * population hold a scoped sync took itself.
 */
export async function requireLibraryResync(
  serverIds: string[],
  opts: { at?: Date } = {},
): Promise<void> {
  if (serverIds.length === 0) return;
  await writeLibraryResync(serverIds, opts.at ?? new Date());
}

/** `requireLibraryResync`'s steps; see there. */
async function writeLibraryResync(
  serverIds: string[],
  at: Date,
): Promise<{ written: number; generations: string[]; firstRequests: boolean[] }> {
  recordWithdrawal(serverIds);
  // Same synchronous step as the withdrawal: this call's own and nothing later
  // (what `releaseOwnPopulationHold` compares against).
  const generations = serverIds.map(withdrawalGeneration);
  // Any request still unreleased before this one, even one not yet written.
  const firstRequests = serverIds.map((id) => !holdRequests.has(id));
  // Noted BEFORE the write, so a release already past its registry check puts
  // the hold back (`settleRelease`). A write that throws takes its note back,
  // unless a later note (which includes it) was made since.
  const priors = serverIds.map((id) => holdRequests.get(id));
  noteHoldRequest(serverIds, at);
  const notes = serverIds.map((id) => holdRequests.get(id));
  let written: number;
  try {
    ({ count: written } = await prisma.mediaServer.updateMany({
      where: { id: { in: serverIds }, libraryResyncRequiredAt: null },
      data: { libraryResyncRequiredAt: at },
    }));
  } catch (error) {
    serverIds.forEach((id, i) => {
      if (holdRequests.get(id) !== notes[i]) return;
      const prior = priors[i];
      if (prior) holdRequests.set(id, prior);
      else holdRequests.delete(id);
    });
    throw error;
  }
  await prisma.mediaServer.updateMany({
    where: { id: { in: serverIds }, watchHistorySyncedAt: { not: null } },
    data: { watchHistorySyncedAt: null },
  });
  await restartTracearrBackfill(serverIds);
  return { written, generations, firstRequests };
}

/** A population hold the calling sync wrote itself — what lets a scoped sync release it. */
export interface PopulationHoldReceipt {
  serverId: string;
  /** The hold's instant — the sync's `libraryPassStartedAt`. */
  at: Date;
  /** Withdrawal generation right after this hold's own withdrawal; any later one moves it. */
  generation: string;
}

/**
 * The population hold `syncMediaServer` takes at its `libraryPassStartedAt`,
 * right before it first writes media into a library that held none. Returns a
 * receipt only when this call wrote the hold and no other request was
 * outstanding: any other hold may wait on another library, so only a full sync
 * releases it.
 */
export async function requirePopulationResync(
  serverId: string,
  at: Date,
): Promise<PopulationHoldReceipt | null> {
  const { written, generations, firstRequests } = await writeLibraryResync([serverId], at);
  return written > 0 && firstRequests[0] ? { serverId, at, generation: generations[0] } : null;
}

/**
 * Release a library-resync hold after a FULL, uncancelled sync completely synced
 * every enabled library it waits for (called after the library loop, before the
 * watch-history phase). Returns whether it released one.
 *
 * Refused when the hold, or a request noted here (`holdRequests`), is younger
 * than the pass: the pass may have gone by a purged library before its delete.
 * Compare-and-set on the hold instant; a request counted during the write is put
 * back (`settleRelease`). Counts a withdrawal FIRST and nulls the marker in the
 * same write, so a history pass whose item map predates the re-added items
 * cannot mark.
 */
export async function releaseLibraryResyncHold(
  serverId: string,
  libraryPassStartedAt: Date,
  heldSince?: Date,
): Promise<boolean> {
  let hold = heldSince ?? null;
  if (!hold) {
    const row = await prisma.mediaServer.findUnique({
      where: { id: serverId },
      select: { libraryResyncRequiredAt: true },
    });
    hold = row?.libraryResyncRequiredAt ?? null;
  }
  if (!hold || hold.getTime() > libraryPassStartedAt.getTime()) return false;
  const requests = holdRequests.get(serverId);
  if (requests && requests.latestAt > libraryPassStartedAt.getTime()) return false;
  recordWithdrawal([serverId]);
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: serverId, libraryResyncRequiredAt: hold },
    data: { libraryResyncRequiredAt: null, watchHistorySyncedAt: null },
  });
  if (count === 0) return false;
  return settleRelease(serverId, requests?.count ?? 0);
}

/**
 * Release a population hold the calling LIBRARY-SCOPED sync took itself
 * (`requirePopulationResync`) once it has synced that library completely — the
 * hold waits for exactly that library. Only if nothing touched it since: no
 * withdrawal counted for the server since it was written, and still this run's
 * instant (compare-and-set on equality). Otherwise as `releaseLibraryResyncHold`.
 */
export async function releaseOwnPopulationHold(receipt: PopulationHoldReceipt): Promise<boolean> {
  const { serverId, at, generation } = receipt;
  if (withdrawalGeneration(serverId) !== generation) return false;
  const requests = holdRequests.get(serverId);
  recordWithdrawal([serverId]);
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: serverId, libraryResyncRequiredAt: at },
    data: { libraryResyncRequiredAt: null, watchHistorySyncedAt: null },
  });
  if (count === 0) return false;
  return settleRelease(serverId, requests?.count ?? 0);
}

/**
 * After a release's write: a request counted since the release checked
 * (`countBefore`) found the hold set and left it, so the write cleared it too —
 * put it back at that request's instant and report no release. Otherwise forget
 * the covered requests. Synchronous from the read to the forget.
 */
async function settleRelease(serverId: string, countBefore: number): Promise<boolean> {
  const requests = holdRequests.get(serverId);
  if ((requests?.count ?? 0) === countBefore) {
    holdRequests.delete(serverId);
    return true;
  }
  await prisma.mediaServer.updateMany({
    where: { id: serverId, libraryResyncRequiredAt: null },
    data: { libraryResyncRequiredAt: new Date(requests!.latestAt) },
  });
  return false;
}

/**
 * Restart the Tracearr archive walk for these servers from the newest play: a
 * complete walk runs only the one-hour forward pass, so destroyed plays would
 * never be imported again.
 *
 * Moving the resume cursor to now (rather than clearing it) is what restarts
 * the walk from the top while other rows remain: with no cursor the walk
 * resumes below the OLDEST stored row, which after a partial purge is the far
 * end of the archive. It also makes a backfill slice that is running right now
 * discard its own progress write, which expects the cursor it started with.
 * The forward watermark moves to the same instant (a no-rows archive's forward
 * pass resumes from it). Unmapped servers are untouched. Holds and queues
 * nothing: called only by `writeLibraryResync`, whose hold keeps the walk from
 * running before the missing items exist (walked first, their plays are skipped
 * for good).
 */
export async function restartTracearrBackfill(serverIds: string[]): Promise<number> {
  if (serverIds.length === 0) return 0;
  // A running slice's deep live reach would beat the cursor moved to "now" in
  // the status readout; the mark is sticky. Imported lazily (a `globalThis` leaf).
  const { supersedeTracearrImports } = await import("@/lib/sync/tracearr-import-activity");
  for (const id of serverIds) supersedeTracearrImports(id);
  const now = new Date();
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: { in: serverIds }, tracearrServerId: { not: null } },
    // The restarted walk covers any recorded forward gap, and the last-walk
    // stamp described the destroyed history ("walked and found nothing").
    data: {
      tracearrBackfillComplete: false,
      tracearrBackfillCursorAt: now,
      tracearrForwardWatermarkAt: now,
      tracearrForwardFloorAt: null,
      tracearrForwardFloorRecordedAt: null,
      tracearrBackfillLastWalkAt: null,
    },
  });
  return count;
}
