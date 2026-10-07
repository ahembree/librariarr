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
 * pending. The first two lift only when the user re-enables something; the
 * other two lift without the user: `import-failing` when the next
 * watch-history sync re-queues the slice (a keyed enqueue gives a parked job a
 * fresh set of attempts — so does saving or re-enabling the Tracearr instance,
 * `enqueueTracearrBackfill`), and `awaiting-sync` when the next watch-history
 * sync queues the first slice.
 */
export type ImportPausedReason =
  | "server-disabled"
  | "instance-unavailable"
  | "import-failing"
  | "awaiting-sync";

/** What the route knows about the import beyond the stored rows. */
export interface ImportStateInput {
  backfillComplete: boolean;
  importedCount: number;
  oldestPlayAt: Date | null;
  cursorAt: Date | null;
  lastWalkAt: Date | null;
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
 */
function walkedAndEmpty(input: ImportStateInput): boolean {
  return (
    input.lastWalkAt !== null &&
    input.importedCount === 0 &&
    input.oldestPlayAt === null &&
    input.cursorAt === null
  );
}

/**
 * Whether the import is owed but simply has nothing queued: no slice waiting,
 * running or parked, and not the walked-and-empty end state. The next
 * watch-history sync queues one (`syncWatchHistory` enqueues the backfill on
 * every Tracearr run). Every state that can sit here is legitimately waiting
 * on that sync rather than on a job:
 *  - after `restartTracearrBackfill` (a purge, a restore): the walk has to
 *    follow the re-sync that brings the purged items back, so nothing queues
 *    it early (`enqueueTracearrBackfill` refuses);
 *  - a mapping on a server whose libraries hold no items yet;
 *  - a slice the importer turned away for an empty library;
 *  - an enqueue that failed.
 * Reported as `pending` before, these read "Still importing…" beside a spinner
 * and were polled with nothing queued.
 *
 * Only when the job table was read: unread, "nothing queued" is not known.
 * Not for a parked job, which is `import-failing`.
 */
export function importAwaitingSync(input: ImportStateInput & { parked: boolean }): boolean {
  return (
    input.jobsKnown === true &&
    !input.backfillComplete &&
    !input.running &&
    !input.queued &&
    !input.parked &&
    !walkedAndEmpty(input)
  );
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
