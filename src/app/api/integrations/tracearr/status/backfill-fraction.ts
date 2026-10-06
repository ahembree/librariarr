/**
 * Progress arithmetic for the Tracearr history backfill.
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
