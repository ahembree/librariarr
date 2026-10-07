/**
 * Progress arithmetic and the "is it still importing" policy for the Tracearr
 * history backfill.
 *
 * Lives beside the route rather than inside it because a `route.ts` may only
 * export route handlers and Next's route config fields — a runtime export of
 * anything else fails the build's route-type check. Keeping it here also lets
 * the tests drive the edge cases directly instead of only through HTTP.
 */

/**
 * The instant the backwards walk has reached — the same point the fraction
 * measures from and the "reached <date>" text names, so the two can never
 * disagree. `null` when nothing has been reached yet.
 *
 * Stored reach first: `tracearrBackfillCursorAt` when set (it also counts
 * stretches of history that could not be stored, and after a purge restarts the
 * walk `restartTracearrBackfill` moves it to now — the rows that survived the
 * purge still reach back to the far end, so measuring by them reported a full
 * bar, and a "reached 2019" line, for a walk that had only just started again),
 * otherwise the oldest imported row.
 *
 * Then the live run, when it is further back. The cursor is written once per
 * five-minute slice, at its end, and the rows only move when a page held
 * something storable — so between those writes the stored reach stands still
 * while the walk visibly pages on, and the bar froze for each slice. The live
 * run's `backfillReached` is the cursor's own measure, recorded after each
 * page commits, so it is as safe to measure by. Only the BACKFILL pass's reach
 * counts (the forward pass never writes it): the forward pass walks the newest
 * hour, which says nothing about how far back the archive is covered — and
 * "only if older" keeps a live figure from ever moving the reach forwards.
 */
export function resolveBackfillReach(input: {
  oldestImported: Date | null;
  cursorAt?: Date | null;
  /** The live backfill run's oldest reached play, when one is running. */
  liveReached?: Date | null;
}): Date | null {
  const stored = input.cursorAt ?? input.oldestImported;
  const live = input.liveReached ?? null;
  if (live && (!stored || live < stored)) return live;
  return stored;
}

/**
 * How far the backwards walk has got, as 0..1 — or `null` when that is not yet
 * knowable.
 *
 * ## Why the denominator is a TIME SPAN and not a record count
 *
 * The obvious formula — imported rows / rows Tracearr holds — is not merely
 * unavailable, it is *wrong*, and both halves of that matter:
 *
 * 1. Unavailable: Tracearr's history API is keyset-paginated with no total and
 *    no count endpoint. There is nothing to divide by without paging the entire
 *    archive first, which is the very work the bar is meant to be measuring.
 * 2. Wrong even if it existed: `WatchHistory.mediaItemId` is a REQUIRED foreign
 *    key, so a play whose media has since been deleted from the library
 *    structurally cannot be stored. Tracearr keeps its own copies of titles and
 *    so retains that history; librariarr cannot. On the reference instance ~41%
 *    of pre-2023 plays resolved to nothing (one slice logged `18144 new … skipped
 *    12625 unresolved`), which is why a 160k-play archive lands as ~106k rows.
 *    A record ratio would therefore stall near 0.6 and never reach 1 on a
 *    backfill that is genuinely, verifiably finished.
 *
 * Time coverage has neither problem. `findOldestPlayAt` measures the far edge
 * once (a ~19-call bisection, not a 1,600-page walk), and the walk really does
 * travel from `newestImported` to that edge, so the fraction of the span already
 * covered reaches exactly 1 when the walk lands — skipped-and-unresolvable plays
 * do not move either boundary. If you are here to "fix" this into a row ratio:
 * that is the thing that cannot reach 100%.
 *
 * `null` and `0` are different answers and callers must not conflate them:
 * `null` means "cannot know yet — render an indeterminate bar", `0` means
 * "known, and nothing of the span is covered".
 */
