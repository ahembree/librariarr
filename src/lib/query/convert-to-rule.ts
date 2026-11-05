import type { z } from "zod/v4";
import type { ConditionGroup, LibraryType } from "@/lib/conditions";
import { groupScopeBlockedLabels, groupScopeViolation } from "@/lib/conditions/group-scope";
import type { ruleSetCreateSchema } from "@/lib/validation";
import type { QueryDefinition } from "@/lib/query/types";
import {
  countAllRulesIncludingDisabled,
  dropIncompatibleRules,
} from "@/components/builder/library-type-validity";

type RuleSetCreateBody = z.infer<typeof ruleSetCreateSchema>;

interface ConvertOptions {
  name: string;
  targetLibraryType: LibraryType;
  serverIds: string[];
}

export class ConvertQueryError extends Error {
  constructor(
    public readonly code:
      | "EMPTY_NAME"
      | "EMPTY_SERVERS"
      | "ALL_RULES_INCOMPATIBLE",
    message: string,
  ) {
    super(message);
    this.name = "ConvertQueryError";
  }
}

export function convertQueryToRuleSetBody(
  query: QueryDefinition,
  opts: ConvertOptions & {
    /**
     * Optional pre-computed pruned tree. The dialog passes its memoized
     * value to avoid running `dropIncompatibleRules` a second time on
     * submit. When omitted, the helper computes it itself.
     */
    cleanedGroups?: ConditionGroup[];
  },
): RuleSetCreateBody {
  if (!opts.name.trim()) {
    throw new ConvertQueryError("EMPTY_NAME", "Name is required");
  }
  if (opts.serverIds.length === 0) {
    throw new ConvertQueryError(
      "EMPTY_SERVERS",
      "At least one server is required for a lifecycle rule set",
    );
  }
  const cleaned =
    opts.cleanedGroups ??
    dropIncompatibleRules(query.groups, opts.targetLibraryType);
  // Reject both the "every group got pruned to empty" case and the
  // "some groups remain but they're all placeholders with no rules"
  // case. Either would produce a rule set that the engine evaluates to
  // a no-op, surprising the user.
  if (cleaned.length === 0 || countAllRulesIncludingDisabled(cleaned) === 0) {
    throw new ConvertQueryError(
      "ALL_RULES_INCOMPATIBLE",
      `No rules in this query are compatible with library type ${opts.targetLibraryType}`,
    );
  }
  const arrInstanceId = arrInstanceIdForType(
    opts.targetLibraryType,
    query.arrServerIds,
  );
  const scope = convertedScope(query, opts.targetLibraryType, cleaned);
  return {
    name: opts.name.trim(),
    type: opts.targetLibraryType,
    rules: cleaned as unknown as RuleSetCreateBody["rules"],
    serverIds: opts.serverIds,
    enabled: true,
    actionEnabled: false,
    ...(scope ? { seriesScope: scope.seriesScope } : {}),
    ...(arrInstanceId ? { arrInstanceId } : {}),
  };
}

/** The scope a converted Series or Music rule set gets, and why. */
export interface ConvertedScope {
  /** The rule set's `seriesScope`: whole shows or artists (true), or episodes or tracks. */
  seriesScope: boolean;
  /**
   * The query's criteria that describe one episode or track
   * (`groupScopeBlockedLabels`), which a whole-show or whole-artist rule may
   * not use and which therefore turned the scope off; empty when they did not.
   */
  blockedLabels: string[];
}

/**
 * The scope of the rule set a query converts to, or null for a movie rule set
 * (which has none). Shared by the body above and the dialog, which says it.
 *
 * - Series: `includeEpisodes` ("match individual episodes") is series scope
 *   off; a query grouped by show is series scope on.
 * - Music: artist scope on, the rule set default.
 *
 * Either is turned off when the query uses a criterion a whole-show or
 * whole-artist rule may not use (`groupScopeViolation`: Resolution, Year, a
 * stream query, …). The query evaluates those per episode or track, so with
 * the scope off the rule set selects what the query listed; with it on,
 * saving would be refused.
 */
export function convertedScope(
  query: QueryDefinition,
  targetLibraryType: LibraryType,
  cleanedGroups: ConditionGroup[],
): ConvertedScope | null {
  if (targetLibraryType === "MOVIE") return null;
  const wanted = targetLibraryType === "SERIES" ? !query.includeEpisodes : true;
  const violation = groupScopeViolation(targetLibraryType, wanted, cleanedGroups);
  if (!violation) return { seriesScope: wanted, blockedLabels: [] };
  return { seriesScope: false, blockedLabels: groupScopeBlockedLabels(violation) };
}

/**
 * The query builder lets a user pick an Arr instance per Arr type (radarr,
 * sonarr, lidarr). A lifecycle rule set is scoped to a single library type
 * and has one `arrInstanceId`, so we project the per-type selection down to
 * the one that matches the target library type.
 */
export function arrInstanceIdForType(
  targetLibraryType: LibraryType,
  arrServerIds: QueryDefinition["arrServerIds"],
): string | undefined {
  if (!arrServerIds) return undefined;
  switch (targetLibraryType) {
    case "MOVIE":
      return arrServerIds.radarr || undefined;
    case "SERIES":
      return arrServerIds.sonarr || undefined;
    case "MUSIC":
      return arrServerIds.lidarr || undefined;
  }
}
