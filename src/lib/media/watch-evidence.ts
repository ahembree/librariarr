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
 * Never writes to a server under a library-resync hold (`requireLibraryResync`):
 * some of its media rows are known to be missing, so no history pass can have
 * attached their plays yet, whatever it found.
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
 *
 * Refused outright while the server is under a library-resync hold, like
 * `markWatchHistoryEstablished`: a pass that ran before the missing items were
 * re-added could not attach their plays.
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
 * **Every path that destroys watch history in bulk has to withdraw it**, not
 * just the one it was written for. `WatchHistory.mediaItem` is a required FK
 * with `onDelete: Cascade`, so the rows are destroyed by more than the obvious
 * route: changing a server's watch-history source (the `/api/servers/[id]` PUT,
 * which deletes them directly and calls this), and every path that deletes the
 * MEDIA in bulk — purging a library or a whole media type, disabling a server
 * with `deleteData`, a full sync removing a vanished library, and restoring a
 * backup (which `TRUNCATE`s every table in `TABLE_ORDER` — `MediaItem` and
 * `WatchHistory` included — before re-inserting only what the file holds, so a
 * config-only backup empties both and refills neither). Those go through
 * `requireLibraryResync`, which withdraws the same way and also holds the
 * marker until the deleted items exist again.
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
 * The hold requests this process has made since each server's hold was last
 * released: how many, and the latest instant asked for.
 *
 * The column keeps the EARLIEST request still unreleased (see
 * `requireLibraryResync`), because that instant is what tells a library the
 * hold waits for from one its cause left alone. What the column therefore
 * cannot say — whether another request arrived after a sync had already begun
 * its library pass, and so may have passed the library that request emptied —
 * is kept here, and both releases check it. In-process is enough, for the same
 * reason as the withdrawal counters: a sync runs inside this process, so a
 * request made before the process started predates every pass it can begin.
 * Pinned to `globalThis` like them.
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

/**
 * Forget the hold requests this process noted — for every server, or for the
 * ones given. For a caller that rewrote the hold column wholesale: a restore
 * re-inserts every server, hold included, from the backup file, so a request
 * noted against the old rows describes nothing now. Left behind, it kept a
 * library enabled afterwards from getting its own population hold's receipt
 * (`requirePopulationResync` refuses one while a request is outstanding), so
 * that hold waited for a full sync.
 */
export function forgetLibraryResyncHoldRequests(serverIds?: string[]): void {
  if (!serverIds) {
    holdRequests.clear();
    return;
  }
  for (const id of serverIds) holdRequests.delete(id);
}

/** Forget every hold request — a process restart, for tests. */
export function _resetLibraryResyncHoldRequestsForTesting(): void {
  holdRequests.clear();
}

