/**
 * The rule editor's evaluation of an unsaved rule set — the candidate matches
 * its Preview, Match Changes (the rule diff) and Collection Order Preview read.
 *
 * Routed exactly as detection routes it (`detect-matches.ts`): series or
 * artist scope on (the default) evaluates whole shows or artists; a
 * series-aggregate field forces the series path even with series scope off,
 * members restricted to the matching episodes (evaluated per episode the
 * aggregate reads absent, and the editor showed a different set from the one
 * stored); otherwise items are evaluated one by one, episodes grouped by show.
 */
import {
  evaluateLifecycleRules,
  evaluateMusicScope,
  evaluateSeriesScope,
  groupSeriesResults,
  hasEpisodeLevelRules,
  hasSeriesAggregateRules,
} from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

export interface EditorEvaluationInput {
  rules: LifecycleRule[] | LifecycleRuleGroup[];
  type: "MOVIE" | "SERIES" | "MUSIC";
  /** The editor's series/artist scope; left out reads as on. */
  seriesScope?: boolean;
  serverIds: string[];
  arrData?: ArrDataMap;
  seerrData?: SeerrDataMap;
  /** The rule set being edited: "Has Pending Action" leaves out its own actions, as detection does. */
  excludeRuleSetId?: string;
}

export async function evaluateEditorRuleSet(input: EditorEvaluationInput) {
  const { rules, type, seriesScope, serverIds, arrData, seerrData } = input;
  const crossSystemOptions = { excludeRuleSetId: input.excludeRuleSetId };
  const aggregateForced = type === "SERIES" && seriesScope === false && hasSeriesAggregateRules(rules);
  if (type === "SERIES" && (seriesScope !== false || aggregateForced)) {
    return evaluateSeriesScope(rules, serverIds, arrData, seerrData, aggregateForced, crossSystemOptions);
  }
  if (type === "MUSIC" && seriesScope !== false) {
    return evaluateMusicScope(rules, serverIds, arrData, crossSystemOptions);
  }
  const rawItems = await evaluateLifecycleRules(rules, type, serverIds, arrData, seerrData, crossSystemOptions);
  return type === "SERIES"
    ? groupSeriesResults(rawItems, { summarizeEpisodeFields: hasEpisodeLevelRules(rules) })
    : rawItems;
}
