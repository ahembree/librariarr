"use client";

import { LifecycleRulePage } from "@/components/lifecycle-rule-page";
import { SERIES_ACTION_TYPES } from "@/lib/lifecycle/action-types";

export default function LifecycleSeriesPage() {
  return (
    <LifecycleRulePage
      mediaType="SERIES"
      pageTitle="Series Lifecycle Rules"
      ruleDescription="series"
      arrServiceName="Sonarr"
      arrApiPath="sonarr"
      defaultActionType="DELETE_SONARR"
      actionTypes={SERIES_ACTION_TYPES}
      importErrorMessage="This is a movie rule set. Import it on the Movies page."
      scopeConfig={{
        id: "series-scope",
        label: "Match against entire series",
        enabledDescription: "Rules evaluate against aggregated series data (total plays, total size, latest play date across all episodes)",
        disabledDescription: "Rules evaluate against individual episodes, then results are grouped by series",
        ruleSetEnabledLabel: "Series scope",
        ruleSetDisabledLabel: "Episode scope",
      }}
    />
  );
}
