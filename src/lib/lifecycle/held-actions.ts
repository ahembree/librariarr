/**
 * The Pending page's reading of a held rule set (`RuleSet.actionsHeldSince`).
 *
 * A save that changes what a rule set matches holds its actions until the next
 * detection run re-checks its matches: the scheduled executor leaves them
 * pending, and Execute, Execute All and force-retry answer 409. The listing
 * (`GET /api/lifecycle/actions`) returns the stamp on each group's `ruleSet`,
 * so the page marks the rows and disables what the server would refuse rather
 * than answering a click with a refusal toast. The 409 stays the guard.
 *
 * The hold belongs to the rule set, so a group is held whole: Execute All on
 * a held group has nothing left to run.
 *
 * Client-safe.
 */
import { formatDateTime } from "@/lib/format";

/** A listing group's rule set, as far as its hold goes. */
export interface HoldingRuleSet {
  /** ISO time the hold was set; null (or absent, for a deleted rule set) when not held. */
  actionsHeldSince?: string | null;
}

/** The statuses whose button a hold refuses: Execute on a pending action, Retry on a failed one. */
const HELD_STATUSES: ReadonlySet<string> = new Set(["PENDING", "FAILED"]);

/**
 * Whether a listed action waits on its rule set's hold. A completed action has
 * nothing left to run, so it is never held.
 */
export function isActionHeld(ruleSet: HoldingRuleSet, action: { status: string }): boolean {
  return !!ruleSet.actionsHeldSince && HELD_STATUSES.has(action.status);
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

/** Why a held rule set's actions don't run: the Held chip's tooltip and the disabled buttons' reason. */
export function heldActionsReason(since: string): string {
  return (
    `Held since ${formatDateTime(since)}: this rule set's rules or servers were edited, so its actions ` +
    `wait for the next detection run to re-check its matches. Re-evaluate it on the Matches page to run one now.`
  );
}

/** The line beside a held group's disabled Execute All, saying how many it skips. */
export function heldCountLabel(held: number): string {
  return `${held} held until the next detection run`;
}

/** What Execute All answers when every action it was asked to run is held. */
export function skippedHeldLabel(held: number): string {
  return `Skipped ${held} held ${held === 1 ? "action" : "actions"}`;
}
