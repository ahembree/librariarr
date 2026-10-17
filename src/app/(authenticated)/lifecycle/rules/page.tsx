"use client";

import { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from "react";
import { Film, Tv, Music } from "lucide-react";
import { LifecycleRulePage } from "@/components/lifecycle-rule-page";
import { MOVIE_ACTION_TYPES, SERIES_ACTION_TYPES, MUSIC_ACTION_TYPES } from "@/lib/lifecycle/action-types";
import { TabNav, type TabNavItem } from "@/components/tab-nav";
import { readUrlHash, replaceUrlHash, subscribeToUrlHash } from "@/lib/url-hash";

type RuleTab = "movies" | "series" | "music";

const TABS: TabNavItem<RuleTab>[] = [
  { value: "movies", label: "Movies", icon: Film },
  { value: "series", label: "Series", icon: Tv },
  { value: "music", label: "Music", icon: Music },
];

/** The tab a URL hash names, or null for no hash or one that names none. */
function tabFromHash(hash: string): RuleTab | null {
  const tab = hash.slice(1);
  return TABS.some((t) => t.value === tab) ? (tab as RuleTab) : null;
}

/** Server snapshot for the URL hash: the server never sees it. */
const noUrlHash = () => "";

export default function LifecycleRulesPage() {
  // The open tab IS the URL hash — see `src/lib/url-hash.ts` for why it is
  // read through a store rather than once on mount (a query converted to a
  // rule set lands here as /lifecycle/rules?ruleSet=…#series).
  const urlHash = useSyncExternalStore(subscribeToUrlHash, readUrlHash, noUrlHash);
  const activeTab: RuleTab = tabFromHash(urlHash) ?? "movies";
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);

  // A URL naming no tab is pointed at the Movies tab it shows — read live,
  // since on a client-side navigation the store has not yet re-read the hash
  // the router just wrote.
  useEffect(() => {
    if (!tabFromHash(readUrlHash())) replaceUrlHash("#movies");
  }, [urlHash]);

  useEffect(() => {
    fetch("/api/media/library-types")
      .then((res) => res.json())
      .then((data) => {
        if (data.allTypes?.length > 0) setAvailableTypes(data.allTypes);
        else if (data.types?.length > 0) setAvailableTypes(data.types);
      })
      .catch(() => {});
  }, []);

  const handleTabChange = useCallback((tab: RuleTab) => replaceUrlHash(`#${tab}`), []);

  // Filter tabs to only show available media types (once loaded)
  const visibleTabs = availableTypes.length > 0
    ? TABS.filter((t) => availableTypes.includes(t.value === "movies" ? "MOVIE" : t.value === "series" ? "SERIES" : "MUSIC"))
    : TABS;

  // If active tab becomes unavailable, derive the correct tab
  const effectiveTab = useMemo(() => {
    if (availableTypes.length === 0) return activeTab;
    const tabType = activeTab === "movies" ? "MOVIE" : activeTab === "series" ? "SERIES" : "MUSIC";
    if (availableTypes.includes(tabType)) return activeTab;
    return visibleTabs.length > 0 ? visibleTabs[0].value : activeTab;
  }, [availableTypes, activeTab, visibleTabs]);

  return (
    // Normal page flow: the header and tabs scroll away with the content
    // (a pinned header ate a third of small screens).
    <div>
      <div className="p-4 sm:p-6 lg:p-8 pb-0 sm:pb-0 lg:pb-0">
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Lifecycle Rules</h1>
          <p className="text-muted-foreground mt-1">Define rules to automatically manage your media library based on criteria like age, play count, and quality.</p>
        </div>

        <TabNav tabs={visibleTabs} activeTab={effectiveTab} onTabChange={handleTabChange} className="mb-6" />
      </div>

      {effectiveTab === "movies" && (
        <LifecycleRulePage
          mediaType="MOVIE"
          pageTitle=""
          ruleDescription="movies"
          arrServiceName="Radarr"
          arrApiPath="radarr"
          defaultActionType="DO_NOTHING"
          actionTypes={MOVIE_ACTION_TYPES}
          importErrorMessage="This is a series rule set. Import it on the Series tab."
          embedded
        />
      )}
      {effectiveTab === "series" && (
        <LifecycleRulePage
          mediaType="SERIES"
          pageTitle=""
          ruleDescription="series"
          arrServiceName="Sonarr"
          arrApiPath="sonarr"
          defaultActionType="DO_NOTHING"
          actionTypes={SERIES_ACTION_TYPES}
          importErrorMessage="This is a movie rule set. Import it on the Movies tab."
          scopeConfig={{
            id: "series-scope",
            label: "Match against entire series",
            enabledDescription: "Rules evaluate against aggregated series data (total plays, total size, latest play date across all episodes)",
            disabledDescription: "Rules evaluate against individual episodes, then results are grouped by series",
            ruleSetEnabledLabel: "Series scope",
            ruleSetDisabledLabel: "Episode scope",
          }}
          embedded
        />
      )}
      {effectiveTab === "music" && (
        <LifecycleRulePage
          mediaType="MUSIC"
          pageTitle=""
          ruleDescription="music"
          arrServiceName="Lidarr"
          arrApiPath="lidarr"
          defaultActionType="DO_NOTHING"
          actionTypes={MUSIC_ACTION_TYPES}
          importErrorMessage="This rule set is not for music. Import it on the correct tab."
          scopeConfig={{
            id: "artist-scope",
            label: "Match against entire artist",
            enabledDescription: "Rules evaluate against aggregated artist data (total plays, total size, latest play date across all tracks)",
            disabledDescription: "Rules evaluate against individual tracks, then results are grouped by artist",
            ruleSetEnabledLabel: "Artist scope",
            ruleSetDisabledLabel: "Track scope",
          }}
          embedded
        />
      )}
    </div>
  );
}
