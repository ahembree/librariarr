"use client";

import { LifecycleRulePage } from "@/components/lifecycle-rule-page";
import { MUSIC_ACTION_TYPES } from "@/lib/lifecycle/action-types";

export default function LifecycleMusicPage() {
  return (
    <LifecycleRulePage
      mediaType="MUSIC"
      pageTitle="Music Lifecycle Rules"
      ruleDescription="music"
      arrServiceName="Lidarr"
      arrApiPath="lidarr"
      defaultActionType="DELETE_LIDARR"
      actionTypes={MUSIC_ACTION_TYPES}
      importErrorMessage="This rule set is not for music. Import it on the correct page."
      scopeConfig={{
        id: "artist-scope",
        label: "Match against entire artist",
        enabledDescription: "Rules evaluate against aggregated artist data (total plays, total size, latest play date across all tracks)",
        disabledDescription: "Rules evaluate against individual tracks, then results are grouped by artist",
        ruleSetEnabledLabel: "Artist scope",
        ruleSetDisabledLabel: "Track scope",
      }}
    />
  );
}
