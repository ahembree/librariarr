/**
 * Held rule sets: when a rule set's actions may not run, and how the Pending
 * page reads it.
 *
 * A rule set's actions are held in two cases:
 *
 *  - **Edited** (`RuleSet.actionsHeldSince`): a save that changed what it
 *    matches holds its actions until the next detection run re-checks its
 *    matches, which releases them.
 *  - **Group scope** (`groupScopeViolation`, `src/lib/conditions/group-scope.ts`):
 *    a criterion that describes one episode or track could make a whole show
 *    or artist the target of its action — it judges whole shows or artists
 *    ("Match against entire series" / "artist") on such a criterion, or its
 *    scope is off and its action acts on the whole show or artist (Delete from
 *    Sonarr, Arr tags, …). Saving that is refused, but a rule set saved before
 *    the rule existed, or restored from a backup, can still be in that state.
 *    Detection skips it, so its stored matches were never checked under the
 *    rule; its actions — already pending at upgrade time included — wait
 *    until it is edited into a valid state, whose save sets the edited hold
 *    that detection releases. A scheduled or failed action is judged by its
 *    own snapshot of the action as well as by the rule set's configuration
 *    (`actionHoldFor`).
 *
 * `actionHoldOf` is the one predicate every path that runs a rule set's
 * actions checks: the scheduled executor (before pass 1, and again in pass 2's
 * re-read), Execute and Execute All (so the public API's execute), and
 * force-retry, each refusing with a 409 (the executor leaves the actions
 * PENDING, untouched, and logs why).
 *
 * The listing (`GET /api/lifecycle/actions`) returns both on each group's
 * `ruleSet` — `actionsHeldSince`, and `scopeHoldReason` — so the page marks
 * the rows and disables what the server would refuse rather than answering a
 * click with a refusal toast. The 409 stays the guard. A hold belongs to the
 * rule set, so a group is held whole: Execute All on a held group has nothing
 * left to run.
 *
 * Client-safe.
 */
import { formatDateTime } from "@/lib/format";
import { groupScopeHoldReason, groupScopeViolation, type GroupScopeAction } from "@/lib/conditions/group-scope";

// ─── The rule (server) ───────────────────────────────────────────────────

/** A rule set's row, as far as whether its actions may run: its rules, scope and action. */
export interface ActionHoldSubject extends GroupScopeAction {
  type: string;
  seriesScope: boolean;
  rules: unknown;
  actionsHeldSince: Date | string | null;
  /** The rule set's own action switch, as stored. */
  actionEnabled: boolean;
}

/** The rule set columns, beyond its type, scope, rules and stamp, `actionHoldOf` reads: its action. */
export const HOLD_ACTION_SELECT = {
  actionEnabled: true,
  actionType: true,
  addArrTags: true,
  removeArrTags: true,
  searchAfterAction: true,
} as const;

/** Why a rule set's actions may not run now. */
export type ActionHold =
  /** A per-episode/per-track criterion could make a whole show or artist its target; it must be edited. */
  | { kind: "groupScope"; reason: string }
  /** A save changed what it matches; the next detection run releases it. */
  | { kind: "edited"; since: Date | string };

/**
 * Whether a rule set's actions are held, and why; null when they may run.
 * The group-scope hold is read from the rule set itself — its rules, scope
 * and action — not from a stamp a detection run would have to set first, so
 * an action pending before the rule existed is held from the moment the app
 * runs it.
 */
export function actionHoldOf(ruleSet: ActionHoldSubject): ActionHold | null {
  const violation = groupScopeViolation(ruleSet.type, ruleSet.seriesScope, ruleSet.rules, ruleSet);
  if (violation) return { kind: "groupScope", reason: groupScopeHoldReason(violation) };
  if (ruleSet.actionsHeldSince) return { kind: "edited", since: ruleSet.actionsHeldSince };
  return null;
}

/**
 * `actionHoldOf` for one scheduled (or failed) action about to run: the rule
 * set's hold, or else the group-scope hold the action's own snapshot of its
 * configuration makes — what would actually run. The snapshot follows the
 * rule set through every save that keeps the matches, but a restore, or a row
 * written before the rule, can disagree with it, and the scheduled executor
 * and force-retry run the snapshot.
 */
export function actionHoldFor(ruleSet: ActionHoldSubject, action: GroupScopeAction): ActionHold | null {
  const hold = actionHoldOf(ruleSet);
  if (hold) return hold;
  const own = groupScopeViolation(ruleSet.type, ruleSet.seriesScope, ruleSet.rules, { ...action, actionEnabled: true });
  return own ? { kind: "groupScope", reason: groupScopeHoldReason(own) } : null;
}

/**
 * The group-scope hold's reason, or null: what the listing returns as each
 * group's `ruleSet.scopeHoldReason`.
 */
export function scopeHoldReason(ruleSet: Omit<ActionHoldSubject, "actionsHeldSince">): string | null {
  const hold = actionHoldOf({ ...ruleSet, actionsHeldSince: null });
  return hold?.kind === "groupScope" ? hold.reason : null;
}

// ─── The Pending page ────────────────────────────────────────────────────

/** A listing group's rule set, as far as its hold goes. */
export interface HoldingRuleSet {
  /** ISO time an edit held its actions; null (or absent, for a deleted rule set) when not. */
  actionsHeldSince?: string | null;
  /** Set while it is held because a per-episode/per-track criterion could make a whole show or artist its action's target: why. */
  scopeHoldReason?: string | null;
}

/** The statuses whose button a hold refuses: Execute on a pending action, Retry on a failed one. */
const HELD_STATUSES: ReadonlySet<string> = new Set(["PENDING", "FAILED"]);

/**
 * Why a listed rule set's actions are held — the Held chip's tooltip and the
 * disabled buttons' reason — or null when they are not.
 */
export function holdReasonOf(ruleSet: HoldingRuleSet): string | null {
  if (ruleSet.scopeHoldReason) return ruleSet.scopeHoldReason;
  if (ruleSet.actionsHeldSince) return heldActionsReason(ruleSet.actionsHeldSince);
  return null;
}

/**
 * Whether a listed action waits on its rule set's hold. A completed action has
 * nothing left to run, so it is never held.
 */
export function isActionHeld(ruleSet: HoldingRuleSet, action: { status: string }): boolean {
  return holdReasonOf(ruleSet) !== null && HELD_STATUSES.has(action.status);
}

/**
 * How many of a group's listed actions wait on its rule set's hold: every
 * pending and failed one while it is held, none otherwise. Execute All skips
 * them — on a held group, all of them.
 */
export function heldActionCount(group: {
  ruleSet: HoldingRuleSet;
  items: ReadonlyArray<{ status: string }>;
}): number {
  return group.items.filter((action) => isActionHeld(group.ruleSet, action)).length;
}

/** Why an edited rule set's actions don't run (`actionsHeldSince`). */
export function heldActionsReason(since: string): string {
  return (
    `Held since ${formatDateTime(since)}: this rule set was edited (its rules, servers or sticky matches) or enabled again, so its actions ` +
    `wait for the next detection run to re-check its matches. Re-evaluate it on the Matches page to run one now.`
  );
}

/** The line beside a held group's disabled Execute All, saying how many it skips and until when. */
export function heldCountLabel(held: number, ruleSet: HoldingRuleSet = {}): string {
  return ruleSet.scopeHoldReason
    ? `${held} held until the rule set is edited`
    : `${held} held until the next detection run`;
}

/** What Execute All answers when every action it was asked to run is held. */
export function skippedHeldLabel(held: number): string {
  return `Skipped ${held} held ${held === 1 ? "action" : "actions"}`;
}
