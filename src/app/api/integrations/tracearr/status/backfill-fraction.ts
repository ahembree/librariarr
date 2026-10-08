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
 * The instant the backwards walk has reached — what the fraction measures from
 * and the "reached <date>" text names, so the two cannot disagree; `null` when
 * nothing has been reached. The stored reach is `tracearrBackfillCursorAt` when
 * set (it counts unstorable stretches too, and a restart moves it to now while
 * a purge's surviving rows still reach the far end), else the oldest imported
 * row. The live BACKFILL run's reach replaces it when further back, since the
 * cursor is written only at slice end; "only if older" keeps a live figure
 * from ever moving the reach forwards.
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
 * Why an owed import is not progressing. `server-disabled` and
 * `instance-unavailable` lift only when the user re-enables something;
 * `no-library-items` when a library sync adds items to an enabled library;
 * `import-failing` when the slice is re-queued (the next watch-history sync, or
 * a save through `enqueueTracearrBackfill`); `awaiting-sync` when a sync queues
 * the slice (see `importAwaitingSync`).
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
   * `libraryResyncRequiredAt` (see `requireLibraryResync`): items are known to be
   * missing and the importer holds the archive walk. Optional: a caller that does
   * not read it treats the walk as not held.
   */
  resyncRequiredAt?: Date | null;
  /** An import of this server is running in this process right now. */
  running: boolean;
  /** Its `tracearr-backfill:<id>` job is waiting, running or backing off. */
  queued: boolean;
  /** The job table was read (else `queued` is unknown and the stored evidence decides). */
  jobsKnown?: boolean;
}

/**
 * A walk ran, nothing came back, and nothing else shows the mapping has history
 * (no imported rows, no measured far edge): a wrong mapping, or a Tracearr with
 * no plays for it — which deliberately neither completes nor re-enqueues.
 * Whatever the cursor says: a restart moves it to now and an empty walk never
 * moves it again, so requiring it null read such a walk as waiting for good.
 */
function walkedAndEmpty(input: ImportStateInput): boolean {
  return (
    input.lastWalkAt !== null &&
    input.importedCount === 0 &&
    input.oldestPlayAt === null
  );
}

/**
 * Whether the import is owed and waits on a sync rather than on a job: always
 * while the library-resync hold is set (a queued slice only no-ops until the
 * releasing library sync, which queues the walk); otherwise when the job table
 * was read and nothing is waiting, running or parked, and it is not the
 * walked-and-empty end state — the next watch-history sync queues one.
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
 * The reason, if any, an owed import is not progressing, in precedence order:
 * a disabled server or no enabled instance; the library-resync hold (its sync
 * also refills empty libraries); no items in any enabled library (a parked job
 * from before is then not the cause); a parked slice; nothing queued.
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
 * Whether the archive import is genuinely owed AND will make progress — the
 * one signal a spinner or poll may wait on. Never with a `pausedReason`, so
 * Settings says why instead of spinning forever. (With several instances,
 * which one owns the mapping needs network calls a polled route must not
 * make: "at least one enabled" approximates it, and an unowned mapping parks.)
 * Otherwise pending while a slice runs or is queued; when the job table could
 * not be read, the stored evidence stands in (a never-walked mapping, imported
 * rows, a measured far edge or a cursor read pending), except the
 * walked-and-empty end state.
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
