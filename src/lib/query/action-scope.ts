/**
 * The Query page's own actions under the rule: a criterion whose value
 * belongs to one episode or one track must never be able to make a whole
 * show or a whole artist the target of an action (`groupScopeViolation`,
 * `src/lib/conditions/group-scope.ts`).
 *
 * A query evaluates every episode and track on its own — its grouped series
 * view lists the episodes each show matched through — so it judges like a
 * rule set with series or artist scope off. An action that acts on the whole
 * Sonarr series or Lidarr artist (Delete from Sonarr or Lidarr, Change Quality
 * Profile, Unmonitor & Delete Files, Monitor & Delete Files, Lidarr's
 * Unmonitor Only and Search for New Copy, tags, a Lidarr file delete's search
 * after — and, in the grouped series view, Sonarr's Unmonitor Only and Search
 * for New Copy, which act on the whole series there) may then follow only the
 * criteria every member of a show or artist answers alike. "Resolution = 4K"
 * and Delete from Sonarr deleted every show with a single 4K episode.
 *
 * The same predicate and field list as a rule set with the scope off and that
 * action: `POST /api/query/actions` refuses such a run (400, the reason from
 * `queryActionScopeError`) and the Query page's action bar offers the actions
 * disabled with that reason. Actions on the matched members only — the file
 * deletes, and Sonarr's Unmonitor and Search in episode view — stay allowed.
 *
 * Client-safe.
 */
import { actionCanScopeToEpisodes } from "@/lib/lifecycle/action-types";
import {
  GROUP_SCOPE_TERMS,
  groupScopeBlockedLabels,
  groupScopeViolation,
  type GroupScopeType,
  type GroupScopeViolation,
} from "@/lib/conditions/group-scope";

/** A Query page action as far as the gate reads it. */
export interface QueryActionScopeConfig {
  actionType: string;
  addArrTags?: readonly string[] | null;
  removeArrTags?: readonly string[] | null;
  searchAfterAction?: boolean | null;
}

/**
 * Whether the action runs on the matched episodes rather than the whole
 * series: Sonarr's Unmonitor Only and Search for New Copy in the episode view
 * (`includeEpisodes`), as `POST /api/query/actions` runs them.
 */
export function queryActionEpisodeScope(type: string, includeEpisodes: boolean | null | undefined, actionType: string): boolean {
  return type === "SERIES" && !!includeEpisodes && actionCanScopeToEpisodes(actionType);
}

/**
 * Why running `config` on the results of a query with these criteria could
 * let one episode or track decide for a whole show or artist, or null:
 * `groupScopeViolation` with the scope off (a query judges each episode or
 * track on its own) and the action as the route runs it.
 */
export function queryActionScopeViolation(
  type: string,
  criteria: unknown,
  includeEpisodes: boolean | null | undefined,
  config: QueryActionScopeConfig,
): GroupScopeViolation | null {
  return groupScopeViolation(type, false, criteria, {
    actionEnabled: true,
    actionType: config.actionType,
    addArrTags: config.addArrTags ?? [],
    removeArrTags: config.removeArrTags ?? [],
    searchAfterAction: config.searchAfterAction ?? false,
    episodeScope: queryActionEpisodeScope(type, includeEpisodes, config.actionType),
  });
}

/** The Query page's actions that act only on the matched episodes or tracks. */
const QUERY_MEMBER_ACTIONS: Record<GroupScopeType, string> = {
  SERIES: 'Delete Files Only, or Unmonitor Only or Search for New Copy with "Include individual episodes" on — without tags',
  MUSIC: "Delete Files Only, without Search after or tags",
};

/** The refusal: the route's 400 and the action bar's reason on hover. */
export function queryActionScopeError(violation: GroupScopeViolation): string {
  const t = GROUP_SCOPE_TERMS[violation.type];
  return (
    `"${violation.wholeRecordAction}" acts on the whole ${t.group}, so it can't follow query criteria that describe one ` +
    `${t.member} or file: ${groupScopeBlockedLabels(violation).join(", ")} — one matching ${t.member} would decide for the ` +
    `whole ${t.group}. Remove them from the query, or pick an action that acts only on the matched ${t.member}s ` +
    `(${QUERY_MEMBER_ACTIONS[violation.type]}).`
  );
}

/** What the action bar offers disabled for one action type, and why. */
export interface QueryActionGate {
  /** Why the action itself is offered disabled; "Do Nothing (tags only)" always carries tags. */
  action: string | null;
  /** Why its tag pickers are off (tags act on the whole show or artist). */
  tags: string | null;
  /** Why its Search after is off (a Lidarr file delete's search acts on the whole artist). */
  searchAfter: string | null;
}

/**
 * The gate for one action type on the Query page's action bar, from the
 * criteria and view of the run whose results are on screen.
 */
export function queryActionGate(
  type: string,
  criteria: unknown,
  includeEpisodes: boolean | null | undefined,
  actionType: string,
): QueryActionGate {
  const reasonFor = (config: QueryActionScopeConfig) => {
    const violation = queryActionScopeViolation(type, criteria, includeEpisodes, config);
    return violation ? queryActionScopeError(violation) : null;
  };
  // "Do Nothing" runs only with tags.
  const action = reasonFor({ actionType, addArrTags: actionType === "DO_NOTHING" ? ["tag"] : [] });
  return {
    action,
    tags: action ?? reasonFor({ actionType, addArrTags: ["tag"] }),
    searchAfter: action ?? reasonFor({ actionType, searchAfterAction: true }),
  };
}