/**
 * Record that some of these servers' media rows are known to be MISSING, and
 * that only a complete library sync brings them back — and, until one has, that
 * no pass may vouch for the servers' play history.
 *
 * Called BEFORE items are deleted in bulk (a purge of an enabled library or a
 * type-wide purge, disable-with-delete), after a restore re-inserted servers
 * without their items, by a full sync that removed a vanished library holding
 * items, and by any sync about to populate a library that held no items yet
 * (its first sync, or one enabled later). In every case the items come (back)
 * as fresh rows with none of their plays, and a history pass that ran before
 * they existed could not attach any — a marker it wrote would vouch for a hole,
 * and negative `watchedByUser`, `playCount = 0` and "not played in N months"
 * DELETE rules match exactly the items whose plays are missing. So while the
 * hold is set no marker write succeeds (both helpers above check it, and so
 * does the Tracearr importer's), the evaluability guard refuses the server, and
 * a Tracearr archive walk is held.
 *
 * The steps, in order, each for a reason:
 *  1. A withdrawal is counted first, so a history pass already in flight cannot
 *     write its marker afterwards (`markWatchHistoryEstablishedIfUnchanged`),
 *     and the request is noted (`holdRequests`).
 *  2. The hold is written at `at` (default now) — only where none is set, so
 *     the column keeps the EARLIEST request still unreleased. Every cause
 *     leaves the library it waits on with no item created before its own
 *     instant (a purge or disable-with-delete takes it before deleting, a
 *     restore after re-inserting no items, the population hold at the sync's
 *     pass start before its first insert), which is how a release tells the
 *     libraries it waits for from the rest: a library holding an item older
 *     than the hold was left alone. Moving the hold to a later request would
 *     break that for an earlier one still waiting — a library a failed sync
 *     had half populated would read as one nothing touched. Written before the
 *     marker is nulled, so a crash between the two leaves the hold, which
 *     refuses on its own.
 *  3. The marker is nulled.
 *  4. A Tracearr-mapped server's archive walk restarts from the newest play
 *     (`restartTracearrBackfill`) — on every request, so the walk always starts
 *     from the latest; the hold keeps it from running until the release queues
 *     it.
 *
 * Released by `releaseLibraryResyncHold` (a full sync that completely synced
 * every library the hold waits for), or — for a population hold a
 * library-scoped sync took itself — `releaseOwnPopulationHold`.
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
  // Read in the same synchronous step as the withdrawal above, so they carry
  // this call's own withdrawal and nothing counted after it — what
  // `releaseOwnPopulationHold` compares against.
  const generations = serverIds.map(withdrawalGeneration);
  // Whether any request was still unreleased before this one — even one whose
  // write has not landed yet (it noted itself before writing), which this
  // call's write could otherwise mistake for an unheld server.
  const firstRequests = serverIds.map((id) => !holdRequests.has(id));
  // Noted BEFORE the write, never after: a release that has already checked
  // the registry would otherwise clear a hold this request found set and left
  // as it was (the column keeps the earliest), with nothing to tell it to put
  // the hold back (`settleRelease`). A write that throws wrote nothing, so the
  // note is taken back — only where nothing was noted after it (a later note
  // includes this one; keeping it errs toward refusing a release).
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

/**
 * A population hold the calling sync wrote itself (`requirePopulationResync`),
 * which is what lets a library-scoped sync release it
 * (`releaseOwnPopulationHold`).
 */
export interface PopulationHoldReceipt {
  serverId: string;
  /** The hold's instant — the sync's `libraryPassStartedAt`. */
  at: Date;
  /**
   * The server's withdrawal generation right after this hold counted its own
   * withdrawal: any other withdrawal since (a purge, a restore, a source
   * switch, another hold) moves it.
   */
  generation: string;
}

/**
 * The population hold: `requireLibraryResync([serverId], { at })`, which
 * `syncMediaServer` takes right before it first writes media into a library
 * that held none, at its own `libraryPassStartedAt`.
 *
 * Returns a receipt only when THIS call wrote the hold and no other request was
 * outstanding. `null` means one was already in place, or on its way — a purge,
 * a restore, a disable-with-delete, an earlier population — whose missing items
 * may be in some other library, so only a full sync may release it.
 */
export async function requirePopulationResync(
  serverId: string,
  at: Date,
): Promise<PopulationHoldReceipt | null> {
  const { written, generations, firstRequests } = await writeLibraryResync([serverId], at);
  return written > 0 && firstRequests[0] ? { serverId, at, generation: generations[0] } : null;
}

