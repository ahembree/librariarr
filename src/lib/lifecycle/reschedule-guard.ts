/**
 * Re-schedule guard for previously-actioned items.
 *
 * A COMPLETED/FAILED non-delete action (UNMONITOR, DO_NOTHING, tag changes, …)
 * leaves its item in place, so the item keeps satisfying the rule on every
 * subsequent run. To avoid an infinite loop, scheduling suppresses a new action
 * for an item that already has such a completed action. (DELETE actions are
 * exempt — if a "deleted" item still matches, the deletion likely failed
 * silently and re-scheduling is correct.)
 *
 * That suppression is only valid while the item has CONTINUOUSLY matched since
 * the action ran. `RuleMatch.detectedAt` marks the start of an item's current,
 * uninterrupted matching streak: incremental detection removes the RuleMatch
 * when an item stops matching and writes a fresh `detectedAt` when it matches
 * again. So a match detected AFTER the action completed means the item dropped
 * out of the match set and later came back — e.g. it was removed from the
 * server and re-added at a later date — which is a genuinely new actionable
 * cycle that should NOT be suppressed.
 *
 * Without this, a re-added item shows up under rule matches forever but never
 * moves into pending actions, because the stale completed action keeps blocking
 * it.
 *
 * @param actionedAt       When the prior action ran (`executedAt ?? createdAt`).
 * @param matchDetectedAt  `detectedAt` of the item's CURRENT RuleMatch, or
 *                         undefined when the item isn't currently matching.
 * @returns true when the prior action should still block (re-)scheduling.
 */
export function completedActionBlocksReschedule(
  actionedAt: Date,
  matchDetectedAt: Date | undefined,
): boolean {
  // No current match info — be conservative and keep blocking. (Callers only
  // consult this for items that currently match, so this guards a missing-row
  // race rather than a normal path.)
  if (!matchDetectedAt) return true;
  // Continuous match (detected at or before the action ran) → still block.
  // Re-detected after the action → new cycle → allow re-scheduling.
  return matchDetectedAt <= actionedAt;
}
