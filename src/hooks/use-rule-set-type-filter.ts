"use client";

import { useMemo, useState } from "react";

/** The media-type tabs the lifecycle listings (Matches, Pending) filter by. */
export type LifecycleMediaTypeTab = "all" | "movies" | "series" | "music";

/** Each tab's `LibraryType`; `all` filters nothing. */
export const LIFECYCLE_TAB_TO_TYPE: Readonly<Record<LifecycleMediaTypeTab, string | null>> = {
  all: null,
  movies: "MOVIE",
  series: "SERIES",
  music: "MUSIC",
};

/**
 * The open media-type tab of a page listing rule-set groups, and the groups
 * it shows: those whose rule set is of the tab's type. `ruleSetOf` picks a
 * group's rule set; an inline one only costs re-filtering the handful of
 * groups on each render.
 */
export function useRuleSetTypeFilter<G>(
  groups: readonly G[],
  ruleSetOf: (group: G) => { type: string },
  initial: LifecycleMediaTypeTab = "all",
): { tab: LifecycleMediaTypeTab; setTab: (tab: LifecycleMediaTypeTab) => void; filtered: readonly G[] } {
  const [tab, setTab] = useState<LifecycleMediaTypeTab>(initial);
  const filtered = useMemo(() => {
    const type = LIFECYCLE_TAB_TO_TYPE[tab];
    if (!type) return groups;
    return groups.filter((g) => ruleSetOf(g).type === type);
  }, [groups, tab, ruleSetOf]);
  return { tab, setTab, filtered };
}
