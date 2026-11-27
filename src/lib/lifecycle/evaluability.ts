import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { hasArrRules, hasSeerrRules, hasPlayActivityRules } from "@/lib/rules/lifecycle-engine";
import { hasProviderRatingRules as hasProviderRatingGroupRules } from "@/lib/conditions/helpers";
import { legacyRulesToGroups } from "@/lib/rules/legacy";
import type { ConditionGroup } from "@/lib/conditions/types";
import { countPendingProviderRatings } from "@/lib/sync/provider-ratings";
import { prisma } from "@/lib/db";
import { hasEnabledArrInstances, arrFamilyLabel, resolveArrInstanceScope } from "@/lib/lifecycle/fetch-arr-metadata";
import { hasEnabledSeerrInstances } from "@/lib/lifecycle/fetch-seerr-metadata";
import { groupScopeHoldReason, groupScopeViolation, type GroupScopeAction } from "@/lib/conditions/group-scope";

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
 * A rule set on which a per-episode/per-track criterion could make a whole
 * show or artist its action's target (`groupScopeViolation`: it judges whole
 * shows or artists on one, or its scope is off and its action acts on the
 * whole show or artist) is the one configuration skipped for its own rules
 * rather than an outside dependency: it can be evaluated, but not faithfully —
 * one episode would decide for the whole show. The per-episode criteria
 * (Season Number, Episode Number, Seasons Behind Latest) are such criteria: a
 * whole show has no season or episode number. It is transient (an edit
 * resolves it), so its matches and actions are left in place; its actions are
 * held meanwhile by `actionHoldOf` (held-actions.ts), which reads the same
 * predicate.
 *
 * This is the single policy point for the guard — the detection paths log
 * the reason and skip, the preview/test/diff routes return it as a 400.
 */
type RuleEvaluability =
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

  // `findMany`, not `count`: the two clauses below are different faults with
  // different remedies, and a bare tally could distinguish neither. "N server(s)
  // ... never synced, recently cleared, or still importing" is unactionable —
  // it names no server and offers three mutually exclusive explanations, so a
  // user whose import genuinely finished has no way to tell which one applies,
  // or that none of them do. Naming the server and its specific fault is what
  // makes a refusal something the user can act on rather than wait out.
  const servers = await prisma.mediaServer.findMany({
    where: {
      userId,
      enabled: true,
      ...scope,
      OR: [
        { watchHistorySyncedAt: null },
        { tracearrServerId: { not: null }, tracearrBackfillComplete: false },
      ],
    },
    select: {
      name: true,
      watchHistorySyncedAt: true,
      tracearrServerId: true,
      tracearrBackfillComplete: true,
    },
    orderBy: { name: "asc" },
  });

  if (servers.length === 0) return { complete: true };

  const faults = servers.map((server) => {
    // Checked first because it is the one that is NOT resolved by waiting. A
    // Tracearr-mapped server whose archive walk has finished but whose marker
    // was withdrawn (a source switch, a purge, a restore, or a sync that could
    // not load Tracearr's account map) needs its next successful sync, not
    // patience with an import that already completed.
    if (server.watchHistorySyncedAt === null) {
      return (
        `"${server.name}" (no sync has established what was played there — it has ` +
        `never synced, or the history was cleared by a watch-history source ` +
        `change, a purge, or a backup restore)`
      );
    }
    return (
      `"${server.name}" (its Tracearr history import has not finished walking ` +
      `back through the archive)`
    );
  });

  // Bounded so one badly-configured install cannot turn a 400 body or a log
  // line into a wall of server names.
  const NAMED = 5;
  const listed = faults.slice(0, NAMED).join("; ");
  const remainder =
    faults.length > NAMED ? `; and ${faults.length - NAMED} more` : "";

  return {
    complete: false,
    incomplete: servers.length,
    reason:
      `${servers.length} server(s) have no established play history yet — ` +
      `${listed}${remainder}. Evaluating play-activity criteria now would treat ` +
      `every item as never-watched and match the entire library`,
  };
}

/** Whether either rule shape reads any of Plex's per-provider ratings. */
function hasProviderRatingRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  const groups = rules.length > 0 && "rules" in rules[0]
    ? (rules as LifecycleRuleGroup[])
    : legacyRulesToGroups(rules as LifecycleRule[]);
  return hasProviderRatingGroupRules(groups as ConditionGroup[]);
}

