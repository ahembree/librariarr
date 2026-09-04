import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { hasArrRules, hasSeerrRules, hasWatchedByUserRules } from "@/lib/rules/lifecycle-engine";
import { prisma } from "@/lib/db";
import { hasEnabledArrInstances, arrFamilyLabel } from "@/lib/lifecycle/fetch-arr-metadata";
import { hasEnabledSeerrInstances } from "@/lib/lifecycle/fetch-seerr-metadata";

/**
 * Whether a rule set's external dependencies (Arr/Seerr instances) are
 * available, so its rules can be evaluated faithfully.
 *
 * `evaluable: false` means evaluation would run against an EMPTY external
 * metadata map, which makes negative rules like `foundInArr = false` /
 * `seerrRequested = false` vacuously true for the ENTIRE library — the
 * match-all hazard every caller of this helper exists to refuse.
 *
 * `permanent` distinguishes the two failure classes:
 *  - false (transient): no enabled instance right now — the rule set resumes
 *    as soon as an instance is re-enabled, so callers skip it and leave its
 *    matches/actions untouched (same as a metadata fetch failure).
 *  - true (permanent): the configuration can NEVER evaluate (Seerr criteria
 *    on a MUSIC rule set — Seerr has no music requests). Detection callers
 *    must also DISARM the rule set (clear matches, cancel pending actions):
 *    a vacuous whole-library flood armed before this guard existed would
 *    otherwise stay frozen forever and still execute.
 *
 * This is the single policy point for the guard — the detection paths log
 * the reason and skip, the preview/test/diff routes return it as a 400.
 */
export type RuleEvaluability =
  | { evaluable: true }
  | { evaluable: false; reason: string; permanent: boolean };

/**
 * Whether every in-scope server's stored `WatchHistory` is currently a faithful
 * record of what was played.
 *
 * Extracted from the rule-set guard because TWO independent paths can act
 * destructively on a `watchedByUser` criterion — saved lifecycle rule sets, and
 * the ad-hoc query page's actions route, which has no `actionDelayDays` review
 * window at all — and they must refuse under exactly the same conditions or the
 * looser one becomes the way around the stricter one.
 *
 * `watchedByUser` reads the `WatchHistory` relation DIRECTLY, not the
 * denormalized `playCount`/`lastPlayedAt` (which are monotonic and therefore
 * safe). Its negative forms (`notEquals`/`notContains`/`isNull`, and any
 * positive form under `negate`, which `pushDownGroupNegation` turns into
 * `NOT { some }`) compile to `watchHistory: { none: … }` — trivially true for
 * every item in the library when the relation is empty.
 *
 * A Tracearr-mapped server reaches exactly that state on purpose: changing a
 * server's watch-history source wipes its rows, and the re-import is a
 * background walk that takes minutes to hours and runs newest-first, so an item
 * last played long ago stays un-evidenced until the walk reaches back that far.
 * Without this check the first evaluation in that window matches the WHOLE
 * library and a DELETE acts on it.
 *
 * Always transient: it resolves by itself the moment the backfill completes, so
 * callers skip/refuse rather than disarming anything.
 *
 * @param serverIds The servers the caller actually reads (a rule set's
 *   `serverIds`, a query's `serverIds`). Empty or omitted means "every server",
 *   which is also their shared default. Scoping matters: without it, one
 *   unrelated server part-way through its Tracearr import would pause every
 *   `watchedByUser` rule set and query on the install, including ones scoped
 *   entirely to native servers whose history is complete and correct.
 */
export async function checkWatchHistoryCompleteness(
  userId: string,
  serverIds?: string[],
): Promise<{ complete: true } | { complete: false; incomplete: number; reason: string }> {
  const scope = serverIds && serverIds.length > 0 ? { id: { in: serverIds } } : {};

  const incomplete = await prisma.mediaServer.count({
    where: {
      userId,
      enabled: true,
      ...scope,
      OR: [
        // History deliberately cleared and not yet refilled — either switch
        // direction. Keyed on the marker rather than on `tracearrServerId`
        // because UNLINKING nulls that column, so a Tracearr → native switch
        // would otherwise slip past at exactly its emptiest moment.
        { watchHistoryClearedAt: { not: null } },
        // Still importing its archive: rows exist but the older span has not
        // been walked yet, so an item last played long ago still looks
        // never-watched.
        { tracearrServerId: { not: null }, tracearrBackfillComplete: false },
        // Mapped, flagged complete, and yet holding no plays at all. The flag
        // describes rows that something removed out from under it — a
        // config-only backup restore (which truncates `WatchHistory` but
        // restores `MediaServer` verbatim), a disable-with-purge that cascaded
        // through `WatchHistory.mediaItem`, a manual delete — and the importer
        // does re-walk from scratch, but that takes hours during which the flag
        // still reads "complete". Asked of the rows rather than of the flag, so
        // a stale flag cannot vouch for a history that isn't there.
        { tracearrServerId: { not: null }, watchHistory: { none: {} } },
      ],
    },
  });

  if (incomplete === 0) return { complete: true };
  return {
    complete: false,
    incomplete,
    reason:
      `${incomplete} server(s) have no complete watch history yet (recently cleared, ` +
      `or still importing) — evaluating "watched by user" now would treat every item ` +
      `as never-watched and match the entire library`,
  };
}

export async function checkLifecycleRuleEvaluability(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  /**
   * The servers the rule set targets (`RuleSet.serverIds`). Empty or omitted
   * means "every server", which is also the rule set's own default.
   *
   * Only the watch-history check uses it, and it matters there: without it, one
   * unrelated server part-way through its Tracearr import would pause every
   * `watchedByUser` rule set on the install, including ones scoped entirely to
   * native servers whose history is complete and correct.
   */
  serverIds?: string[],
): Promise<RuleEvaluability> {
  if (hasArrRules(rules) && !(await hasEnabledArrInstances(userId, type))) {
    return {
      evaluable: false,
      permanent: false,
      reason: `Rules use Arr criteria but no enabled ${arrFamilyLabel(type)} instance exists — evaluating them without one would match the entire library`,
    };
  }
  if (hasSeerrRules(rules)) {
    if (type === "MUSIC") {
      return {
        evaluable: false,
        permanent: true,
        reason: "Seerr criteria are not supported for music rules",
      };
    }
    if (!(await hasEnabledSeerrInstances(userId))) {
      return {
        evaluable: false,
        permanent: false,
        reason: "Rules use Seerr criteria but no enabled Seerr instance exists — evaluating them without one would match the entire library",
      };
    }
  }
  // Watch history is the third external dependency, and it fails the same way.
  // Gated on the rule check FIRST so a rule set with no `watchedByUser`
  // criterion never pays for the server count — this runs per rule set on every
  // detection pass.
  if (hasWatchedByUserRules(rules)) {
    const watch = await checkWatchHistoryCompleteness(userId, serverIds);
    if (!watch.complete) {
      return {
        evaluable: false,
        permanent: false,
        reason: `Rules use watchedByUser but ${watch.reason}`,
      };
    }
  }

  return { evaluable: true };
}
