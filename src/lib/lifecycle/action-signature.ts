/**
 * The effective configuration of a lifecycle action — everything that
 * determines WHAT the action does, independent of when it runs or which item
 * it targets.
 */
export interface ActionConfig {
  actionType: string | null;
  arrInstanceId: string | null;
  targetQualityProfileId: number | null;
  addImportExclusion: boolean;
  searchAfterAction: boolean;
  addArrTags: string[];
  removeArrTags: string[];
}

/**
 * Canonical signature of an action's effect, used to decide whether a
 * previously-completed non-destructive action is the SAME action we'd schedule
 * now.
 *
 * A non-destructive action (unmonitor, do-nothing, search, quality change)
 * leaves its item in place, so the item keeps matching the rule. To avoid
 * re-running it as a no-op every cycle, scheduling suppresses an item that
 * already has a completed action with the same signature. But if the rule
 * set's action was *re-configured* — different tags, a new target quality
 * profile, a different Arr instance, search-after toggled — the new action has
 * never run on that item and MUST be scheduled. Comparing the full signature
 * (rather than just the action type) is what lets a tag/profile edit re-fire
 * without forcing the user to recreate the rule.
 *
 * Tag arrays are compared as sets: order and duplicates don't change the
 * effect. `actionDelayDays` is intentionally NOT part of the signature — it
 * changes WHEN an action runs, not WHAT it does, so a delay change must not
 * re-fire a completed action.
 */
export function actionConfigSignature(c: ActionConfig): string {
  const normTags = (arr: string[]) => [...new Set(arr)].sort();
  return JSON.stringify({
    actionType: c.actionType ?? "",
    arrInstanceId: c.arrInstanceId ?? "",
    targetQualityProfileId: c.targetQualityProfileId ?? null,
    addImportExclusion: c.addImportExclusion,
    searchAfterAction: c.searchAfterAction,
    addArrTags: normTags(c.addArrTags),
    removeArrTags: normTags(c.removeArrTags),
  });
}
