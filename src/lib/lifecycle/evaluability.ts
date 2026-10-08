import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { hasArrRules, hasSeerrRules, hasPlayActivityRules } from "@/lib/rules/lifecycle-engine";
import { prisma } from "@/lib/db";
import { hasEnabledArrInstances, arrFamilyLabel, resolveArrInstanceScope } from "@/lib/lifecycle/fetch-arr-metadata";
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
  | {
      evaluable: false;
      reason: string;
      permanent: boolean;
      /**
       * The refusal is the play-history one: its servers' play history is not
       * established. A detection path that skips the rule set for it records
       * the refusal on the rule set (`notePlayHistoryPause`), since the
       * matches it keeps are from before then.
       */
      playHistory?: boolean;
    };

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
 * A server is NOT established when any of these holds — listed in the order a
 * refusal names them, which is the order their remedies have to happen in:
 *
 *  - `libraryResyncRequiredAt` is set (`requireLibraryResync`). Some of its
 *    media rows are known to be missing — a purge, a disable-with-delete-data,
 *    a backup restore or a vanished library removed them, or a library is being
 *    populated for the first time — and they come back as fresh rows with none
 *    of their plays. Checked on its own rather than through the marker: the
 *    hold says the gap is unclosed whatever the marker reads, and its remedy is
 *    a complete library sync, which nothing else substitutes for.
 *  - It is Tracearr-mapped with `tracearrBackfillComplete` false. History
 *    exists but is incomplete: the archive walk runs newest-first over minutes
 *    to hours, so an item last played long ago still looks never-watched until
 *    the walk reaches back that far. Every hold restarts it (and its release
 *    nulls the marker), so this is what a mapped server shows after the
 *    library sync — and only the walk's completion re-establishes the marker
 *    there: a History-page Refresh runs just the forward catch-up.
 *  - `watchHistorySyncedAt` is null. No sync has ever established its history,
 *    or something invalidated it since — a source switch, a purge of a
 *    disabled library, a hold just released on a native server, a Tracearr
 *    sync that could not attribute plays (no account map), or a native full
 *    replace that began without a marker and had to set aside a Jellyfin/Emby
 *    user whose played items it could not read (and who has no stored rows):
 *    that one a Refresh does not lift, so the reason says to look at System
 *    Logs, which name the user and what to change. This is also the state a
 *    brand-new server starts in, which is the point: absence of evidence is
 *    not evidence of absence, and the default has to say so. The next
 *    successful watch-history sync lifts it.
 *  - It is Tracearr-mapped with `tracearrForwardFloorAt` set: a stretch of
 *    RECENT plays is known to be unread. The importer records the floor before
 *    a forward walk's first page with a new play and clears it when the walk
 *    finishes, so it is set for the length of every forward import that finds
 *    something — seconds, or minutes after downtime — and stays set when one
 *    is interrupted (or wrote plays it could not attribute) until the next
 *    resumes it. The marker from before that walk still stands, so only this
 *    clause sees the gap, and refusing while it lasts is deliberate: an item
 *    played only in that stretch reads as unplayed until the walk reads it.
 *
 * Never permanent, but not necessarily short: each fault lifts once its remedy
 * happens (a library sync releases the hold, the import finishes, a sync
 * establishes the history, the forward walk reads the gap), and that can take
 * hours — a Tracearr re-walk — or stay out of reach indefinitely: a library the
 * hold waits for that no sync can complete (the server lists it as empty while
 * it holds rows, or far short of its total), an import that is paused. So
 * callers refuse rather than disarm: detection skips the rule set and KEEPS its
 * matches and PENDING actions. Those matches are then frozen at their last
 * evaluation, which is why the executors hold such a rule set's actions too
 * (`checkPlayActivityExecutable` below) rather than act on them. Note that a
 * server nobody has ever watched anything on settles correctly — its sync
 * finds no plays, marks the history established, and `playCount = 0` then
 * legitimately matches everything on it.
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

  // `findMany`, not `count`: the clauses below are different faults with
  // different remedies, and a bare tally could distinguish none of them. "N
  // server(s) ... never synced, recently cleared, or still importing" is
  // unactionable — it names no server and offers mutually exclusive
  // explanations, so a user whose import genuinely finished has no way to tell
  // which one applies, or that none of them do. Naming the server and its
  // specific fault is what makes a refusal something the user can act on
  // rather than wait out.
  const servers = await prisma.mediaServer.findMany({
    where: {
      userId,
      enabled: true,
      ...scope,
      OR: [
        { libraryResyncRequiredAt: { not: null } },
        { tracearrServerId: { not: null }, tracearrBackfillComplete: false },
        { watchHistorySyncedAt: null },
        { tracearrServerId: { not: null }, tracearrForwardFloorAt: { not: null } },
      ],
    },
    select: {
      name: true,
      libraryResyncRequiredAt: true,
      watchHistorySyncedAt: true,
      tracearrServerId: true,
      tracearrForwardFloorAt: true,
      tracearrBackfillComplete: true,
    },
    orderBy: { name: "asc" },
  });

  if (servers.length === 0) return { complete: true };

  // One fault per server — the first that applies, in the order the remedies
  // have to happen: a library sync before anything else (nothing else lifts
  // the hold, and its release restarts a mapped server's import and nulls the
  // marker); then a mapped server's unfinished archive walk, because its
  // completion is what re-establishes the marker there, so "run a Refresh"
  // would send the user to a sync that cannot help; then the marker, which the
  // next watch-history sync lifts; then a forward gap, which clears when the
  // import reading it completes.
  const faults = servers.map((server) => {
    const mapped = server.tracearrServerId != null;
    if (server.libraryResyncRequiredAt != null) {
      return (
        `"${server.name}" (some of its media was removed in bulk or is being added ` +
        `for the first time — a purge, a restore, or a library's first sync — and ` +
        `play history waits for a complete library sync of this server; run Sync on ` +
        `it under Settings → Servers, and if this stays, System Logs name the library ` +
        `it is still waiting for` +
        (mapped
          ? `; after that sync, the Tracearr history import it restarted has to read back ` +
            `through the archive before play history counts again)`
          : `)`)
      );
    }
    if (mapped && !server.tracearrBackfillComplete) {
      return (
        `"${server.name}" (its Tracearr history import has not finished walking ` +
        `back through the archive — it starts over after a purge, a restore or a ` +
        `library's first sync; this clears when the import completes, and Settings → ` +
        `Servers shows its progress, or why it is paused)`
      );
    }
    if (server.watchHistorySyncedAt === null) {
      return (
        `"${server.name}" (no sync has established what was played there — it has ` +
        `never synced, its history was cleared (a watch-history source change, a ` +
        `purge, a backup restore), or a sync could not attribute every play; the ` +
        `next successful watch-history sync establishes it — run one from Library → ` +
        `History → Refresh. If a user's play history could not be read, System Logs ` +
        `name the user and what to change; a Refresh does not lift that one)`
      );
    }
    return (
      `"${server.name}" (a Tracearr import is reading recent plays, or one was ` +
      `interrupted before it finished; this clears when that import completes — ` +
      `the next watch-history sync resumes an interrupted one)`
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
): Promise<RuleEvaluability> {
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
        playHistory: true,
        reason: `Rules read play activity but ${watch.reason}`,
      };
    }
  }

  return { evaluable: true };
}

