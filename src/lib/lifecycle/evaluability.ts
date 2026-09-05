import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { hasArrRules, hasSeerrRules, hasPlayActivityRules } from "@/lib/rules/lifecycle-engine";
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
 * Whether every in-scope server has ESTABLISHED play history — i.e. a sync has
 * actually determined what was played there, and that determination is current.
 *
 * The principle: a criterion that reads play activity may only be answered
 * where play activity is known. An empty `WatchHistory` is indistinguishable
 * from "nobody watched anything", and the negative form of every play-activity
 * field goes vacuously TRUE against it for the entire library —
 * `watchedByUser is not alice` compiles to `watchHistory: { none: … }`,
 * `playCount = 0` and `lastPlayedAt is null` match everything once the
 * denormalized columns were never established. On a DELETE rule set that is the
 * whole library, so the answer must be "refuse", not "no evidence, therefore
 * false".
 *
 * Extracted from the rule-set guard because TWO independent paths act
 * destructively on these criteria — saved lifecycle rule sets, and the ad-hoc
 * query page's actions route, which has no `actionDelayDays` review window at
 * all — and they must refuse under identical conditions or the looser one
 * becomes the way around the stricter one.
 *
 * A server is NOT established when either holds:
 *
 *  - `watchHistorySyncedAt` is null. No sync has ever established its history,
 *    or something invalidated it since — a source switch, a library or
 *    type-wide purge, a disable-with-delete-data, or a backup restore. This is
 *    also the state a brand-new server starts in, which is the point: absence
 *    of evidence is not evidence of absence, and the default has to say so.
 *  - It is Tracearr-mapped with `tracearrBackfillComplete` false. History
 *    exists but is incomplete: the archive walk runs newest-first over minutes
 *    to hours, so an item last played long ago still looks never-watched until
 *    the walk reaches back that far.
 *
 * Always transient: it resolves the moment a sync establishes the history (or
 * the backfill finishes), so callers skip/refuse rather than disarming
 * anything. Note that a server nobody has ever watched anything on settles
 * correctly — its sync finds no plays, marks the history established, and
 * `playCount = 0` then legitimately matches everything on it.
 *
 * @param serverIds The servers the caller actually reads (a rule set's
 *   `serverIds`, a query's `serverIds`). Empty or omitted means "every server",
 *   which is also their shared default. Scoping matters: without it, one
 *   unrelated server part-way through its Tracearr import would pause every
 *   play-activity rule set and query on the install, including ones scoped
 *   entirely to servers whose history is complete and correct.
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
        { watchHistorySyncedAt: null },
        { tracearrServerId: { not: null }, tracearrBackfillComplete: false },
      ],
    },
  });

  if (incomplete === 0) return { complete: true };
  return {
    complete: false,
    incomplete,
    reason:
      `${incomplete} server(s) have no established play history yet (never synced, ` +
      `recently cleared, or still importing) — evaluating play-activity criteria now ` +
      `would treat every item as never-watched and match the entire library`,
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
  // The trigger is EVERY play-activity field, not just `watchedByUser`: that
  // one reads the rows and goes vacuous the instant they are gone, but
  // `playCount = 0` and `lastPlayedAt is null` go vacuous identically whenever
  // the denormalized columns were never established. Gating only the first left
  // the other six answering "never watched" for a whole library on no evidence.
  //
  // Gated on the rule check FIRST so a rule set that asks nothing about play
  // activity never pays for the server count — this runs per rule set on every
  // detection pass.
  if (hasPlayActivityRules(rules)) {
    const watch = await checkWatchHistoryCompleteness(userId, serverIds);
    if (!watch.complete) {
      return {
        evaluable: false,
        permanent: false,
        reason: `Rules read play activity but ${watch.reason}`,
      };
    }
  }

  return { evaluable: true };
}