/**
 * Release a server's library-resync hold (`requireLibraryResync`) once a library
 * sync has brought back what it was waiting for. Returns whether it released one.
 *
 * Called by `syncMediaServer` only for a FULL (unscoped), uncancelled run that
 * completely synced every enabled library the hold waits for — each one holding
 * no item created (a minute or more) before `heldSince`, the hold instant the
 * run read to decide that — after its library loop and before its watch-history
 * phase, with the instant that run began its library pass. A library-scoped
 * sync (the lifecycle executor's post-delete re-sync, the by-type fan-out's
 * per-library jobs) re-adds one library and says nothing about another the
 * purge emptied. (The one hold a scoped sync may release is a population hold
 * it wrote itself: `releaseOwnPopulationHold`.)
 *
 * Refused when the hold is younger than the pass, or when a request this
 * process made is (`holdRequests`): a sync whose library pass began before a
 * purge may have passed the purged library before its items were deleted, and
 * a request on an already-held server leaves the column as it was. The write
 * is a compare-and-set on the hold instant (a hold released and set again in
 * between is a different hold), and a request counted while the write was in
 * flight is put back afterwards (`settleRelease`).
 *
 * Counts a withdrawal FIRST, and nulls the marker in the releasing write. A
 * history pass whose snapshot predates the release may have built its item map
 * before the re-added items existed, so its marker would vouch for plays it
 * could not attach: the bumped generation makes that write refuse, while a pass
 * started after the release sees every item. (The marker is normally null here
 * already — every establishing write refuses while the hold is set.)
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
 * (`requirePopulationResync`), once that run has synced the populated library
 * completely. Returns whether it released it.
 *
 * Enabling a library and syncing just that library is the common way one gets
 * populated, and holding the server's play-activity rules until some later
 * full sync for it paused them for no reason: the items this hold waits for
 * are exactly that library's, and the run has just brought them all. That is
 * true only of a hold nothing else has touched since this run wrote it, so the
 * release requires both:
 *  - no withdrawal counted for the server since the hold was written (a purge,
 *    a restore, a source switch or another hold request in the meantime —
 *    whatever instant it asked for, since the column keeps this run's);
 *  - the hold still exactly this run's instant (compare-and-set on equality),
 *    so a hold released and set again elsewhere is never cleared.
 * A hold that was already in place, or requested, when this run populated the
 * library — an earlier purge, whose items may be in another library — produced
 * no receipt, so it never gets here. The mechanics are
 * `releaseLibraryResyncHold`'s: a withdrawal counted first, the marker nulled
 * in the releasing write, a request that raced the write put back.
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
 * The end of a release whose write cleared the hold. A request counted after
 * the release checked (`countBefore`) found the column still set and left it —
 * the column keeps the earliest request — so the release just cleared it along
 * with the hold it was releasing: put it back, at that request's instant, and
 * report no release. Otherwise forget the requests the release covered.
 * Synchronous from the count's read to the forget, so nothing slips between.
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
 * Restart the Tracearr archive walk for these servers from the newest play.
 *
 * Destroying a server's Tracearr rows does not touch `tracearrBackfillComplete`,
 * and once that is true only the one-hour forward pass runs — so the plays
 * Tracearr still holds for them were never imported again, and their items
 * read as never watched.
 *
 * Moving the resume cursor to now (rather than clearing it) is what restarts
 * the walk from the top while other rows remain: with no cursor the walk
 * resumes below the OLDEST stored row, which after a partial purge is the far
 * end of the archive. It also makes a backfill slice that is running right now
 * discard its own progress write, which expects the cursor it started with.
 * The forward watermark moves to the same instant: with no stored rows the
 * forward pass resumes from it, and every play older than it is the restarted
 * walk's to read. Servers with no Tracearr mapping are untouched.
 *
 * Holds nothing and queues nothing. A caller that DELETED items must go
 * through `requireLibraryResync`, which calls this and also records the hold
 * that keeps the walk from running before a full library sync re-adds those
 * items — walked first, their plays are skipped as unresolved and the walk can
 * complete without them, for good. The one direct caller is a restore whose
 * items came back but whose Tracearr rows did not: the items exist, so the
 * walk may run as soon as the next watch-history sync queues it.
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
  const now = new Date();
  const { count } = await prisma.mediaServer.updateMany({
    where: { id: { in: serverIds }, tracearrServerId: { not: null } },
    // The forward floor goes too: the restarted walk starts at the newest play
    // and covers whatever gap it recorded on its way down. The last-walk stamp
    // goes because it describes a walk of the history that was just destroyed:
    // until the restarted walk runs, "walked and found nothing" is not true.
    data: {
      tracearrBackfillComplete: false,
      tracearrBackfillCursorAt: now,
      tracearrForwardWatermarkAt: now,
      tracearrForwardFloorAt: null,
      // The stamp of the walk that recorded that floor goes with it.
      tracearrForwardFloorRecordedAt: null,
      tracearrBackfillLastWalkAt: null,
    },
  });
  return count;
}