/**
 * Record that a detection run skipped this rule set because its servers' play
 * history was not established: `RuleSet.playHistoryPausedAt`, keeping the
 * LATEST such refusal. Detection keeps the rule set's matches and PENDING
 * actions as they were, so they are from before the refusal — an item watched
 * while the history was unknown still holds its match — and they stay held
 * (`checkPlayActivityExecutable`) until a detection run has evaluated the rule
 * set again (`clearPlayHistoryPause`), even once the history is established.
 *
 * Raw SQL: `GREATEST` ignores the NULL of a rule set never refused, and the
 * write is not an edit, so it leaves `updatedAt` alone.
 */
export async function notePlayHistoryPause(ruleSetId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "RuleSet" SET "playHistoryPausedAt" = GREATEST("playHistoryPausedAt", $2::timestamp(3)) WHERE "id" = $1`,
    ruleSetId,
    new Date(),
  );
}

/**
 * Lift `notePlayHistoryPause` once a detection run has evaluated the rule set
 * and written its matches — but only a refusal recorded no later than
 * `evaluationStartedAt`, the instant that run began evaluating it (before its
 * own evaluability check). A refusal recorded after that was made by a run that
 * found the history unestablished while this one was evaluating, so this run's
 * matches may be from before it too; it stands until a run that began after it
 * evaluates the rule set. Compare-and-set, because the manual run route runs
 * detection in a request, outside the serial `MAIN_QUEUE`, beside the scheduled
 * runs. Returns whether it lifted one.
 */
export async function clearPlayHistoryPause(ruleSetId: string, evaluationStartedAt: Date): Promise<boolean> {
  const lifted = await prisma.$executeRawUnsafe(
    `UPDATE "RuleSet" SET "playHistoryPausedAt" = NULL WHERE "id" = $1 AND "playHistoryPausedAt" <= $2::timestamp(3)`,
    ruleSetId,
    evaluationStartedAt,
  );
  return lifted > 0;
}

/**
 * Whether a rule set's ARMED actions may run now, as far as play history goes:
 * `null` when they may, else the refusal.
 *
 * Detection skips a rule set whose play-activity criteria cannot be answered
 * (`checkLifecycleRuleEvaluability`) and keeps its matches and PENDING actions
 * as they were, so those matches are frozen at their last evaluation — and an
 * item watched since, which the next detection would drop, keeps its match,
 * which is exactly what every execution path checks before it acts. So the
 * scheduled executor leaves such a rule set's actions PENDING and the
 * user-initiated paths (Execute on the Pending page and its `/api/v1` mirror,
 * force-retry) refuse, as the query page's actions already do:
 *  - while the history is not established now — the guard's own reason;
 *  - and, once a detection run has skipped the rule set for that
 *    (`RuleSet.playHistoryPausedAt`, `notePlayHistoryPause`), until a detection
 *    run has evaluated it again, even after the history is established: its
 *    matches are still the ones from before.
 * A rule set that reads no play activity is unaffected. One whose history
 * became unknown and known again between two detection runs, with neither
 * skipping it, runs on its last evaluation as usual — no older than it would
 * have been without the outage.
 *
 * @param ruleSet `serverIds` exactly as detection scopes it, and the stored
 *   `playHistoryPausedAt`.
 */
export async function checkPlayActivityExecutable(
  userId: string,
  ruleSet: {
    rules: LifecycleRule[] | LifecycleRuleGroup[];
    serverIds?: string[];
    playHistoryPausedAt: Date | null;
  },
): Promise<string | null> {
  if (!hasPlayActivityRules(ruleSet.rules)) return null;
  const watch = await checkWatchHistoryCompleteness(userId, ruleSet.serverIds);
  if (!watch.complete) {
    return (
      `Rules read play activity but ${watch.reason}. The rule set's matches were evaluated ` +
      `before that, so its actions wait until play history is established again` +
      (ruleSet.playHistoryPausedAt
        ? ` and detection has evaluated the rule set since it skipped it`
        : ` (and, should detection skip the rule set meanwhile, until detection has evaluated it again)`)
    );
  }
  if (ruleSet.playHistoryPausedAt) {
    return (
      `Rules read play activity, and detection skipped this rule set while its play history ` +
      `was not established, so its matches are from before then — an item watched since may ` +
      `still match. Its actions wait until detection evaluates the rule set again: re-evaluate ` +
      `it under Lifecycle → Matches, or wait for the next scheduled detection run`
    );
  }
  return null;
}