export function computeBackfillFraction(input: {
  /** `MediaServer.tracearrBackfillComplete` — the walk reached the far edge. */
  backfillComplete: boolean;
  /** `MediaServer.tracearrOldestPlayAt` — measured once, may not be measured yet. */
  oldestPlayAt: Date | null;
  /** MIN(`watchedAt`) over this server's imported rows. */
  oldestImported: Date | null;
  /** MAX(`watchedAt`) over this server's imported rows. */
  newestImported: Date | null;
  /**
   * `MediaServer.tracearrBackfillCursorAt` — how far back the walk has actually
   * reached. See `resolveBackfillReach`.
   */
  cursorAt?: Date | null;
  /** The live backfill run's reach, when one is running — see `resolveBackfillReach`. */
  liveReached?: Date | null;
}): number | null {
  // The flag is the authority, not the arithmetic. The walk stops when a slice
  // comes back empty, which can happen while the oldest *storable* play is still
  // some distance newer than the oldest play Tracearr holds (that whole tail may
  // reference deleted media). Recomputing a fraction there would report ~0.97
  // forever on a finished import.
  if (input.backfillComplete) return 1;

  // Nothing measured, or nothing imported: the span is undefined rather than
  // empty. A freshly mapped server sits here until the first pass lands.
  if (!input.oldestPlayAt || !input.oldestImported || !input.newestImported) {
    return null;
  }

  const newest = input.newestImported.getTime();
  const span = newest - input.oldestPlayAt.getTime();

  // Zero (the single imported play IS the oldest play) or negative (measurement
  // taken against a Tracearr instance that has since been pruned) — either way
  // there is no span to be a fraction of, and dividing gives Infinity/NaN.
  if (span <= 0) return null;

  // Never null here: `oldestImported` is set.
  const reached = resolveBackfillReach(input) ?? input.oldestImported;
  const covered = newest - reached.getTime();

  // Clamped, not asserted: the measurement and the import are separate passes,
  // so a play older than `oldestPlayAt` can legitimately already be imported
  // (it arrived on the forward pass, or Tracearr grew older history after the
  // bisection ran). That is a >1 ratio, not a bug — report a full bar.
  return Math.min(1, Math.max(0, covered / span));
}

/**
 * Why an owed import is not progressing, when that is the reason it is not
 * pending. The first two lift only when the user re-enables something;
 * `no-library-items` when a library sync adds items to an enabled library
 * (which may need the user to enable one — the importer will not walk into an
 * empty library); the last two lift without the user: `import-failing` when
 * the next watch-history sync re-queues the slice (a keyed enqueue gives a
 * parked job a fresh set of attempts — so does saving or re-enabling the
 * Tracearr instance, `enqueueTracearrBackfill`), and `awaiting-sync` when a
 * sync queues the slice — the library sync that releases the library-resync
 * hold, or with none set the next watch-history sync (see
 * `importAwaitingSync`).
 */
export type ImportPausedReason =
  | "server-disabled"
  | "instance-unavailable"
  | "no-library-items"
  | "import-failing"
  | "awaiting-sync";

/** What the route knows about the import beyond the stored rows. */
export interface ImportStateInput {
  backfillComplete: boolean;
  importedCount: number;
  oldestPlayAt: Date | null;
  cursorAt: Date | null;
  lastWalkAt: Date | null;
  /**
   * `libraryResyncRequiredAt`: since when some of the server's items are known
   * to be missing — a purge, a restore, disable-with-delete, a vanished
   * library, or a library being populated for the first time
   * (`requireLibraryResync`) — while no library sync has released it: a full
   * sync that brought every needed library back, or the library-scoped sync
   * that took a library's own population hold. The importer holds the archive
   * walk meanwhile. Optional so a caller that does not read it treats the walk
   * as not held.
   */
  resyncRequiredAt?: Date | null;
  /** An import of this server is running in this process right now. */
  running: boolean;
  /** Its `tracearr-backfill:<id>` job is waiting, running or backing off. */
  queued: boolean;
  /**
   * The job table was read. False when it could not be (no `graphile_worker`
   * schema yet): `queued` is then unknown rather than false. Optional so a
   * caller that never reads the table keeps the evidence-based answer.
   */
  jobsKnown?: boolean;
}

/**
 * A walk ran, nothing came back, and there is no other sign the mapping has
 * history: the keyset was exhausted with zero records, which deliberately
 * neither marks the backfill complete nor re-enqueues — a wrong mapping, or a
 * Tracearr holding no plays for it.
 *
 * Whatever the resume cursor says. A restart (`restartTracearrBackfill`) moves
 * it to the restart instant and a walk that then finds nothing never moves it
 * again, so requiring it to be null read every restarted walk of such a
 * mapping — and every config-only restore of one — as "starts after the next
 * full sync", for good. A mapping that does have plays shows them here
 * through its imported rows or its measured far edge (`oldestPlayAt`, taken
 * before a backfill's first page).
 */
function walkedAndEmpty(input: ImportStateInput): boolean {
  return (
    input.lastWalkAt !== null &&
    input.importedCount === 0 &&
    input.oldestPlayAt === null
  );
}

