"use client";

import { LifecycleRulePage } from "@/components/lifecycle-rule-page";
import { MOVIE_ACTION_TYPES } from "@/lib/lifecycle/action-types";

export default function LifecycleMoviesPage() {
  return (
    <LifecycleRulePage
      mediaType="MOVIE"
      pageTitle="Movie Lifecycle Rules"
      ruleDescription="movies"
      arrServiceName="Radarr"
      arrApiPath="radarr"
      defaultActionType="DELETE_RADARR"
      actionTypes={MOVIE_ACTION_TYPES}
      importErrorMessage="This is a series rule set. Import it on the Series page."
    />
  );
}