/**
 * Whether every Plex movie or episode (`type`) has had its per-provider ratings
 * read — the fourth dependency that fails like the others.
 *
 * The ratings come only from an item's detail response, so a row stored before
 * they existed (every Plex movie and episode on upgrade, queued by migration
 * `0035_external_ratings`), restored from a backup taken before then, or new
 * with a failed detail fetch holds them EMPTY until a full sync reads it. Empty
 * is what "no score" looks like, so `NOT IMDb Rating >= 6` and `RT Critic Score
 * is empty` match every such row — a well-rated film included. The criteria
 * wait until no row is pending (`countPendingProviderRatings`), across every
 * enabled Plex server: a Jellyfin/Emby copy reads its Plex copy's ratings.
 * Always transient: a full sync settles it.
 */
export async function checkProviderRatingsCompleteness(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
): Promise<{ complete: true } | { complete: false; reason: string }> {
  if (type === "MUSIC") return { complete: true };
  const pending = await countPendingProviderRatings(prisma, userId, [type]);
  if (pending.length === 0) return { complete: true };
  const NAMED = 5;
  const listed = pending
    .slice(0, NAMED)
    .map((p) => `"${p.name}" (${p.pending} ${type === "MOVIE" ? "movie(s)" : "episode(s)"})`)
    .join("; ");
  const remainder = pending.length > NAMED ? `; and ${pending.length - NAMED} more` : "";
  return {
    complete: false,
    reason:
      `${pending.length} Plex server(s) have items whose IMDb, TMDB and Rotten Tomatoes ` +
      `scores a full sync has not read yet — ${listed}${remainder}. Evaluating these ` +
      `criteria now would read those items as unrated`,
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
  /**
   * The rule set's `arrInstanceId`. When it names an instance of this type's
   * Arr family, Arr criteria are read from that instance alone
   * (`resolveArrInstanceScope`), so that instance has to be enabled.
   */
  arrInstanceId?: string | null,
  /**
   * Whether the run judges whole shows or artists: the rule set's
   * `seriesScope`, or the editor's unsaved value, read as the caller routes
   * its evaluation. Omitted reads as on, the rule set default: a caller that
   * forgets it refuses per-episode criteria rather than evaluating them at
   * series scope. Only SERIES and MUSIC have a scope.
   */
  seriesScope: boolean = true,
  /**
   * The rule set's action (`actionEnabled`, `actionType`, its Arr tags and
   * search after), as stored or as the editor holds it: with the scope off,
   * an armed action that acts on the whole show or artist makes per-episode
   * or per-track criteria a violation too. Omitted, only the scope is judged —
   * the detection paths pass it.
   */
  action?: GroupScopeAction | null,
): Promise<RuleEvaluability> {
  // Checked first: it reads only the rules, and no instance or history makes
  // such a rule set evaluable.
  const scopeViolation = groupScopeViolation(type, seriesScope, rules, action);
  if (scopeViolation) {
    return { evaluable: false, permanent: false, reason: groupScopeHoldReason(scopeViolation) };
  }
  if (hasArrRules(rules) && !(await hasEnabledArrInstances(userId, type, arrInstanceId))) {
    const scoped = arrInstanceId ? await resolveArrInstanceScope(userId, type, arrInstanceId) : null;
    return {
      evaluable: false,
      permanent: false,
      reason: scoped
        ? `Rules use Arr criteria but the rule set's ${arrFamilyLabel(type)} instance "${scoped.name}" is disabled — evaluating them without it would match the entire library`
        : `Rules use Arr criteria but no enabled ${arrFamilyLabel(type)} instance exists — evaluating them without one would match the entire library`,
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

  // Plex's per-provider ratings, the same way: a row whose ratings a full sync
  // has not read yet reads as unrated. Gated on the rules first, like the
  // watch-history check, so other rule sets never pay for the count.
  if (hasProviderRatingRules(rules)) {
    const ratings = await checkProviderRatingsCompleteness(userId, type);
    if (!ratings.complete) {
      return {
        evaluable: false,
        permanent: false,
        reason: `Rules read Plex ratings but ${ratings.reason}`,
      };
    }
  }

  return { evaluable: true };
}