/**
 * Whether the import is owed and waits on a sync rather than on a job.
 *
 * Always, while the library-resync hold is set (`resyncRequiredAt`): some of
 * the server's items are missing (a purge, a restore, disable-with-delete, a
 * vanished library, a library populated for the first time), so the walk has
 * to follow the library sync that brings them back — a full sync that brought
 * every needed library back, or the library-scoped sync that took a library's
 * own population hold — and until one releases the hold a queued slice only
 * no-ops and nothing queues one early (`enqueueTracearrBackfill` refuses).
 * Queued or not, it is waiting.
 *
 * Otherwise when nothing is queued: no slice waiting, running or parked, and
 * not the walked-and-empty end state. The next watch-history sync queues one
 * (`syncWatchHistory` enqueues the backfill on every Tracearr run) — a fresh
 * mapping before its first sync, a slice the importer turned away for an
 * empty library, or an enqueue that failed. Reported as `pending` before,
 * these read "Still importing…" beside a spinner and were polled with nothing
 * queued. Only when the job table was read (unread, "nothing queued" is not
 * known), and not for a parked job, which is `import-failing`.
 */
export function importAwaitingSync(input: ImportStateInput & { parked: boolean }): boolean {
  if (input.backfillComplete) return false;
  if (input.resyncRequiredAt != null) return true;
  return (
    input.jobsKnown === true &&
    !input.running &&
    !input.queued &&
    !input.parked &&
    !walkedAndEmpty(input)
  );
}

/**
 * The reason, if any, an owed import is not progressing — see
 * `ImportPausedReason`. In precedence order: a disabled server or no enabled
 * Tracearr instance (nothing runs at all); the library-resync hold (the
 * library sync that releases it is what comes next, even if the libraries are
 * empty right now — it is the sync that refills them); no items in any enabled
 * library (every slice is turned away, so a parked job from before is not the
 * cause); a parked slice; nothing queued.
 */
export function importPausedReason(
  input: ImportStateInput & {
    serverEnabled: boolean;
    instanceEnabled: boolean;
    /** Whether any of the server's enabled libraries holds an item. */
    hasLibraryItems: boolean;
    /** The slice's job is parked and nothing is running or queued. */
    failing: boolean;
  },
): ImportPausedReason | null {
  if (!input.serverEnabled) return "server-disabled";
  if (!input.instanceEnabled) return "instance-unavailable";
  if (input.backfillComplete) return null;
  if (input.resyncRequiredAt != null) return "awaiting-sync";
  if (!input.hasLibraryItems) return "no-library-items";
  if (input.failing) return "import-failing";
  return importAwaitingSync({ ...input, parked: input.failing }) ? "awaiting-sync" : null;
}

/**
 * Whether this server's archive import is genuinely still owed AND will make
 * progress — the signal a spinner or a poll may wait on.
 *
 * Not owed: `backfillComplete`. Cannot progress: any `pausedReason` — the
 * server is disabled (no sync of any kind runs for it), the user has no
 * enabled Tracearr instance (`syncWatchHistory` then skips a mapped server
 * outright rather than falling back to native), the slice keeps failing (its
 * job used up every attempt and is parked, and nothing is running — an
 * instance that no longer monitors the mapping, an account list that cannot
 * be read), or nothing is queued and the import waits for the next sync
 * (`importAwaitingSync`). All are reported with `pausedReason` (see the route)
 * so Settings can say why instead of spinning: imported rows used to be enough
 * to read "pending", so a mapping that could never progress again showed
 * "importing" and was polled forever. With several instances, which one owns
 * the mapping is only knowable by asking each over the network, which a polled
 * route must not do — "at least one enabled" is the approximation, and an
 * unowned mapping then fails its slices and lands in the parked case.
 *
 * Otherwise pending while a slice is running or queued. A fresh mapping has
 * one queued by the save that made it (`enqueueTracearrBackfill`).
 *
 * A mapping that HAS been walked, with nothing running or queued and nothing
 * to show for it, is not pending (the walked-and-empty end state). When the
 * job table could not be read (`jobsKnown` not true), the stored evidence
 * stands in for it: a never-walked mapping, imported rows, a measured far edge
 * or a cursor read pending.
 */
export function importPending(input: ImportStateInput & { pausedReason: ImportPausedReason | null }): boolean {
  if (input.pausedReason !== null || input.backfillComplete) return false;
  if (input.running || input.queued) return true;
  if (walkedAndEmpty(input)) return false;
  if (input.jobsKnown === true) return false;
  return (
    input.lastWalkAt === null ||
    input.importedCount > 0 ||
    input.oldestPlayAt !== null ||
    input.cursorAt !== null
  );
}
