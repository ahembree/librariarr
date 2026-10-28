/**
 * The episodes of a match that no settled action of the same configuration has
 * acted on yet.
 *
 * An episode-scoped Unmonitor or Search (`ruleSetActsOnEpisodes`) acts on the
 * episodes that matched when it ran, and the show it is stored against keeps
 * matching. Suppressing the show once one such action had completed — as a
 * whole-series action is — meant an episode that started matching later (one
 * watched since, under "unmonitor watched episodes") was never acted on. A
 * settled action with no member list acted on the whole series (before
 * episode scope existed), so it covers every episode.
 */
export function uncoveredMembers(
  members: readonly string[],
  settled: ReadonlyArray<{ matchedMediaItemIds: readonly string[] }>,
): string[] {
  if (settled.some((a) => a.matchedMediaItemIds.length === 0)) return [];
  const covered = new Set(settled.flatMap((a) => a.matchedMediaItemIds));
  return members.filter((m) => !covered.has(m));
}

/**
 * The episodes a manual Execute of an episode-scoped action acts on: what the
 * Pending row shows. A scheduled action shows the members it was scheduled
 * with, so it acts on those still matching (as the scheduled executor does); an
 * estimated row shows the members no settled action of the same configuration
 * has covered. Acting on every current member instead repeated the action on
 * episodes the row did not list.
 */
export function episodesToExecute(
  currentMembers: readonly string[],
  pendingMembers: readonly string[] | null,
  settled: ReadonlyArray<{ matchedMediaItemIds: readonly string[] }>,
): string[] {
  if (pendingMembers && pendingMembers.length > 0) {
    if (currentMembers.length === 0) return [...pendingMembers];
    const current = new Set(currentMembers);
    return pendingMembers.filter((m) => current.has(m));
  }
  return uncoveredMembers(currentMembers, settled);
}
