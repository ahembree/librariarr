/**
 * Which episodes of a series match the rule set's non-destructive action
 * (Unmonitor, Search, tag or quality changes) has already acted on.
 *
 * A show's match is stored against one representative episode, and that
 * representative moves: with series scope off it is the lowest-id episode that
 * matches now, so once it stops matching (upgraded, say) the next one stands
 * in. Keyed on the representative, an action settled under the old one no
 * longer counted and the new representative's action repeated it on every
 * episode it had already covered. Coverage is therefore read per episode, from
 * every settled action of the rule set with the same configuration, wherever
 * it is stored.
 *
 * It is also what decides a whole-series action: one is suppressed only when
 * the settled actions covered every episode the show matches now. Suppressed
 * by any settled action on the same representative, a rule set switched to
 * series scope after an episode-scoped action had run on a few episodes never
 * scheduled the series action at all. The price is that a whole-series action
 * runs once more when an episode it never covered starts matching, which
 * repeats an Unmonitor or Search on a series already in that state.
 */
export interface EpisodeCoverage {
  /** Every episode a settled action acted on. */
  episodes: Set<string>;
  /** Items a settled action with no member list was stored against: that
   * action predates member lists and acted on the whole series. */
  wholeShow: Set<string>;
}

export function coverageOf(
  settled: ReadonlyArray<{ mediaItemId: string | null; matchedMediaItemIds: readonly string[] }>,
): EpisodeCoverage {
  const episodes = new Set<string>();
  const wholeShow = new Set<string>();
  for (const action of settled) {
    if (action.matchedMediaItemIds.length === 0) {
      if (action.mediaItemId) wholeShow.add(action.mediaItemId);
    } else {
      for (const id of action.matchedMediaItemIds) episodes.add(id);
    }
  }
  return { episodes, wholeShow };
}

/**
 * The episodes of a match (`members`, or the matched item itself when it lists
 * none) that no settled action covered.
 */
export function uncoveredEpisodes(
  matchItemId: string,
  members: readonly string[],
  coverage: EpisodeCoverage,
): string[] {
  const scope = members.length > 0 ? members : [matchItemId];
  if (coverage.wholeShow.has(matchItemId) || scope.some((id) => coverage.wholeShow.has(id))) return [];
  return scope.filter((id) => !coverage.episodes.has(id));
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
  matchItemId: string,
  currentMembers: readonly string[],
  pendingMembers: readonly string[] | null,
  coverage: EpisodeCoverage,
): string[] {
  if (pendingMembers && pendingMembers.length > 0) {
    if (currentMembers.length === 0) return [...pendingMembers];
    const current = new Set(currentMembers);
    return pendingMembers.filter((m) => current.has(m));
  }
  return uncoveredEpisodes(matchItemId, currentMembers, coverage);
}
