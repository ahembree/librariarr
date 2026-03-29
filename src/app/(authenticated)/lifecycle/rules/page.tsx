"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Film, Tv, Music } from "lucide-react";
import { LifecycleRulePage } from "@/components/lifecycle-rule-page";
import { MOVIE_ACTION_TYPES, SERIES_ACTION_TYPES, MUSIC_ACTION_TYPES } from "@/lib/lifecycle/action-types";
import { TabNav, type TabNavItem } from "@/components/tab-nav";

type RuleTab = "movies" | "series" | "music";

const TABS: TabNavItem<RuleTab>[] = [
  { value: "movies", label: "Movies", icon: Film },
  { value: "series", label: "Series", icon: Tv },
  { value: "music", label: "Music", icon: Music },
];

function getInitialTab(): RuleTab {
  if (typeof window === "undefined") return "movies";
  const hash = window.location.hash.replace("#", "") as RuleTab;
  if (["movies", "series", "music"].includes(hash)) return hash;
  return "movies";
}

export default function LifecycleRulesPage() {
  const [activeTab, setActiveTab] = useState<RuleTab>(getInitialTab);
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);

  // Ensure hash is always in the URL for consistency
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (!hash) {
      window.history.replaceState(null, "", `#${activeTab}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch("/api/media/library-types")
      .then((res) => res.json())
      .then((data) => {
        if (data.allTypes?.length > 0) setAvailableTypes(data.allTypes);
        else if (data.types?.length > 0) setAvailableTypes(data.types);
      })
      .catch(() => {});
  }, []);

  const handleTabChange = useCallback((tab: RuleTab) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `#${tab}`);
  }, []);

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
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Lifecycle Rules</h1>
        <p className="text-muted-foreground mt-1">Define rules to automatically manage your media library based on criteria like age, play count, and quality.</p>
      </div>

      <TabNav tabs={visibleTabs} activeTab={effectiveTab} onTabChange={handleTabChange} className="mb-6" />

      {effectiveTab === "movies" && (
        <LifecycleRulePage
          mediaType="MOVIE"
          pageTitle=""
          ruleDescription="movies"
          arrServiceName="Radarr"
          arrApiPath="radarr"
          defaultActionType="DELETE_RADARR"
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
          defaultActionType="DELETE_SONARR"
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
          defaultActionType="DELETE_LIDARR"
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
