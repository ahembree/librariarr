/**
 * Whether a Series action acts on its matched episodes rather than the whole
 * series, and whether it unmonitors whole seasons. Client-safe.
 */
import { actionCanScopeToEpisodes } from "@/lib/lifecycle/action-types";
import { hasEnabledPerMemberCriteria, isSeasonDetermined } from "@/lib/conditions/group-scope";

/** The rule set as far as its action's episode scope reads it. */
export interface EpisodeScopeRuleSet {
  type: string;
  seriesScope: boolean;
  rules: unknown;
}

/**
 * Whether a rule set's action acts on its matched episodes rather than the
 * series: Sonarr's Unmonitor Only, Search for New Copy and Unmonitor & Delete
 * Files with series scope off. Per-episode coverage (`episode-coverage.ts`)
 * applies only to the non-destructive ones: a delete is always re-schedulable.
 *
 * Unmonitor & Delete Files acts on the episodes only when an enabled criterion
 * is one episode's own (`hasEnabledPerMemberCriteria`). On criteria every
 * episode answers alike (the show's name, the series aggregates, the Sonarr
 * fields) the whole show matches or none of it, and it keeps unmonitoring the
 * series, as it did before it could act per episode — so a rule set saved for
 * that does not start leaving the series monitored.
 */
export function ruleSetActsOnEpisodes(actionType: string, ruleSet: EpisodeScopeRuleSet): boolean {
  if (ruleSet.type !== "SERIES" || ruleSet.seriesScope || !actionCanScopeToEpisodes(actionType)) return false;
  if (actionType === "UNMONITOR_DELETE_FILES_SONARR") return hasEnabledPerMemberCriteria("SERIES", ruleSet.rules);
  return true;
}

/**
 * How an episode-scoped Unmonitor decides that a season of its episodes is
 * unmonitored whole (`ActionRecord.seasonScope`):
 *
 *  - `matched` — the criteria match the whole season (`isSeasonDetermined`),
 *    so every episode of it the library holds is matched unless an exception
 *    protects it. A rule set's action: its member list can be narrowed to the
 *    episodes no earlier action covered (`episode-coverage.ts`), which says
 *    nothing about the season.
 *  - `selected` — every episode of the season the library holds is one of the
 *    action's members: the Query page, where the members are what the user
 *    picked (episode view) or all the show's matched episodes (grouped).
 */
export type SeasonScope = "matched" | "selected";

/** The Unmonitor actions that may unmonitor whole seasons. */
const SEASON_UNMONITOR_ACTION_TYPES = new Set<string>(["UNMONITOR_SONARR", "UNMONITOR_DELETE_FILES_SONARR"]);

/**
 * Whether an episode-scoped action of this type on these criteria unmonitors
 * whole seasons: an Unmonitor, on criteria that decide per season.
 */
export function unmonitorsWholeSeasons(actionType: string | null | undefined, rules: unknown): boolean {
  return !!actionType && SEASON_UNMONITOR_ACTION_TYPES.has(actionType) && isSeasonDetermined(rules);
}

/** A rule set's action's season scope, or undefined when it unmonitors only its episodes. */
export function ruleSetSeasonScope(actionType: string, ruleSet: EpisodeScopeRuleSet): SeasonScope | undefined {
  return ruleSetActsOnEpisodes(actionType, ruleSet) && unmonitorsWholeSeasons(actionType, ruleSet.rules)
    ? "matched"
    : undefined;
}
