// Client-safe helpers for an action's two Arr tag lists (addArrTags /
// removeArrTags). The executor matches tag labels case-insensitively, and a
// label in both lists would be added and then removed again, so the lists
// must stay disjoint under that comparison.

function tagKey(label: string): string {
  return label.trim().toLowerCase();
}

/** The labels of `tags` not present in `picked` (trimmed, case-insensitive). */
export function withoutTags(tags: string[], picked: string[]): string[] {
  const keys = new Set(picked.map(tagKey));
  return tags.filter((t) => !keys.has(tagKey(t)));
}

/** Whether no label is in both lists (trimmed, case-insensitive). */
export function tagListsDisjoint(lists: { addArrTags?: string[]; removeArrTags?: string[] }): boolean {
  const added = new Set((lists.addArrTags ?? []).map(tagKey));
  return !(lists.removeArrTags ?? []).some((t) => added.has(tagKey(t)));
}
