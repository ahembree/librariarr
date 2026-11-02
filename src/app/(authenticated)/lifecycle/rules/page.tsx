"use client";

import { useMemo } from "react";
import { Film, Tv, Music } from "lucide-react";
import { LifecycleRulePage } from "@/components/lifecycle-rule-page";
import { MOVIE_ACTION_TYPES, SERIES_ACTION_TYPES, MUSIC_ACTION_TYPES } from "@/lib/lifecycle/action-types";
import { TabNav, type TabNavItem } from "@/components/tab-nav";
import { PageHeader } from "@/components/page-header";
import { useHashTab } from "@/hooks/use-hash-tab";
import { useHydrated } from "@/hooks/use-hydrated";
import { useLibraryTypes } from "@/hooks/use-library-types";
import { useRuleEditorData } from "@/hooks/use-rule-editor-data";

type RuleTab = "movies" | "series" | "music";

const TABS: TabNavItem<RuleTab>[] = [
  { value: "movies", label: "Movies", icon: Film },
  { value: "series", label: "Series", icon: Tv },
  { value: "music", label: "Music", icon: Music },
];

const TAB_VALUES = TABS.map((t) => t.value);

const TAB_TYPE: Record<RuleTab, string> = { movies: "MOVIE", series: "SERIES", music: "MUSIC" };

export default function LifecycleRulesPage() {
  // The open tab IS the URL hash — see `src/lib/url-hash.ts` for why it is
  // read through a store rather than once on mount (a query converted to a
  // rule set lands here as /lifecycle/rules?ruleSet=…#series).
  const [activeTab, setTab] = useHashTab(TAB_VALUES, "movies");
  // The hash reads as empty until hydrated, so a tab mounted before then is
  // the fallback's, replaced a moment later by the one the hash names.
  const hydrated = useHydrated();
  // Seeded from the layout's read, so the tabs are known on the first render:
  // a hash naming a type with no library no longer mounts that tab only to
  // replace it once the types arrive.
  const libraryTypes = useLibraryTypes();
  const availableTypes = useMemo(() => {
    if (!libraryTypes) return [];
    return libraryTypes.allTypes.length > 0 ? libraryTypes.allTypes : libraryTypes.types;
  }, [libraryTypes]);
  // Every tab's tab-independent data, read once for the page.
  const editorData = useRuleEditorData();

  // Filter tabs to only show available media types (once loaded)
  const visibleTabs = useMemo(
    () => (availableTypes.length > 0 ? TABS.filter((t) => availableTypes.includes(TAB_TYPE[t.value])) : TABS),
    [availableTypes],
  );

  // If active tab becomes unavailable, derive the correct tab
  const effectiveTab = useMemo(() => {
    if (availableTypes.length === 0) return activeTab;
    if (availableTypes.includes(TAB_TYPE[activeTab])) return activeTab;
    return visibleTabs.length > 0 ? visibleTabs[0].value : activeTab;
  }, [availableTypes, activeTab, visibleTabs]);

  return (
    // Normal page flow: the header and tabs scroll away with the content
    // (a pinned header ate a third of small screens).
    <div>
      <div className="p-4 sm:p-6 lg:p-8 pb-0 sm:pb-0 lg:pb-0">
        <PageHeader
          className="mb-6"
          title="Lifecycle Rules"
          description="Define rules to automatically manage your media library based on criteria like age, play count, and quality."
        />

        <TabNav tabs={visibleTabs} activeTab={effectiveTab} onTabChange={setTab} className="mb-6" />
      </div>

      {hydrated && effectiveTab === "movies" && (
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
          data={editorData}
        />
      )}
      {hydrated && effectiveTab === "series" && (
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
          data={editorData}
        />
      )}
      {hydrated && effectiveTab === "music" && (
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
          data={editorData}
        />
      )}
    </div>
  );
}
