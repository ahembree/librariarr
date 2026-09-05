/**
 * Progress arithmetic for the Tracearr history backfill.
 *
 * Lives beside the route rather than inside it because a `route.ts` may only
 * export route handlers and Next's route config fields — a runtime export of
 * anything else fails the build's route-type check. Keeping it here also lets
 * the tests drive the edge cases directly instead of only through HTTP.
 */

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

  const covered = newest - input.oldestImported.getTime();

  // Clamped, not asserted: the measurement and the import are separate passes,
  // so a play older than `oldestPlayAt` can legitimately already be imported
  // (it arrived on the forward pass, or Tracearr grew older history after the
  // bisection ran). That is a >1 ratio, not a bug — report a full bar.
  return Math.min(1, Math.max(0, covered / span));
}
