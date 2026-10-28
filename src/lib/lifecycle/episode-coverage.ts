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
