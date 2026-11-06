import { prisma } from "@/lib/db";
import { compareIds } from "@/lib/conditions/compare-ids";
import type { LifecycleRule, LifecycleRuleGroup, LifecycleRuleCondition } from "./types";
import {
  isArrField, isSeerrField,
  isCrossSystemField,
  isStreamQueryField, isStreamQueryGroup,
  RULE_FIELDS, STREAM_QUERY_FIELDS, type RuleField,
} from "./types";
import {
  isEnumerableField, isOperatorApplicable, isValueValidForRule,
  hasActiveRules,
  hasArrRules as hasArrGroupRules,
  hasSeerrRules as hasSeerrGroupRules,
  hasWildcardRules as hasWildcardGroupRules,
  hasResolutionRules as hasResolutionGroupRules,
  hasArrayFieldRules as hasArrayFieldGroupRules,
  hasSeriesAggregateRules as hasSeriesAggregateGroupRules,
  hasStreamRules as hasStreamGroupRules,
  hasStreamCountRules as hasStreamCountGroupRules,
  hasCrossSystemRules as hasCrossSystemGroupRules,
  hasExternalIdFieldRules as hasExternalIdFieldGroupRules,
  hasCustomFormatScoreRules as hasCustomFormatScoreGroupRules,
  hasWatchedByUserRules as hasWatchedByUserGroupRules,
  hasPlayActivityRules as hasPlayActivityGroupRules,
} from "@/lib/conditions/helpers";
import { legacyRulesToGroups } from "./legacy";
import { normalizeResolutionLabel } from "@/lib/resolution";
import {
  pushDownGroupNegation,
  nullValueResult,
  MB_IN_BYTES,
  DURATION_MS_PER_MIN,
  wildcardToRegex,
  matchArrayField,
  matchExternalIdField,
  matchNameListField,
  withGroupParentTitle,
  isGroupRecord,
  episodesMatchingIndividually,
  matchGroupThroughMembers,
  memberValuesOf,
  readsMemberValues,
  readsEpisodeValues,
  withEvaluatedRecord,
  evaluatedRecordOf,
  isEveryMemberField,
  withEveryMemberValues,
  everyMemberValuesOf,
  type GroupSelection,
} from "@/lib/conditions";
import {
  isUnconfiguredContainsRule,
  ruleToWhere,
  STREAM_COUNT_FIELDS,
} from "@/lib/conditions/where-builder";
import {
  fetchCrossSystemData,
  crossSystemValuesOf,
  type CrossSystemDataOptions,
} from "@/lib/conditions/cross-system-data";
import type { Condition } from "@/lib/conditions/types";
import { hasStreamQueryInMemoryRules as hasStreamQueryInMemoryGroupRules } from "@/lib/conditions/stream-query-where";
import { evaluateStreamQueryGroupInMemory } from "@/lib/conditions/stream-query-eval";
import { buildGroupConditions, buildGroupConditionsPreFilter } from "@/lib/conditions/group-composition";
import { Prisma } from "@/generated/prisma/client";
import { resolveSeriesKey } from "@/lib/media/series-key";
import { COMPLETED_PLAY_FILTER } from "@/lib/media/watch-completion";
import { DATE_ONLY_FIELDS } from "@/lib/conditions/fields";
import { formatDateOnly } from "@/lib/format";
import { artistMbidOf, splitArtistGroupByMbid } from "@/lib/media/artist-key";
import { groupScopeHoldReason, groupScopeViolation, type GroupScopeType } from "@/lib/conditions/group-scope";
import { logger } from "@/lib/logger";

const STREAM_LANG_CODEC_FIELDS = new Set(["audioLanguage", "subtitleLanguage", "streamAudioCodec"]);
const STREAM_LANGUAGE_FIELDS = new Set(["audioLanguage", "subtitleLanguage"]);

export interface ArrMetadata {
  arrId: number;
  tags: string[];
  qualityProfile: string;
  monitored: boolean;
  rating: number | null;
  tmdbRating: number | null;
  rtCriticRating: number | null;
  // Shared
  dateAdded: string | null;
  path: string | null;
  sizeOnDisk: number | null;
  originalLanguage: string | null;
  // Radarr-specific
  releaseDate: string | null;
  inCinemasDate: string | null;
  runtime: number | null;
  qualityName: string | null;
  qualityCutoffMet: boolean | null;
  customFormatScore: number | null;
  downloadDate: string | null;
  // Sonarr-specific
  firstAired: string | null;
  seasonCount: number | null;
  episodeCount: number | null;
  status: string | null;
  ended: boolean | null;
  seriesType: string | null;
  hasUnaired: boolean | null;
  monitoredSeasonCount: number | null;
  monitoredEpisodeCount: number | null;
}

/** Lookup keyed by external ID (TMDB for movies, TVDB for series) */
export type ArrDataMap = Record<string, ArrMetadata>;

export interface SeerrMetadata {
  requested: boolean;
  requestCount: number;
  requestDate: string | null;
  requestedBy: string[];
  approvalDate: string | null;
  declineDate: string | null;
}

/**
 * Lookup keyed by `${source}:${externalId}` — e.g. `"TMDB:603"`, `"TVDB:81189"`.
 * The source prefix is required to avoid TMDB↔TVDB integer-ID collisions across the same map.
 */
export type SeerrDataMap = Record<string, SeerrMetadata>;

/**
 * Look up Seerr metadata for a media item, trying source IDs in priority order.
 * Movies look up by TMDB only; series prefer TVDB but fall back to TMDB.
 */
export function lookupSeerrMeta(
  externalIds: Array<{ source: string; externalId: string }>,
  seerrData: SeerrDataMap | undefined,
  type: string,
): SeerrMetadata | undefined {
  if (!seerrData) return undefined;
  const sources = type === "MOVIE" ? ["TMDB"] : type === "SERIES" ? ["TVDB", "TMDB"] : [];
  for (const source of sources) {
    const ext = externalIds.find((e) => e.source === source);
    if (!ext) continue;
    const meta = seerrData[`${source}:${ext.externalId}`];
    if (meta) return meta;
  }
  return undefined;
}

// Phase 1 rule → WHERE conversion is shared with the query builder via
// `ruleToWhere` in where-builder.ts (the two engines' dispatchers were
// equivalent). It's passed to buildGroupConditions below.

function isRuleGroups(input: LifecycleRule[] | LifecycleRuleGroup[]): input is LifecycleRuleGroup[] {
  return input.length > 0 && "rules" in input[0];
}

/**
 * Either rule shape as the group tree it is evaluated as. Every gate below
 * reads this, so a legacy flat rule set is gated exactly as the engine
 * evaluates it (`legacyRulesToGroups` keeps enabled rules only) and the
 * walks themselves live once, in `conditions/helpers.ts`.
 */
function asGroups(rules: LifecycleRule[] | LifecycleRuleGroup[]): LifecycleRuleGroup[] {
  return isRuleGroups(rules) ? rules : legacyRulesToGroups(rules as LifecycleRule[]);
}

/**
 * Check whether a rule set contains at least 1 enabled rule.
 * Returns false if all rules/groups are disabled or empty — lifecycle
 * processing requires at least 1 active rule to avoid matching everything.
 */
export function hasAnyActiveRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasActiveRules(asGroups(rules));
}

// Pre-filter variants for Phase 1 queries when Phase 2 in-memory re-eval
// will follow: non-DB-expressible rules (Arr/Seerr fields, wildcards, stream
// counts) produce EXTERNAL_RULE instead of being silently dropped. Legacy
// sets route through the group path (`legacyRulesToGroups`, `./legacy.ts`),
// which also gives them that EXTERNAL-aware pre-filter: an Arr/wildcard rule
// in an OR bucket no longer narrows the Phase 1 fetch below what Phase 2
// would match.

/** Check if any rule in the tree uses arr fields */
function hasArrRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasArrGroupRules(asGroups(rules));
}

/** Check if any rule in the tree uses seerr fields */
function hasSeerrRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasSeerrGroupRules(asGroups(rules));
}

/** Check if any rule uses wildcard operators on non-external fields */
function hasWildcardRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasWildcardGroupRules(asGroups(rules));
}

/** Resolution rules always evaluate in-memory (Phase 1 raw-value lists
 *  cannot express normalizeResolutionLabel semantics — see resolutionHandler) */
function hasResolutionRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasResolutionGroupRules(asGroups(rules));
}

/** JSON-array rules (`genre`, `labels`, `country`) always evaluate in-memory:
 *  `matchArrayField` is case-insensitive and reads a stored `[]` as empty,
 *  neither of which Prisma's case-sensitive `array_contains` / `DbNull`
 *  filters can express — see genreLabelsHandler. Membership comes from the
 *  shared `isArrayField` so this can't drift from the query engine's gate. */
function hasArrayFieldRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasArrayFieldGroupRules(asGroups(rules));
}

/** Check if any rule references a series-aggregate field (episodeCount,
 *  watchedEpisodePercentage, etc.). These can only be evaluated against an
 *  aggregated series record, never per-episode, so they force series-level
 *  (aggregate) evaluation regardless of seriesScope — mirroring the query
 *  engine's aggregateSeriesAndFilter path. */
function hasSeriesAggregateRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasSeriesAggregateGroupRules(asGroups(rules));
}

/**
 * Columns of a candidate row no rule reads, nothing in the series or artist
 * aggregation uses and detection's bookkeeping never consults: the cast and
 * crew lists (often the largest part of a row once a sync has enriched it),
 * the tagline and original title, the file path, and the server's playback
 * and analysis bookkeeping. The engines load every candidate of a library, so
 * each is read for every row; a match's stored snapshot is still the rest of
 * the row, and the detail panel a match opens reads the full record from
 * `/api/media/[id]`.
 */
export const UNREAD_ITEM_COLUMNS = {
  roles: true,
  directors: true,
  writers: true,
  tagline: true,
  originalTitle: true,
  filePath: true,
  viewOffset: true,
  chapterSource: true,
  absoluteIndex: true,
  optimizedForStreaming: true,
  serverUpdatedAt: true,
} as const;

/** Check if any rule uses stream fields or stream query groups */
function hasStreamRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasStreamGroupRules(asGroups(rules));
}

/** Check if any stream query group requires in-memory evaluation (computed/wildcard fields) */
function hasStreamQueryInMemoryRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasStreamQueryInMemoryGroupRules(asGroups(rules));
}

/** Check if any rule uses stream count fields (always require in-memory evaluation) */
function hasStreamCountRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasStreamCountGroupRules(asGroups(rules));
}

/** Check if any rule uses cross-system fields (always require in-memory evaluation) */
export function hasCrossSystemFieldRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasCrossSystemGroupRules(asGroups(rules));
}

/** Check if any rule uses hasExternalId field */
function hasExternalIdFieldRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasExternalIdFieldGroupRules(asGroups(rules));
}

/** Whether any rule reads Custom Format Score, the one Arr field fetched on demand. */
export function hasCustomFormatScoreRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasCustomFormatScoreGroupRules(asGroups(rules));
}

/**
 * Check if any rule uses the watchedByUser field (requires WatchHistory eager-load).
 * Accepts both grouped and flat rule shapes.
 */
export function hasWatchedByUserRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasWatchedByUserGroupRules(asGroups(rules));
}

/**
 * Whether any rule reads play activity — `watchedByUser`, `playCount`,
 * `lastPlayedAt`, or a series aggregate built on those. The trigger for the
 * watch-history half of the evaluability guard; see `hasPlayActivityRules` in
 * `conditions/helpers.ts` for why it is broader than `hasWatchedByUserRules`.
 *
 * Accepts both grouped and flat rule shapes, mirroring its sibling above.
 */
export function hasPlayActivityRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return hasPlayActivityGroupRules(asGroups(rules));
}

/**
 * Whether any rule reads a field a show or artist answers per member
 * (`readsMemberValues`): the group-scope engines and Test Media then judge a
 * group through each of its members; otherwise they evaluate it once.
 */
export function hasMemberValueRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return readsMemberValues(asGroups(rules));
}

/**
 * Whether any rule reads a field an episode answers on its own in a
 * per-episode run forced through the series path (`readsEpisodeValues`);
 * otherwise every episode of a show passes or fails alike.
 */
function hasEpisodeValueRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): boolean {
  return readsEpisodeValues(asGroups(rules));
}

/**
 * A show or artist evaluated as a whole (series or artist scope), judged
 * through its members (`matchGroupThroughMembers`): it matches when the group
 * record carrying one member's own per-member values satisfies the rules, the
 * first such member (lowest id) being the one it is stored and reported with —
 * and, when a rule reads a cross-system field (`everyMember`, each member's own
 * cross-system values), only when the rules hold for every member read with its
 * own values for those. Shared by `evaluateSeriesScope`, `evaluateMusicScope`
 * and Test Media so the three select alike. `perMember` is
 * `hasMemberValueRules(rules)`, computed once per run.
 */
export function evaluateGroupThroughMembers<M extends { id: string }>(
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  group: Record<string, unknown>,
  members: readonly M[],
  perMember: boolean,
  arrMeta?: ArrMetadata,
  seerrMeta?: SeerrMetadata,
  everyMember?: (member: M) => Record<string, unknown>,
): GroupSelection | null {
  return matchGroupThroughMembers(
    group,
    members,
    (record) => evaluateAllRulesInMemory(rules, record, arrMeta, seerrMeta),
    perMember,
    everyMember,
  );
}

/**
 * Evaluate a single Arr rule against Arr metadata for an item (Phase 2).
 * Shared with the query builder (exported as `evaluateQueryArrRule`) — typed on
 * the engine-neutral `Condition` so both callers use this one canonical
 * implementation rather than drifting copies.
 */
export function evaluateArrRule(rule: Condition, meta: ArrMetadata | undefined): boolean {
  // Safety: unconfigured contains/notContains matches nothing. Negate is
  // intentionally NOT applied — `!false` would otherwise sweep the library.
  // Checked before any field-specific branch so even nonsensical pairings
  // like `foundInArr contains ""` cannot leak into match-all behavior.
  if (isUnconfiguredContainsRule(rule.operator, rule.value)) return false;
  // Safety: unknown operator or wrong-type combo → match nothing (bypass negate).
  // foundInArr is a boolean; equals/notEquals are the only applicable operators.
  if (!isOperatorApplicable(rule.operator, rule.field)) return false;
  // Safety: malformed value → match nothing.
  if (!isValueValidForRule(rule.operator, rule.value, rule.field)) return false;
  // foundInArr must be checked before the !meta guard since it explicitly
  // tests for the presence/absence of Arr metadata
  if (rule.field === "foundInArr") {
    const found = meta !== undefined;
    // isNull / isNotNull carry no value, so they must be read as presence
    // checks on the Arr record itself rather than falling into the
    // equals/notEquals path below — there an empty value coerces to
    // `boolVal = false`, which made BOTH operators mean "not found in Arr".
    if (rule.operator === "isNull") return rule.negate ? found : !found;
    if (rule.operator === "isNotNull") return rule.negate ? !found : found;
    const boolVal = String(rule.value).toLowerCase() === "true";
    const result = rule.operator === "notEquals" ? found !== boolVal : found === boolVal;
    return rule.negate ? !result : result;
  }
  if (!meta) return false;
  const { field, operator, value, negate } = rule;
  let result: boolean;

  // Fail-closed NULL convention: when an item IS in Arr but a specific field is
  // null (e.g. a fileless movie has no qualityName), no comparison operator
  // matches — and crucially the per-field null guards below `return false`
  // DIRECTLY rather than `result = false; break`, so the trailing
  // `negate ? !result : result` flip can't turn a null into a match. This keeps
  // `arrX notEquals Y` and `NOT(arrX equals Y)` agreeing (both no-match) on
  // null, and never deletes an item on the strength of absent Arr data. Only
  // isNull/isNotNull (handled before each guard) intentionally match on null.
  switch (field) {
    case "arrTag": {
      // Tags are an always-present list — see `matchNameListField` for the
      // operator semantics shared with seerrRequestedBy / watchedByUser /
      // matchedByRuleSet (list-emptiness isNull, multi-select contains,
      // case-insensitive wildcards).
      const tagResult = matchNameListField(meta.tags, operator, value);
      if (tagResult === null) return false; // unknown operator: bypass negate
      result = tagResult;
      break;
    }
    case "arrQualityProfile": {
      // Non-nullable text: "no value" is the empty string, matching how the
      // engine treats non-nullable String columns (see field-metadata.ts).
      // Handled before the operator switch, whose `default` returned false
      // for both operators. The Arr mappers fall back to "Unknown", so in
      // practice isNull matches nothing and isNotNull matches every item
      // that resolved to an Arr record.
      if (operator === "isNull") { result = meta.qualityProfile === ""; break; }
      if (operator === "isNotNull") { result = meta.qualityProfile !== ""; break; }
      const strVal = String(value).toLowerCase();
      const profile = meta.qualityProfile.toLowerCase();
      switch (operator) {
        case "equals":
          result = profile === strVal;
          break;
        case "notEquals":
          result = profile !== strVal;
          break;
        case "contains": {
          // Enumerable multi-select — exact list membership against the
          // selected profile names, not substring search.
          const values = strVal.split("|").filter(Boolean);
          result = values.some((v) => profile === v);
          break;
        }
        case "notContains": {
          const values = strVal.split("|").filter(Boolean);
          result = !values.some((v) => profile === v);
          break;
        }
        case "matchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = re.test(meta.qualityProfile);
          break;
        }
        case "notMatchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = !re.test(meta.qualityProfile);
          break;
        }
        default:
          return false;
      }
      break;
    }
    case "arrMonitored": {
      // Non-nullable boolean: the value is always present on a resolved Arr
      // record, so isNull matches nothing and isNotNull matches every such
      // item — mirroring the UNSATISFIABLE / MATCH_ALL shapes Phase 1 builds
      // for non-nullable columns. Stated explicitly instead of falling into
      // `default: return false`, which made the two operators disagree under
      // negate. The builder hides both for this field (isOperatorVisible).
      if (operator === "isNull") { result = false; break; }
      if (operator === "isNotNull") { result = true; break; }
      const boolVal = String(value).toLowerCase() === "true";
      switch (operator) {
        case "equals":
          result = meta.monitored === boolVal;
          break;
        case "notEquals":
          result = meta.monitored !== boolVal;
          break;
        default:
          return false;
      }
      break;
    }
    case "arrRating": {
      if (operator === "isNull") { result = meta.rating === null; break; }
      if (operator === "isNotNull") { result = meta.rating !== null; break; }
      if (meta.rating === null) return false;
      const numVal = Number(value);
      switch (operator) {
        case "equals": result = meta.rating === numVal; break;
        case "notEquals": result = meta.rating !== numVal; break;
        case "greaterThan": result = meta.rating > numVal; break;
        case "greaterThanOrEqual": result = meta.rating >= numVal; break;
        case "lessThan": result = meta.rating < numVal; break;
        case "lessThanOrEqual": result = meta.rating <= numVal; break;
        case "between": {
          const [minStr, maxStr] = String(value).split(",");
          result = meta.rating >= Number(minStr) && meta.rating <= Number(maxStr);
          break;
        }
        default: return false;
      }
      break;
    }
    case "arrTmdbRating": {
      if (operator === "isNull") { result = meta.tmdbRating === null; break; }
      if (operator === "isNotNull") { result = meta.tmdbRating !== null; break; }
      if (meta.tmdbRating === null) return false;
      const numVal = Number(value);
      switch (operator) {
        case "equals": result = meta.tmdbRating === numVal; break;
        case "notEquals": result = meta.tmdbRating !== numVal; break;
        case "greaterThan": result = meta.tmdbRating > numVal; break;
        case "greaterThanOrEqual": result = meta.tmdbRating >= numVal; break;
        case "lessThan": result = meta.tmdbRating < numVal; break;
        case "lessThanOrEqual": result = meta.tmdbRating <= numVal; break;
        case "between": {
          const [minStr, maxStr] = String(value).split(",");
          result = meta.tmdbRating >= Number(minStr) && meta.tmdbRating <= Number(maxStr);
          break;
        }
        default: return false;
      }
      break;
    }
    case "arrRtCriticRating": {
      if (operator === "isNull") { result = meta.rtCriticRating === null; break; }
      if (operator === "isNotNull") { result = meta.rtCriticRating !== null; break; }
      if (meta.rtCriticRating === null) return false;
      const numVal = Number(value);
      switch (operator) {
        case "equals": result = meta.rtCriticRating === numVal; break;
        case "notEquals": result = meta.rtCriticRating !== numVal; break;
        case "greaterThan": result = meta.rtCriticRating > numVal; break;
        case "greaterThanOrEqual": result = meta.rtCriticRating >= numVal; break;
        case "lessThan": result = meta.rtCriticRating < numVal; break;
        case "lessThanOrEqual": result = meta.rtCriticRating <= numVal; break;
        case "between": {
          const [minStr, maxStr] = String(value).split(",");
          result = meta.rtCriticRating >= Number(minStr) && meta.rtCriticRating <= Number(maxStr);
          break;
        }
        default: return false;
      }
      break;
    }
    // --- Date fields ---
    case "arrDateAdded":
    case "arrReleaseDate":
    case "arrInCinemasDate":
    case "arrDownloadDate":
    case "arrFirstAired": {
      const dateStr =
        field === "arrDateAdded" ? meta.dateAdded :
        field === "arrReleaseDate" ? meta.releaseDate :
        field === "arrInCinemasDate" ? meta.inCinemasDate :
        field === "arrDownloadDate" ? meta.downloadDate :
        meta.firstAired;
      const itemDate = dateStr ? new Date(dateStr) : null;
      if (operator === "isNull") { result = !itemDate || isNaN(itemDate.getTime()); break; }
      if (operator === "isNotNull") { result = !!itemDate && !isNaN(itemDate.getTime()); break; }
      if (!itemDate || isNaN(itemDate.getTime())) return false;
      switch (operator) {
        case "before":
          result = itemDate < new Date(String(value));
          break;
        case "after":
          result = itemDate > new Date(String(value));
          break;
        case "inLastDays": {
          const daysAgo = new Date();
          daysAgo.setDate(daysAgo.getDate() - Number(value));
          result = itemDate >= daysAgo;
          break;
        }
        case "notInLastDays": {
          const daysAgo = new Date();
          daysAgo.setDate(daysAgo.getDate() - Number(value));
          result = itemDate < daysAgo;
          break;
        }
        case "equals":
          result =
            itemDate.toISOString().split("T")[0] ===
            new Date(String(value)).toISOString().split("T")[0];
          break;
        case "notEquals":
          result =
            itemDate.toISOString().split("T")[0] !==
            new Date(String(value)).toISOString().split("T")[0];
          break;
        case "between": {
          const [fromStr, toStr] = String(value).split(",");
          const itemDay = itemDate.toISOString().split("T")[0];
          // Normalize bounds through Date so non-padded inputs ("2024-1-1")
          // compare correctly — the raw strings were compared lexically.
          const fromDay = new Date(fromStr).toISOString().split("T")[0];
          const toDay = new Date(toStr).toISOString().split("T")[0];
          result = itemDay >= fromDay && itemDay <= toDay;
          break;
        }
        default:
          return false;
      }
      break;
    }
    // --- Numeric fields (sizeOnDisk stored as bytes, user inputs MB) ---
    case "arrSizeOnDisk": {
      if (operator === "isNull") { result = meta.sizeOnDisk === null; break; }
      if (operator === "isNotNull") { result = meta.sizeOnDisk !== null; break; }
      if (meta.sizeOnDisk === null) return false;
      const sizeMB = meta.sizeOnDisk / (1024 * 1024);
      const numVal = Number(value);
      switch (operator) {
        case "equals": result = sizeMB === numVal; break;
        case "notEquals": result = sizeMB !== numVal; break;
        case "greaterThan": result = sizeMB > numVal; break;
        case "greaterThanOrEqual": result = sizeMB >= numVal; break;
        case "lessThan": result = sizeMB < numVal; break;
        case "lessThanOrEqual": result = sizeMB <= numVal; break;
        case "between": {
          const [minStr, maxStr] = String(value).split(",");
          result = sizeMB >= Number(minStr) && sizeMB <= Number(maxStr);
          break;
        }
        default: return false;
      }
      break;
    }
    case "arrRuntime":
    case "arrSeasonCount":
    case "arrEpisodeCount":
    case "arrCustomFormatScore":
    case "arrMonitoredSeasonCount":
    case "arrMonitoredEpisodeCount": {
      const metaVal =
        field === "arrRuntime" ? meta.runtime :
        field === "arrSeasonCount" ? meta.seasonCount :
        field === "arrEpisodeCount" ? meta.episodeCount :
        field === "arrCustomFormatScore" ? meta.customFormatScore :
        field === "arrMonitoredSeasonCount" ? meta.monitoredSeasonCount :
        meta.monitoredEpisodeCount;
      if (operator === "isNull") { result = metaVal === null; break; }
      if (operator === "isNotNull") { result = metaVal !== null; break; }
      if (metaVal === null) return false;
      const numVal = Number(value);
      switch (operator) {
        case "equals": result = metaVal === numVal; break;
        case "notEquals": result = metaVal !== numVal; break;
        case "greaterThan": result = metaVal > numVal; break;
        case "greaterThanOrEqual": result = metaVal >= numVal; break;
        case "lessThan": result = metaVal < numVal; break;
        case "lessThanOrEqual": result = metaVal <= numVal; break;
        case "between": {
          const [minStr, maxStr] = String(value).split(",");
          result = metaVal >= Number(minStr) && metaVal <= Number(maxStr);
          break;
        }
        default: return false;
      }
      break;
    }
    // --- Boolean fields ---
    case "arrQualityCutoffMet":
    case "arrEnded":
    case "arrHasUnaired": {
      const metaVal =
        field === "arrQualityCutoffMet" ? meta.qualityCutoffMet :
        field === "arrEnded" ? meta.ended :
        meta.hasUnaired;
      // Handle isNull/isNotNull before the null guard, otherwise items
      // with a null value can't be matched by either operator and
      // `isNull negate:true` would flip the always-false default to "match all".
      if (operator === "isNull") { result = metaVal === null; break; }
      if (operator === "isNotNull") { result = metaVal !== null; break; }
      if (metaVal === null) return false;
      const boolVal = String(value).toLowerCase() === "true";
      switch (operator) {
        case "equals": result = metaVal === boolVal; break;
        case "notEquals": result = metaVal !== boolVal; break;
        default: return false;
      }
      break;
    }
    // --- Text fields ---
    case "arrPath":
    case "arrOriginalLanguage":
    case "arrQualityName":
    case "arrStatus":
    case "arrSeriesType": {
      const metaVal =
        field === "arrPath" ? meta.path :
        field === "arrOriginalLanguage" ? meta.originalLanguage :
        field === "arrQualityName" ? meta.qualityName :
        field === "arrStatus" ? meta.status :
        meta.seriesType;
      // Handle isNull/isNotNull before the null guard, otherwise items
      // with a null value can't be matched by either operator and
      // `isNull negate:true` would flip the always-false default to "match all".
      if (operator === "isNull") { result = metaVal === null; break; }
      if (operator === "isNotNull") { result = metaVal !== null; break; }
      if (metaVal === null) return false;
      const strVal = String(value).toLowerCase();
      const metaLower = metaVal.toLowerCase();
      const enumerable = isEnumerableField(field);
      switch (operator) {
        case "equals":
          result = metaLower === strVal;
          break;
        case "notEquals":
          result = metaLower !== strVal;
          break;
        case "contains": {
          const values = strVal.split("|").filter(Boolean);
          result = enumerable
            ? values.some((v) => metaLower === v)
            : values.some((v) => metaLower.includes(v));
          break;
        }
        case "notContains": {
          const values = strVal.split("|").filter(Boolean);
          result = enumerable
            ? !values.some((v) => metaLower === v)
            : !values.some((v) => metaLower.includes(v));
          break;
        }
        case "matchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = re.test(metaVal);
          break;
        }
        case "notMatchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = !re.test(metaVal);
          break;
        }
        default:
          return false;
      }
      break;
    }
    default:
      return false;
  }

  return negate ? !result : result;
}

/** Comparison operators a Seerr date field supports (isNull/isNotNull aside). */
const SEERR_DATE_OPERATORS = new Set([
  "before",
  "after",
  "inLastDays",
  "notInLastDays",
  "equals",
  "notEquals",
  "between",
]);

/** Evaluate a single seerr rule against seerr metadata for an item */
/**
 * Evaluate a single Seerr rule against Seerr metadata (Phase 2). Shared with
 * the query builder (exported as `evaluateQuerySeerrRule`).
 */
export function evaluateSeerrRule(rule: Condition, meta: SeerrMetadata | undefined): boolean {
  // Safety: unconfigured contains/notContains matches nothing (ignoring negate).
  if (isUnconfiguredContainsRule(rule.operator, rule.value)) return false;
  // Safety: unknown operator or wrong-type combo → match nothing (bypass negate).
  if (!isOperatorApplicable(rule.operator, rule.field)) return false;
  // Safety: malformed value → match nothing.
  if (!isValueValidForRule(rule.operator, rule.value, rule.field)) return false;
  const { field, operator, value, negate } = rule;
  let result: boolean;

  const defaultMeta: SeerrMetadata = {
    requested: false,
    requestCount: 0,
    requestDate: null,
    requestedBy: [],
    approvalDate: null,
    declineDate: null,
  };
  const m = meta ?? defaultMeta;

  switch (field) {
    case "seerrRequested": {
      // Non-nullable boolean (missing metadata falls back to `defaultMeta`,
      // which still sets it), so isNull matches nothing and isNotNull matches
      // everything — the UNSATISFIABLE / MATCH_ALL pair Phase 1 builds for
      // non-nullable columns. Explicit rather than falling into
      // `default: return false`, which made both operators match nothing.
      // The builder hides both for this field (isOperatorVisible).
      if (operator === "isNull") { result = false; break; }
      if (operator === "isNotNull") { result = true; break; }
      const boolVal = String(value).toLowerCase() === "true";
      switch (operator) {
        case "equals":
          result = m.requested === boolVal;
          break;
        case "notEquals":
          result = m.requested !== boolVal;
          break;
        default:
          return false;
      }
      break;
    }
    case "seerrRequestCount": {
      // Non-nullable number (0 when never requested) — same trivial
      // isNull / isNotNull pair as seerrRequested above.
      if (operator === "isNull") { result = false; break; }
      if (operator === "isNotNull") { result = true; break; }
      const numVal = Number(value);
      switch (operator) {
        case "equals":
          result = m.requestCount === numVal;
          break;
        case "notEquals":
          result = m.requestCount !== numVal;
          break;
        case "greaterThan":
          result = m.requestCount > numVal;
          break;
        case "greaterThanOrEqual":
          result = m.requestCount >= numVal;
          break;
        case "lessThan":
          result = m.requestCount < numVal;
          break;
        case "lessThanOrEqual":
          result = m.requestCount <= numVal;
          break;
        case "between": {
          const [minStr, maxStr] = String(value).split(",");
          result = m.requestCount >= Number(minStr) && m.requestCount <= Number(maxStr);
          break;
        }
        default:
          return false;
      }
      break;
    }
    case "seerrRequestDate":
    case "seerrApprovalDate":
    case "seerrDeclineDate": {
      const dateStr =
        field === "seerrRequestDate" ? m.requestDate :
        field === "seerrApprovalDate" ? m.approvalDate :
        m.declineDate;
      const itemDate = dateStr ? new Date(dateStr) : null;
      if (operator === "isNull") { result = !itemDate || isNaN(itemDate.getTime()); break; }
      if (operator === "isNotNull") { result = !!itemDate && !isNaN(itemDate.getTime()); break; }
      if (!SEERR_DATE_OPERATORS.has(operator)) return false; // unknown operator: bypass negate
      // No such date (never requested / approved / declined). Every comparison
      // is false except notEquals — an item with no request date certainly was
      // not requested on D — and negate then applies as usual: the same
      // two-valued semantics the library's own date columns use
      // (nullValueResult + applyNegateNullable). NOT(notEquals D), i.e.
      // "equals D", therefore never matches a never-requested item, while
      // NOT(requested in the last 90 days) keeps matching one.
      if (!itemDate || isNaN(itemDate.getTime())) {
        result = operator === "notEquals";
        break;
      }
      switch (operator) {
        case "before":
          result = itemDate < new Date(String(value));
          break;
        case "after":
          result = itemDate > new Date(String(value));
          break;
        case "inLastDays": {
          const daysAgo = new Date();
          daysAgo.setDate(daysAgo.getDate() - Number(value));
          result = itemDate >= daysAgo;
          break;
        }
        case "notInLastDays": {
          const daysAgo = new Date();
          daysAgo.setDate(daysAgo.getDate() - Number(value));
          result = itemDate < daysAgo;
          break;
        }
        case "equals":
          result =
            itemDate.toISOString().split("T")[0] ===
            new Date(String(value)).toISOString().split("T")[0];
          break;
        case "notEquals":
          result =
            itemDate.toISOString().split("T")[0] !==
            new Date(String(value)).toISOString().split("T")[0];
          break;
        case "between": {
          const [fromStr, toStr] = String(value).split(",");
          const itemDay = itemDate.toISOString().split("T")[0];
          // Normalize bounds through Date so non-padded inputs ("2024-1-1")
          // compare correctly — the raw strings were compared lexically.
          const fromDay = new Date(fromStr).toISOString().split("T")[0];
          const toDay = new Date(toStr).toISOString().split("T")[0];
          result = itemDay >= fromDay && itemDay <= toDay;
          break;
        }
        default:
          return false;
      }
      break;
    }
    case "seerrRequestedBy": {
      // Requesters are an always-present list — same shared semantics as
      // arrTag / watchedByUser / matchedByRuleSet. This branch previously had
      // no wildcard cases and fell through to `default`, so a "Requested By
      // matches …" rule (an operator the builder offers on every text field)
      // silently matched nothing in both directions.
      const requesterResult = matchNameListField(m.requestedBy, operator, value);
      if (requesterResult === null) return false; // unknown operator: bypass negate
      result = requesterResult;
      break;
    }
    default:
      return false;
  }

  return negate ? !result : result;
}

interface MatchedCriterion {
  ruleId: string;
  field: string;
  operator: string;
  value: string;
  negate: boolean;
  groupName?: string;
  actualValue?: string;
}

/** Evaluate a single rule against an item's in-memory data (mirrors DB logic) */
function evaluateRuleAgainstItem(
  rule: LifecycleRule,
  item: Record<string, unknown>,
  arrMeta?: ArrMetadata,
  seerrMeta?: SeerrMetadata
): boolean {
  // Safety: unconfigured contains/notContains matches nothing (ignoring negate).
  // Mirrors `ruleToWhere`'s UNSATISFIABLE_WHERE so Phase 1 and Phase 2 agree.
  if (isUnconfiguredContainsRule(rule.operator, rule.value)) return false;
  // Safety: unknown operator or operator/field-type mismatch → match nothing.
  // Without this, `default: result = false` in any operator switch would be
  // vacuously flipped to true by negate=true and sweep the library.
  if (!isOperatorApplicable(rule.operator, rule.field)) return false;
  // Safety: malformed value (NaN, unparseable date, etc.) → match nothing,
  // bypassing negate.
  if (!isValueValidForRule(rule.operator, rule.value, rule.field)) return false;

  const { field, operator, value, negate } = rule;

  // Misplaced stream-query field (only valid inside stream-query groups,
  // which evaluate through evaluateStreamQueryGroupInMemory) → dead rule.
  if (isStreamQueryField(field)) return false;

  if (isArrField(field)) {
    return evaluateArrRule(rule, arrMeta);
  }

  if (isSeerrField(field)) {
    return evaluateSeerrRule(rule, seerrMeta);
  }

  // Stream language/codec fields
  if (STREAM_LANG_CODEC_FIELDS.has(field)) {
    const streams = (item.streams as Array<{ streamType: number; language: string | null; codec: string | null }>) ?? [];
    const streamType = field === "subtitleLanguage" ? 3 : 2;
    const streamField = field === "streamAudioCodec" ? "codec" : "language";
    const isLangField = STREAM_LANGUAGE_FIELDS.has(field);
    const streamValues = streams
      .filter((s) => s.streamType === streamType)
      .map((s) => (s[streamField] ?? "").toLowerCase())
      // For language fields, exclude unknown/empty values so they don't produce false matches
      .filter((sv) => !isLangField || (sv !== "" && sv !== "unknown"));

    // isNull/isNotNull check whether any known values exist. Codec parity:
    // Phase 1 uses `codec IS NOT NULL`, which counts empty-string codecs as
    // known — so test the RAW value here instead of the ""-coalesced list.
    if (operator === "isNull" || operator === "isNotNull") {
      const hasKnown = streams
        .filter((st) => st.streamType === streamType)
        .some((st) => {
          const v = st[streamField];
          if (v == null) return false;
          if (isLangField) {
            const lv = String(v).toLowerCase();
            return lv !== "" && lv !== "unknown";
          }
          return true;
        });
      const result = operator === "isNull" ? !hasKnown : hasKnown;
      return negate ? !result : result;
    }

    // An item with NO KNOWN language of this type must not match a language
    // rule under ANY operator — "Unknown" != "English" must not read as true
    // (see the "unknown language filtering" tests). Bypasses `negate`, like
    // every other dead-rule guard. Phase 1 enforces the same thing by ANDing a
    // "has a known language" conjunct onto the negated operators; without it
    // the two phases disagreed and the same rule matched a different set
    // depending on whether something else in the rule set forced Phase 2.
    if (isLangField && streamValues.length === 0) return false;

    const strValue = String(value).toLowerCase();
    let result: boolean;
    switch (operator) {
      case "equals":
        result = streamValues.some((sv) => sv === strValue);
        break;
      case "notEquals":
        result = !streamValues.some((sv) => sv === strValue);
        break;
      case "contains": {
        // Enumerable multi-select — exact list membership against stream values.
        const values = strValue.split("|").filter(Boolean);
        result = values.some((v) => streamValues.some((sv) => sv === v));
        break;
      }
      case "notContains": {
        const values = strValue.split("|").filter(Boolean);
        result = !values.some((v) => streamValues.some((sv) => sv === v));
        break;
      }
      case "matchesWildcard": {
        const re = wildcardToRegex(strValue);
        result = streamValues.some((sv) => re.test(sv));
        break;
      }
      case "notMatchesWildcard": {
        const re = wildcardToRegex(strValue);
        result = !streamValues.some((sv) => re.test(sv));
        break;
      }
      default: return false;
    }
    return negate ? !result : result;
  }

  // Stream count fields
  if (STREAM_COUNT_FIELDS.has(field)) {
    const streams = (item.streams as Array<{ streamType: number }>) ?? [];
    const streamType = field === "audioStreamCount" ? 2 : 3;
    const count = streams.filter((s) => s.streamType === streamType).length;
    const numValue = Number(value);
    let result: boolean;
    switch (operator) {
      case "equals": result = count === numValue; break;
      case "notEquals": result = count !== numValue; break;
      case "greaterThan": result = count > numValue; break;
      case "greaterThanOrEqual": result = count >= numValue; break;
      case "lessThan": result = count < numValue; break;
      case "lessThanOrEqual": result = count <= numValue; break;
      case "between": {
        const [minStr, maxStr] = String(value).split(",");
        result = count >= Number(minStr) && count <= Number(maxStr);
        break;
      }
      // Computed counts are never NULL — "is empty" reads as "has none".
      case "isNull": result = count === 0; break;
      case "isNotNull": result = count > 0; break;
      default: return false;
    }
    return negate ? !result : result;
  }

  // Genre / Labels / Country (JSON array fields) — evaluated via the shared
  // `matchArrayField` (case-insensitive; see Bug 5 regression) so this
  // post-filter is identical to the query engine's and can't drift.
  if (field === "genre" || field === "labels" || field === "country") {
    const sourceCol = field === "labels" ? "labels" : field === "country" ? "countries" : "genres";
    const result = matchArrayField(item[sourceCol], operator, String(value));
    // Unknown operator (null) → match nothing, bypassing negate (never fail open).
    if (result === null) return false;
    return negate ? !result : result;
  }

  // Has External ID — via the shared `matchExternalIdField` so this and the
  // query engine can't drift (they previously carried identical inline copies,
  // which is how the isNull/isNotNull sweep existed in both).
  if (field === "hasExternalId") {
    const result = matchExternalIdField(item.externalIds, operator, String(value));
    // Unknown operator (null) → match nothing, bypassing negate (never fail open).
    if (result === null) return false;
    return negate ? !result : result;
  }

  // Is Watchlisted (boolean)
  if (field === "isWatchlisted") {
    // Non-nullable Boolean: isNotNull is the always-true tautology, isNull
    // the always-false one (mirrors Phase 1's MATCH_ALL/UNSATISFIABLE — see
    // isWatchlistedHandler). Without these, Phase 2's default:false diverged
    // from a Phase 1 that matched the whole library.
    if (operator === "isNotNull") return negate ? false : true;
    if (operator === "isNull") return negate ? true : false;
    const boolVal = String(value).toLowerCase() === "true";
    const itemVal = !!item.isWatchlisted;
    let result: boolean;
    switch (operator) {
      case "equals": result = itemVal === boolVal; break;
      case "notEquals": result = itemVal !== boolVal; break;
      default: return false;
    }
    return negate ? !result : result;
  }

  // Watched By User — checks the per-user WatchHistory rows attached to the
  // item. For series/music aggregates, the engine flattens episode/track
  // history into `watchedByUsers: string[]` (deduped lowercase usernames);
  // for individual movies/episodes/tracks we read `watchHistory` directly.
  // Either source produces the same `users` list, so the operator branches
  // are identical to the seerrRequestedBy handler above.
  if (field === "watchedByUser") {
    // `watchedByUsers` is the aggregated (series/artist) shape; individual
    // items carry the raw `watchHistory` rows instead. Operator semantics are
    // shared with arrTag / seerrRequestedBy / matchedByRuleSet.
    const aggregated = Array.isArray(item.watchedByUsers)
      ? (item.watchedByUsers as string[])
      : null;
    const users = aggregated ?? (
      Array.isArray(item.watchHistory)
        ? (item.watchHistory as Array<{ serverUsername: string | null }>)
            .map((h) => h.serverUsername ?? "")
            .filter(Boolean)
        : []
    );
    const userResult = matchNameListField(users, operator, value);
    if (userResult === null) return false; // unknown operator: bypass negate
    return negate ? !userResult : userResult;
  }

  // Cross-system fields — enriched by fetchCrossSystemData before Phase 2
  if (isCrossSystemField(field)) {
    if (field === "serverCount") {
      const count = Number(item.serverCount ?? 1);
      const ruleNum = Number(value);
      if (operator === "isNull") return negate ? true : false;
      if (operator === "isNotNull") return negate ? false : true;
      let result: boolean;
      switch (operator) {
        case "equals": result = count === ruleNum; break;
        case "notEquals": result = count !== ruleNum; break;
        case "greaterThan": result = count > ruleNum; break;
        case "greaterThanOrEqual": result = count >= ruleNum; break;
        case "lessThan": result = count < ruleNum; break;
        case "lessThanOrEqual": result = count <= ruleNum; break;
        case "between": {
          const [minStr, maxStr] = String(value).split(",");
          result = count >= Number(minStr) && count <= Number(maxStr);
          break;
        }
        default: return false;
      }
      return negate ? !result : result;
    }
    if (field === "matchedByRuleSet") {
      // Rule-set names are an always-present list — same shared semantics as
      // arrTag / seerrRequestedBy / watchedByUser. This branch previously had
      // no wildcard cases (and was duplicated byte-for-byte in the query
      // engine), so a "Matched By Rule Set matches …" rule silently matched
      // nothing in both directions.
      const setResult = matchNameListField(item.matchedRuleSets, operator, value);
      if (setResult === null) return false; // unknown operator: bypass negate
      return negate ? !setResult : setResult;
    }
    if (field === "hasPendingAction") {
      const hasPending = !!item.hasPendingAction;
      // Always-present boolean (coalesced from the enrichment), so isNull
      // matches nothing and isNotNull matches everything — the same trivial
      // pair serverCount uses just above, and what Phase 1 builds for a
      // non-nullable column. Without these the valueless operators fell into
      // `default: return false` and matched nothing in either polarity, even
      // though the builder offered them. The builder now hides both here.
      if (operator === "isNull") return negate ? true : false;
      if (operator === "isNotNull") return negate ? false : true;
      const boolVal = String(value).toLowerCase() === "true";
      let result: boolean;
      switch (operator) {
        case "equals": result = hasPending === boolVal; break;
        case "notEquals": result = hasPending !== boolVal; break;
        default: return false;
      }
      return negate ? !result : result;
    }
    return false;
  }

  const itemValue = item[field];

  // isNull/isNotNull — universal check for all remaining fields
  if (operator === "isNull" || operator === "isNotNull") {
    const isEmpty = itemValue === null || itemValue === undefined || itemValue === "";
    const result = operator === "isNull" ? isEmpty : !isEmpty;
    return negate ? !result : result;
  }

  // File size: rule value is in MB, item.fileSize is serialized bytes string
  if (field === "fileSize") {
    if (operator === "isNull" || operator === "isNotNull") {
      const present = item.fileSize != null;
      const r = operator === "isNull" ? !present : present;
      return negate ? !r : r;
    }
    if (item.fileSize == null) {
      // NULL semantics mirror the Phase 1 clause shapes — see nullValueResult
      const r = nullValueResult(operator);
      return negate ? !r : r;
    }
    const fileBytes = BigInt(item.fileSize as string);
    // `between` carries a "min,max" pair — parse per-half before the
    // single-value conversion below, which throws RangeError on BigInt(NaN)
    // for any comma value.
    if (operator === "between") {
      const [minStr, maxStr] = String(value).split(",");
      const minBytes = BigInt(Math.round(Number(minStr) * MB_IN_BYTES));
      const maxBytes = BigInt(Math.round(Number(maxStr) * MB_IN_BYTES));
      const result = fileBytes >= minBytes && fileBytes <= maxBytes;
      return negate ? !result : result;
    }
    const bytesValue = BigInt(Math.round(Number(value) * MB_IN_BYTES));
    let result: boolean;
    switch (operator) {
      case "greaterThan": result = fileBytes > bytesValue; break;
      case "greaterThanOrEqual": result = fileBytes >= bytesValue; break;
      case "lessThan": result = fileBytes < bytesValue; break;
      case "lessThanOrEqual": result = fileBytes <= bytesValue; break;
      case "equals": result = fileBytes === bytesValue; break;
      case "notEquals": result = fileBytes !== bytesValue; break;
      default: return false;
    }
    return negate ? !result : result;
  }

  // Duration: rule value is in minutes, item.duration is in milliseconds
  if (field === "duration") {
    if (operator === "isNull" || operator === "isNotNull") {
      const present = itemValue != null;
      const r = operator === "isNull" ? !present : present;
      return negate ? !r : r;
    }
    if (itemValue == null) {
      // NULL semantics mirror the Phase 1 clause shapes — see nullValueResult
      const r = nullValueResult(operator);
      return negate ? !r : r;
    }
    const msValue = Number(value) * DURATION_MS_PER_MIN;
    const itemMs = Number(itemValue);
    let result: boolean;
    switch (operator) {
      case "greaterThan": result = itemMs > msValue; break;
      case "greaterThanOrEqual": result = itemMs >= msValue; break;
      case "lessThan": result = itemMs < msValue; break;
      case "lessThanOrEqual": result = itemMs <= msValue; break;
      case "equals": result = Math.round(itemMs) === Math.round(msValue); break;
      case "notEquals": result = Math.round(itemMs) !== Math.round(msValue); break;
      case "between": {
        const [minStr, maxStr] = String(value).split(",");
        result = itemMs >= Number(minStr) * DURATION_MS_PER_MIN && itemMs <= Number(maxStr) * DURATION_MS_PER_MIN;
        break;
      }
      default: return false;
    }
    return negate ? !result : result;
  }

  // Date fields
  const dateFields = new Set([
    "lastPlayedAt", "addedAt", "originallyAvailableAt",
    "latestEpisodeViewDate", "lastEpisodeAddedAt", "lastEpisodeAiredAt", "seriesLastPlayedAt",
  ]);
  if (dateFields.has(field)) {
    const itemDate = itemValue ? new Date(itemValue as string) : null;
    const validDate = itemDate !== null && !isNaN(itemDate.getTime());
    if (operator === "isNull" || operator === "isNotNull") {
      const present = validDate;
      const r = operator === "isNull" ? !present : present;
      return negate ? !r : r;
    }
    if (!validDate) {
      // NULL semantics mirror the Phase 1 clause shapes — see nullValueResult
      const r = nullValueResult(operator);
      return negate ? !r : r;
    }
    let result: boolean;
    {
      switch (operator) {
        case "before": result = itemDate < new Date(String(value)); break;
        case "after": result = itemDate > new Date(String(value)); break;
        case "inLastDays": {
          const daysAgo = new Date();
          daysAgo.setDate(daysAgo.getDate() - Number(value));
          result = itemDate >= daysAgo;
          break;
        }
        case "notInLastDays": {
          const daysAgo = new Date();
          daysAgo.setDate(daysAgo.getDate() - Number(value));
          result = itemDate < daysAgo;
          break;
        }
        case "equals":
          result = itemDate.toISOString().split("T")[0] === new Date(String(value)).toISOString().split("T")[0];
          break;
        case "notEquals":
          result = itemDate.toISOString().split("T")[0] !== new Date(String(value)).toISOString().split("T")[0];
          break;
        case "between": {
          const [fromStr, toStr] = String(value).split(",");
          const itemDay = itemDate.toISOString().split("T")[0];
          // Normalize bounds through Date so non-padded inputs ("2024-1-1")
          // compare correctly — the raw strings were compared lexically.
          const fromDay = new Date(fromStr).toISOString().split("T")[0];
          const toDay = new Date(toStr).toISOString().split("T")[0];
          result = itemDay >= fromDay && itemDay <= toDay;
          break;
        }
        default: return false;
      }
    }
    return negate ? !result : result;
  }

  // Numeric fields
  const numericFields = new Set([
    "playCount", "videoBitrate", "audioChannels", "year",
    "videoBitDepth", "audioSamplingRate", "audioBitrate",
    "rating", "audienceRating", "ratingCount",
    "availableEpisodeCount", "watchedEpisodeCount", "watchedEpisodePercentage",
  ]);
  if (numericFields.has(field)) {
    if (operator === "isNull" || operator === "isNotNull") {
      const present = itemValue != null;
      const r = operator === "isNull" ? !present : present;
      return negate ? !r : r;
    }
    if (itemValue == null) {
      // NULL semantics mirror the Phase 1 clause shapes — see nullValueResult
      const r = nullValueResult(operator);
      return negate ? !r : r;
    }
    const numValue = Number(value);
    const itemNum = Number(itemValue);
    let result: boolean;
    switch (operator) {
      case "equals": result = itemNum === numValue; break;
      case "notEquals": result = itemNum !== numValue; break;
      case "greaterThan": result = itemNum > numValue; break;
      case "greaterThanOrEqual": result = itemNum >= numValue; break;
      case "lessThan": result = itemNum < numValue; break;
      case "lessThanOrEqual": result = itemNum <= numValue; break;
      case "between": {
        const [minStr, maxStr] = String(value).split(",");
        result = itemNum >= Number(minStr) && itemNum <= Number(maxStr);
        break;
      }
      default: return false;
    }
    return negate ? !result : result;
  }

  // Resolution field — normalize DB value to display label before comparing
  if (field === "resolution") {
    const rawRes = itemValue != null ? String(itemValue) : null;
    if (operator === "isNull" || operator === "isNotNull") {
      const present = rawRes !== null && rawRes !== "";
      const r = operator === "isNull" ? !present : present;
      return negate ? !r : r;
    }
    if (rawRes === null || rawRes === "") {
      // NULL semantics mirror the Phase 1 clause shapes — see nullValueResult
      const r = nullValueResult(operator);
      return negate ? !r : r;
    }
    const normalizedLabel = normalizeResolutionLabel(rawRes);
    let resResult: boolean;
    {
      const labelLower = normalizedLabel.toLowerCase();
      // Normalize the rule value too: stored rules may carry raw forms
      // ("720", "4k") while the UI writes labels ("720P", "4K")
      const valLower = normalizeResolutionLabel(String(value)).toLowerCase();
      switch (operator) {
        case "equals": resResult = labelLower === valLower; break;
        case "notEquals": resResult = labelLower !== valLower; break;
        case "contains": {
          // Resolution is enumerable — `contains` is multi-select list membership.
          const parts = String(value).split("|").filter(Boolean).map((p) => normalizeResolutionLabel(p).toLowerCase());
          resResult = parts.some((p) => labelLower === p);
          break;
        }
        case "notContains": {
          const parts = String(value).split("|").filter(Boolean).map((p) => normalizeResolutionLabel(p).toLowerCase());
          resResult = !parts.some((p) => labelLower === p);
          break;
        }
        // Wildcards match against the raw value (patterns like "1080*"
        // must not be normalized away)
        case "matchesWildcard": resResult = wildcardToRegex(String(value).toLowerCase()).test(labelLower); break;
        case "notMatchesWildcard": resResult = !wildcardToRegex(String(value).toLowerCase()).test(labelLower); break;
        default: resResult = false;
      }
    }
    return negate ? !resResult : resResult;
  }

  // Text fields (case-insensitive to match Prisma behavior).
  // Enumerable fields use list-membership semantics for contains/notContains
  // (mirrors the multi-select UI), free-text fields use substring search.
  if (operator === "isNull" || operator === "isNotNull") {
    const present = itemValue != null && itemValue !== "";
    const r = operator === "isNull" ? !present : present;
    return negate ? !r : r;
  }
  if (itemValue == null) {
    // NULL semantics mirror the Phase 1 clause shapes — see nullValueResult
    const r = nullValueResult(operator);
    return negate ? !r : r;
  }
  const strValue = String(value).toLowerCase();
  const itemStr = String(itemValue).toLowerCase();
  const textEnumerable = isEnumerableField(field);
  let textResult: boolean;
  switch (operator) {
    case "equals": textResult = itemStr === strValue; break;
    case "notEquals": textResult = itemStr !== strValue; break;
    case "contains": {
      const values = strValue.split("|").filter(Boolean);
      textResult = textEnumerable
        ? values.some((v) => itemStr === v)
        : values.some((v) => itemStr.includes(v));
      break;
    }
    case "notContains": {
      const values = strValue.split("|").filter(Boolean);
      textResult = textEnumerable
        ? !values.some((v) => itemStr === v)
        : !values.some((v) => itemStr.includes(v));
      break;
    }
    case "matchesWildcard": {
      const re = wildcardToRegex(strValue);
      textResult = re.test(itemStr);
      break;
    }
    case "notMatchesWildcard": {
      const re = wildcardToRegex(strValue);
      textResult = !re.test(itemStr);
      break;
    }
    default: textResult = false;
  }
  return negate ? !textResult : textResult;
}

function collectAllRulesWithGroup(rules: LifecycleRule[] | LifecycleRuleGroup[]): Array<{ rule: LifecycleRule; groupName?: string }> {
  const all: Array<{ rule: LifecycleRule; groupName?: string }> = [];
  if (isRuleGroups(rules)) {
    for (const group of rules as LifecycleRuleGroup[]) {
      if (group.enabled === false) continue;
      // Skip stream query groups — their rules are evaluated at group level
      if (isStreamQueryGroup(group)) continue;
      for (const rule of group.rules) {
        if (rule.enabled === false) continue;
        all.push({ rule, groupName: group.name });
      }
      if (group.groups?.length) {
        all.push(...collectAllRulesWithGroup(group.groups));
      }
    }
  } else {
    for (const rule of rules as LifecycleRule[]) {
      if (rule.enabled === false) continue;
      all.push({ rule });
    }
  }
  return all;
}

/** Collect stream query groups from the rule tree */
function collectStreamQueryGroups(rules: LifecycleRule[] | LifecycleRuleGroup[]): LifecycleRuleGroup[] {
  const groups: LifecycleRuleGroup[] = [];
  if (!isRuleGroups(rules)) return groups;
  for (const group of rules as LifecycleRuleGroup[]) {
    if (group.enabled === false) continue;
    if (isStreamQueryGroup(group)) {
      groups.push(group);
    }
    if (group.groups?.length) {
      groups.push(...collectStreamQueryGroups(group.groups));
    }
  }
  return groups;
}

const OPERATOR_SYMBOLS: Record<string, string> = {
  equals: "=",
  notEquals: "≠",
  greaterThan: ">",
  greaterThanOrEqual: "≥",
  lessThan: "<",
  lessThanOrEqual: "≤",
  contains: "contains",
  notContains: "not contains",
  before: "before",
  after: "after",
  inLastDays: "in last",
  notInLastDays: "> ago",
  matchesWildcard: "matches",
  notMatchesWildcard: "not matches",
  isNull: "is empty",
  isNotNull: "is not empty",
};

/**
 * For each item, evaluate every leaf rule individually and return which ones matched.
 * Items must already be confirmed matches from evaluateLifecycleRules().
 */

/**
 * The record a match's criteria and values are reported from, read as the
 * engine evaluated it: a show or artist matched as a group answers "Artist /
 * Series" with its own name (`withGroupParentTitle`), while the record itself
 * keeps the cleared `parentTitle` its snapshot is stored with. A show selected
 * through an episode's own values (series scope off, forced through the series
 * path) carries the record it was evaluated on (`withEvaluatedRecord`).
 *
 * The Arr and Seerr records and the result's key stay the match's own: the
 * engines look a group's metadata up by its own external ids.
 */
function asEvaluated(
  item: Record<string, unknown>,
  type: "MOVIE" | "SERIES" | "MUSIC",
): Record<string, unknown> {
  const evaluated = evaluatedRecordOf(item);
  if (evaluated) return evaluated;
  return type !== "MOVIE" && isGroupRecord(item) ? withGroupParentTitle(item) : item;
}

/** Extract the actual item value for a rule field, formatted for display */
function getActualValueForField(
  field: RuleField,
  item: Record<string, unknown>,
  arrMeta?: ArrMetadata,
  seerrMeta?: SeerrMetadata,
): string | null {
  // Helper to format dates nicely. A date-only field (release, premiere, air
  // date) is a calendar day stored as UTC midnight, and the date operators
  // compare UTC days, so it is shown in UTC: in the server's local time a
  // matched "In Cinemas Date equals 2023-01-01" read "Dec 31, 2022" west of UTC.
  const fmtDate = (v: unknown): string | null => {
    if (!v) return null;
    const d = new Date(v as string);
    if (isNaN(d.getTime())) return null;
    if (DATE_ONLY_FIELDS.has(field)) return formatDateOnly(d, "N/A", "short");
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  };

  // Arr fields
  if (isArrField(field)) {
    if (field === "foundInArr") return arrMeta !== undefined ? "true" : "false";
    if (!arrMeta) return "N/A (no Arr data)";
    switch (field) {
      case "arrTag": return arrMeta.tags.length > 0 ? arrMeta.tags.join(", ") : "none";
      case "arrQualityProfile": return arrMeta.qualityProfile;
      case "arrMonitored": return String(arrMeta.monitored);
      case "arrRating": return arrMeta.rating !== null ? String(arrMeta.rating) : "N/A";
      case "arrTmdbRating": return arrMeta.tmdbRating !== null ? String(arrMeta.tmdbRating) : "N/A";
      case "arrRtCriticRating": return arrMeta.rtCriticRating !== null ? String(arrMeta.rtCriticRating) : "N/A";
      case "arrDateAdded": return fmtDate(arrMeta.dateAdded) ?? "N/A";
      case "arrReleaseDate": return fmtDate(arrMeta.releaseDate) ?? "N/A";
      case "arrInCinemasDate": return fmtDate(arrMeta.inCinemasDate) ?? "N/A";
      case "arrDownloadDate": return fmtDate(arrMeta.downloadDate) ?? "N/A";
      case "arrFirstAired": return fmtDate(arrMeta.firstAired) ?? "N/A";
      case "arrSizeOnDisk":
        return arrMeta.sizeOnDisk !== null
          ? `${(arrMeta.sizeOnDisk / (1024 * 1024)).toFixed(0)} MB`
          : "N/A";
      case "arrRuntime": return arrMeta.runtime !== null ? `${arrMeta.runtime} min` : "N/A";
      case "arrSeasonCount": return arrMeta.seasonCount !== null ? String(arrMeta.seasonCount) : "N/A";
      case "arrEpisodeCount": return arrMeta.episodeCount !== null ? String(arrMeta.episodeCount) : "N/A";
      case "arrMonitoredSeasonCount": return arrMeta.monitoredSeasonCount !== null ? String(arrMeta.monitoredSeasonCount) : "N/A";
      case "arrMonitoredEpisodeCount": return arrMeta.monitoredEpisodeCount !== null ? String(arrMeta.monitoredEpisodeCount) : "N/A";
      case "arrCustomFormatScore": return arrMeta.customFormatScore !== null ? String(arrMeta.customFormatScore) : "N/A";
      case "arrQualityCutoffMet": return arrMeta.qualityCutoffMet !== null ? String(arrMeta.qualityCutoffMet) : "N/A";
      case "arrEnded": return arrMeta.ended !== null ? String(arrMeta.ended) : "N/A";
      case "arrHasUnaired": return arrMeta.hasUnaired !== null ? String(arrMeta.hasUnaired) : "N/A";
      case "arrPath": return arrMeta.path ?? "N/A";
      case "arrOriginalLanguage": return arrMeta.originalLanguage ?? "N/A";
      case "arrQualityName": return arrMeta.qualityName ?? "N/A";
      case "arrStatus": return arrMeta.status ?? "N/A";
      case "arrSeriesType": return arrMeta.seriesType ?? "N/A";
      default: return null;
    }
  }

  // Seerr fields
  if (isSeerrField(field)) {
    const defaultMeta: SeerrMetadata = {
      requested: false, requestCount: 0, requestDate: null,
      requestedBy: [], approvalDate: null, declineDate: null,
    };
    const m = seerrMeta ?? defaultMeta;
    switch (field) {
      case "seerrRequested": return String(m.requested);
      case "seerrRequestCount": return String(m.requestCount);
      case "seerrRequestDate": return fmtDate(m.requestDate) ?? "N/A";
      case "seerrApprovalDate": return fmtDate(m.approvalDate) ?? "N/A";
      case "seerrDeclineDate": return fmtDate(m.declineDate) ?? "N/A";
      case "seerrRequestedBy": return m.requestedBy.length > 0 ? m.requestedBy.join(", ") : "none";
      default: return null;
    }
  }

  // Stream language/codec fields
  if (STREAM_LANG_CODEC_FIELDS.has(field)) {
    const streams = (item.streams as Array<{ streamType: number; language: string | null; codec: string | null }>) ?? [];
    const streamType = field === "subtitleLanguage" ? 3 : 2;
    const streamField = field === "streamAudioCodec" ? "codec" : "language";
    const isLangField = STREAM_LANGUAGE_FIELDS.has(field);
    const values = [...new Set(
      streams.filter((s) => s.streamType === streamType)
        .map((s) => s[streamField] ?? "")
        .filter((v) => v !== "" && (!isLangField || v.toLowerCase() !== "unknown"))
    )];
    return values.length > 0 ? values.join(", ") : "none";
  }

  // Stream count fields
  if (STREAM_COUNT_FIELDS.has(field)) {
    const streams = (item.streams as Array<{ streamType: number }>) ?? [];
    const streamType = field === "audioStreamCount" ? 2 : 3;
    return String(streams.filter((s) => s.streamType === streamType).length);
  }

  // Stream query fields — should not reach here normally (handled at group level)
  if (isStreamQueryField(field)) {
    return null;
  }

  // Genre / Labels / Country (JSON array fields)
  if (field === "genre" || field === "labels" || field === "country") {
    const sourceCol = field === "labels" ? "labels" : field === "country" ? "countries" : "genres";
    const arr = Array.isArray(item[sourceCol]) ? (item[sourceCol] as string[]) : [];
    return arr.length > 0 ? arr.join(", ") : "none";
  }

  // Has External ID
  if (field === "hasExternalId") {
    const externalIds = (item.externalIds as Array<{ source: string }>) ?? [];
    return externalIds.length > 0 ? externalIds.map((e) => e.source).join(", ") : "none";
  }

  // Is Watchlisted
  if (field === "isWatchlisted") return String(!!item.isWatchlisted);

  // Matched By Rule Set — the names of the rule sets that matched the item
  // (`matchedRuleSets`, from fetchCrossSystemData; unknown on a record never
  // enriched with them)
  if (field === "matchedByRuleSet") {
    if (!Array.isArray(item.matchedRuleSets)) return "N/A";
    const names = [...(item.matchedRuleSets as string[])].sort((a, b) => a.localeCompare(b));
    return names.length > 0 ? names.join(", ") : "none";
  }

  // Watched By User — show the deduped list of usernames who played the item
  if (field === "watchedByUser") {
    const aggregated = Array.isArray(item.watchedByUsers)
      ? (item.watchedByUsers as string[])
      : null;
    const users = aggregated ?? (
      Array.isArray(item.watchHistory)
        ? (item.watchHistory as Array<{ serverUsername: string | null }>)
            .map((h) => h.serverUsername ?? "")
            .filter(Boolean)
        : []
    );
    const deduped = Array.from(new Set(users));
    return deduped.length > 0 ? deduped.join(", ") : "none";
  }

  // File size (bytes → human readable)
  if (field === "fileSize") {
    const bytes = item.fileSize ? Number(BigInt(item.fileSize as string)) : 0;
    if (bytes === 0) return "0";
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
  }

  // Duration (ms → minutes)
  if (field === "duration") {
    const ms = Number(item.duration ?? 0);
    return `${Math.round(ms / 60_000)} min`;
  }

  // Date fields
  const dateFields = new Set([
    "lastPlayedAt", "addedAt", "originallyAvailableAt",
    "latestEpisodeViewDate", "lastEpisodeAddedAt", "lastEpisodeAiredAt", "seriesLastPlayedAt",
  ]);
  if (dateFields.has(field)) {
    return fmtDate(item[field]) ?? "N/A";
  }

  // Numeric fields
  const numericFields = new Set([
    "playCount", "videoBitrate", "audioChannels", "year",
    "videoBitDepth", "audioSamplingRate", "audioBitrate",
    "rating", "audienceRating", "ratingCount",
    "availableEpisodeCount", "watchedEpisodeCount", "watchedEpisodePercentage",
  ]);
  if (numericFields.has(field)) {
    const val = item[field];
    if (field === "watchedEpisodePercentage") return `${Number(val ?? 0).toFixed(1)}%`;
    return String(val ?? 0);
  }

  // Text fields (fallback)
  const val = item[field];
  return val != null ? String(val) : "N/A";
}

/**
 * A group record's members' own values for the fields it is judged on through
 * every member (`withEveryMemberValues`), as the distinct sets of values with
 * how many members hold each — or null for any other record.
 */
interface EveryMemberValueGroups {
  /** How many members the group has. */
  total: number;
  /** Each distinct set of values, with how many members hold it, in member order. */
  groups: Array<{ values: Record<string, unknown>; count: number }>;
}

function everyMemberValueGroups(record: Record<string, unknown>): EveryMemberValueGroups | null {
  const values = everyMemberValuesOf(record);
  if (!values) return null;
  const byKey = new Map<string, { values: Record<string, unknown>; count: number }>();
  for (const v of values) {
    const key = JSON.stringify(v);
    const entry = byKey.get(key);
    if (entry) entry.count++;
    else byKey.set(key, { values: v, count: 1 });
  }
  return { total: values.length, groups: [...byKey.values()] };
}

/** How many distinct member values a reported value names before it says how many more there are. */
const EVERY_MEMBER_VALUES_SHOWN = 5;

/**
 * The reported value of a field a group answers through every member
 * (`isEveryMemberField`): there is no one value for the group, so the members'
 * own — one value when they all agree, otherwise each with how many members
 * hold it, most common first ("Keep (2 of 3); none (1 of 3)").
 */
function everyMemberActualValue(
  field: RuleField,
  item: Record<string, unknown>,
  members: EveryMemberValueGroups,
): string | null {
  const counts = new Map<string, number>();
  for (const { values, count } of members.groups) {
    const text = getActualValueForField(field, { ...item, ...values });
    if (text == null) continue;
    counts.set(text, (counts.get(text) ?? 0) + count);
  }
  if (counts.size === 0) return null;
  if (counts.size === 1) return [...counts.keys()][0];
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = ranked
    .slice(0, EVERY_MEMBER_VALUES_SHOWN)
    .map(([text, count]) => `${text} (${count} of ${members.total})`);
  const more = ranked.length - shown.length;
  return shown.join("; ") + (more > 0 ? `; ${more} more` : "");
}

export function getMatchedCriteriaForItems(
  items: Array<Record<string, unknown>>,
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  type: "MOVIE" | "SERIES" | "MUSIC",
  arrData?: ArrDataMap,
  seerrData?: SeerrDataMap
): Map<string, MatchedCriterion[]> {
  const fieldLabelMap = new Map([
    ...RULE_FIELDS.map((f) => [f.value, f.label] as const),
    ...STREAM_QUERY_FIELDS.map((f) => [f.value, f.label] as const),
  ]);
  const arrIdSource = type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";
  const allRulesWithGroup = collectAllRulesWithGroup(rules);
  const streamQueryGroups = collectStreamQueryGroups(rules);
  const result = new Map<string, MatchedCriterion[]>();

  for (const record of items) {
    const item = asEvaluated(record, type);
    const everyMember = everyMemberValueGroups(record);
    const criteria: MatchedCriterion[] = [];
    const externalIds = (record.externalIds ?? []) as Array<{ source: string; externalId: string }>;
    const arrExtId = externalIds.find((e) => e.source === arrIdSource);
    const arrMeta = arrData && arrExtId ? arrData[arrExtId.externalId] : undefined;
    const seerrMeta = lookupSeerrMeta(externalIds, seerrData, type);

    for (const { rule, groupName } of allRulesWithGroup) {
      // A field the group answers through every member holds for the group
      // only when it holds for each member's own value (`isEveryMemberField`).
      const members = everyMember && isEveryMemberField(rule.field) ? everyMember : null;
      const holds = members
        ? members.groups.length > 0 &&
          members.groups.every(({ values }) => evaluateRuleAgainstItem(rule, { ...item, ...values }, arrMeta, seerrMeta))
        : evaluateRuleAgainstItem(rule, item, arrMeta, seerrMeta);
      if (holds) {
        let displayValue = String(rule.value);
        if (rule.field === "fileSize" || rule.field === "arrSizeOnDisk") displayValue += " MB";
        if (rule.operator === "inLastDays" || rule.operator === "notInLastDays") displayValue += " days";

        criteria.push({
          ruleId: rule.id,
          field: fieldLabelMap.get(rule.field) ?? rule.field,
          operator: OPERATOR_SYMBOLS[rule.operator] ?? rule.operator,
          value: displayValue,
          negate: !!rule.negate,
          groupName,
          actualValue: (members
            ? everyMemberActualValue(rule.field, item, members)
            : getActualValueForField(rule.field, item, arrMeta, seerrMeta)) ?? undefined,
        });
      }
    }

    // Stream query groups — show each group as a single criterion when matched
    for (const sqGroup of streamQueryGroups) {
      if (evaluateStreamQueryGroupInMemory(sqGroup, item)) {
        const streamTypeLabel = sqGroup.streamQuery!.streamType;
        const activeRules = sqGroup.rules.filter((r) => r.enabled !== false);
        const ruleDescs = activeRules.map((r) => {
          const label = fieldLabelMap.get(r.field) ?? r.field;
          const op = OPERATOR_SYMBOLS[r.operator] ?? r.operator;
          return `${r.negate ? "NOT " : ""}${label} ${op} ${r.value}`;
        });
        criteria.push({
          ruleId: sqGroup.id,
          field: `Stream Query (${streamTypeLabel})`,
          operator: "matched",
          value: ruleDescs.join(", "),
          negate: false,
          groupName: sqGroup.name,
        });
      }
    }

    result.set(record.id as string, criteria);
  }

  return result;
}

/**
 * Compute actual item values for ALL enabled rules (not just matched ones).
 * Returns a map of itemId → Map<ruleId, actualValue>.
 */
export function getActualValuesForAllRules(
  items: Array<Record<string, unknown>>,
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  type: "MOVIE" | "SERIES" | "MUSIC",
  arrData?: ArrDataMap,
  seerrData?: SeerrDataMap
): Map<string, Map<string, string>> {
  const arrIdSource = type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";
  const allRulesWithGroup = collectAllRulesWithGroup(rules);
  const result = new Map<string, Map<string, string>>();

  for (const record of items) {
    const item = asEvaluated(record, type);
    const everyMember = everyMemberValueGroups(record);
    const values = new Map<string, string>();
    const externalIds = (record.externalIds ?? []) as Array<{ source: string; externalId: string }>;
    const arrExtId = externalIds.find((e) => e.source === arrIdSource);
    const arrMeta = arrData && arrExtId ? arrData[arrExtId.externalId] : undefined;
    const seerrMeta = lookupSeerrMeta(externalIds, seerrData, type);

    for (const { rule } of allRulesWithGroup) {
      const actual = everyMember && isEveryMemberField(rule.field)
        ? everyMemberActualValue(rule.field, item, everyMember)
        : getActualValueForField(rule.field, item, arrMeta, seerrMeta);
      if (actual != null) values.set(rule.id, actual);
    }

    result.set(record.id as string, values);
  }

  return result;
}

function evaluateRuleGroupInMemory(
  group: LifecycleRuleGroup,
  item: Record<string, unknown>,
  arrMeta?: ArrMetadata,
  seerrMeta?: SeerrMetadata
): boolean | null {
  if (group.enabled === false) return null; // Skip disabled group (mirrors Phase 1)

  // Stream query groups: evaluate per-stream
  if (isStreamQueryGroup(group)) {
    return evaluateStreamQueryGroupInMemory(group, item);
  }

  const items: Array<{ condition: LifecycleRuleCondition; result: boolean }> = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    items.push({ condition: rule.condition, result: evaluateRuleAgainstItem(rule, item, arrMeta, seerrMeta) });
  }
  for (const sub of group.groups ?? []) {
    const subResult = evaluateRuleGroupInMemory(sub, item, arrMeta, seerrMeta);
    if (subResult !== null) {
      items.push({ condition: sub.condition, result: subResult });
    }
  }

  if (items.length === 0) return null; // No active rules in group (mirrors Phase 1)
  if (items.length === 1) return items[0].result;

  let combined = items[0].result;
  for (let i = 1; i < items.length; i++) {
    const { condition, result } = items[i];
    if (condition === "OR") {
      combined = combined || result;
    } else {
      combined = combined && result;
    }
  }
  return combined;
}

/** Evaluate an entire rule set (grouped or legacy) in-memory against a single item */
export function evaluateAllRulesInMemory(
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  item: Record<string, unknown>,
  arrMeta?: ArrMetadata,
  seerrMeta?: SeerrMetadata
): boolean {
  if (rules.length === 0) return false;

  if (isRuleGroups(rules)) {
    // Same normalization as Phase 1 — the two phases must agree (negation.ts)
    const groups = pushDownGroupNegation(rules as LifecycleRuleGroup[]);
    const results: Array<{ condition: LifecycleRuleCondition; result: boolean }> = [];

    for (let i = 0; i < groups.length; i++) {
      const groupResult = evaluateRuleGroupInMemory(groups[i], item, arrMeta, seerrMeta);
      if (groupResult !== null) {
        results.push({ condition: groups[i].condition, result: groupResult });
      }
    }

    if (results.length === 0) return false; // All groups disabled/empty → safe default
    if (results.length === 1) return results[0].result;

    let combined = results[0].result;
    for (let i = 1; i < results.length; i++) {
      if (results[i].condition === "OR") {
        combined = combined || results[i].result;
      } else {
        combined = combined && results[i].result;
      }
    }
    return combined;
  }

  // Legacy flat rules: convert to the equivalent group tree and evaluate
  // through the same path as grouped rule sets (identical bucket semantics —
  // OR within buckets, AND between them — see legacyRulesToGroups).
  const converted = legacyRulesToGroups(rules as LifecycleRule[]);
  if (converted.length === 0) return false;
  return evaluateAllRulesInMemory(converted, item, arrMeta, seerrMeta);
}

export { hasArrRules, hasSeerrRules, hasStreamRules, hasExternalIdFieldRules, hasSeriesAggregateRules };

/**
 * Defense in depth for the group-scope engines: whether `rules` judge whole
 * shows or artists on a criterion that describes one episode or track
 * (`groupScopeViolation`), which saving refuses and detection, Preview and
 * Test Media skip (`checkLifecycleRuleEvaluability`). A caller that reaches an
 * engine anyway gets no matches — never a whole show matched on one episode —
 * and the reason is logged.
 */
function refusesGroupScope(rules: LifecycleRule[] | LifecycleRuleGroup[], type: GroupScopeType): boolean {
  const violation = groupScopeViolation(type, true, rules);
  if (!violation) return false;
  logger.warn("Lifecycle", `Refusing to evaluate ${type === "SERIES" ? "series" : "artist"} scope — ${groupScopeHoldReason(violation)}`);
  return true;
}

/**
 * Evaluate rules at the series scope: aggregate ALL episodes into series
 * first, then evaluate rules against the aggregated series data.
 * This is the default for SERIES type rule sets.
 *
 * A show matches when at least one episode satisfies the rules, each episode
 * seen as the show's record carrying its own per-episode values
 * (`evaluateGroupThroughMembers`); the show's own values (name, play total,
 * size, streams, watchers, aggregates, Arr, Seerr) are the same for every
 * episode. The match is stored and reported with the first such episode's
 * values. Criteria that describe one episode (Resolution, Year, Genre, Content
 * Rating, a stream query, … — every per-episode field) are not allowed in
 * series scope (`groupScopeViolation`): rules holding one match nothing here,
 * so the rules this evaluates read only the show's own values — and the
 * cross-system fields, which each episode has its own of: a show matches only
 * when the rules hold for every episode read with its own (`isEveryMemberField`).
 */
export async function evaluateSeriesScope(
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  serverIds: string[],
  arrData?: ArrDataMap,
  seerrData?: SeerrDataMap,
  /**
   * When true, the run is per episode (series scope off) and was FORCED onto
   * the series path by a series-aggregate field: a show is a match when at
   * least one of its episodes satisfies the rules on its own, with the
   * series-aggregate fields injected as series-level constants
   * (`episodesMatchingIndividually`), and its `memberIds` are exactly those
   * episodes — a member-scoped file delete acts only on them. Here every field
   * but the aggregates, Arr and Seerr is the episode's own (its title, play
   * count, size, streams, watchers, cross-system values), as on the flat
   * per-episode path. With `seriesScope` true (whole-series intent) this stays
   * false and every episode is a member.
   */
  restrictMembersToEpisodeMatches: boolean = false,
  /** Passed to `fetchCrossSystemData`: the rule set being evaluated. */
  crossSystemOptions: CrossSystemDataOptions = {},
) {
  // Defense-in-depth: refuse to evaluate if no active rules exist
  if (rules.length === 0 || !hasAnyActiveRules(rules)) return [];
  // Series scope (not a per-episode run forced through here by an aggregate
  // field, where every criterion is checked per episode): no per-episode
  // criteria.
  if (!restrictMembersToEpisodeMatches && refusesGroupScope(rules, "SERIES")) return [];

  const needsStreams = hasStreamRules(rules);
  const needsWatchHistory = hasWatchedByUserRules(rules);

  // Fetch ALL episodes across the user's SERIES libraries
  const allEpisodes = await prisma.mediaItem.findMany({
    where: {
      type: "SERIES",
      library: { mediaServerId: { in: serverIds } },
    },
    omit: UNREAD_ITEM_COLUMNS,
    include: {
      externalIds: true,
      ...(needsStreams ? { streams: true } : {}),
      ...(needsWatchHistory ? { watchHistory: {
          // Phase 2 must see the same rows Phase 1 filtered on, or a
          // `watchedByUser` rule matches a different set depending on
          // whether something else forced in-memory re-evaluation.
          where: COMPLETED_PLAY_FILTER,
          select: { serverUsername: true },
        } } : {}),
      library: {
        select: {
          title: true,
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  // Group episodes by series identity within a library (libraryId + seriesKey).
  // Keying on seriesKey (not the ambiguous parentTitle) splits two same-titled
  // shows with different TVDB ids; keeping the libraryId prefix leaves the same
  // show on two servers as two aggregates that detect-matches collapses by Arr
  // id (merging here would double-count episodes).
  const seriesMap = new Map<string, typeof allEpisodes>();
  for (const ep of allEpisodes) {
    const key = `${ep.libraryId}::${resolveSeriesKey(ep) ?? ep.libraryId}`;
    const group = seriesMap.get(key);
    if (group) {
      group.push(ep);
    } else {
      seriesMap.set(key, [ep]);
    }
  }

  // Aggregate each series into a single record for rule evaluation
  type EpisodeRow = (typeof allEpisodes)[0];
  const aggregated: Array<
    Omit<EpisodeRow, "fileSize"> & {
      episodeCount: number;
      fileSize: string | null;
      allStreams?: unknown[];
      watchedEpisodeCount: number;
      latestEpisodeViewDate: Date | null;
      lastEpisodeAddedAt: Date | null;
      lastEpisodeAiredAt: Date | null;
      watchedByUsers: string[];
      memberIds: string[];
    }
  > = [];

  // The raw episode rows per series (lowest id first): a show is judged through
  // them below, in either scope.
  const episodesByRepId = new Map<string, typeof allEpisodes>();

  for (const [, episodes] of seriesMap) {
    // Sort by id for a stable representative across syncs (prevents false match churn)
    episodes.sort((a, b) => compareIds(a.id, b.id));
    const representative = episodes[0];
    episodesByRepId.set(representative.id, episodes);
    const totalPlays = episodes.reduce((sum, ep) => sum + ep.playCount, 0);
    const totalSize = episodes.reduce(
      (sum, ep) => sum + (ep.fileSize ?? BigInt(0)),
      BigInt(0)
    );
    const latestPlayed = episodes.reduce<Date | null>((latest, ep) => {
      if (!ep.lastPlayedAt) return latest;
      if (!latest || ep.lastPlayedAt > latest) return ep.lastPlayedAt;
      return latest;
    }, null);
    const earliestAdded = episodes.reduce<Date | null>((earliest, ep) => {
      if (!ep.addedAt) return earliest;
      if (!earliest || ep.addedAt < earliest) return ep.addedAt;
      return earliest;
    }, null);

    const watchedCount = episodes.filter((ep) => ep.playCount > 0).length;

    const latestEpisodeAdded = episodes.reduce<Date | null>((latest, ep) => {
      if (!ep.addedAt) return latest;
      if (!latest || ep.addedAt > latest) return ep.addedAt;
      return latest;
    }, null);

    const latestEpisodeAired = episodes.reduce<Date | null>((latest, ep) => {
      if (!ep.originallyAvailableAt) return latest;
      if (!latest || ep.originallyAvailableAt > latest) return ep.originallyAvailableAt;
      return latest;
    }, null);

    // Find the newest episode by season/episode number and get its lastPlayedAt
    const sortedByNewest = [...episodes].sort((a, b) => {
      const seasonDiff = (b.seasonNumber ?? 0) - (a.seasonNumber ?? 0);
      if (seasonDiff !== 0) return seasonDiff;
      return (b.episodeNumber ?? 0) - (a.episodeNumber ?? 0);
    });
    const latestEpisodeViewDate = sortedByNewest[0]?.lastPlayedAt ?? null;

    // Aggregate streams across all episodes for this series
    const allStreams = needsStreams
      ? episodes.flatMap((ep) => ("streams" in ep ? (ep.streams as unknown[]) : []))
      : undefined;

    // Aggregate watch history into a deduped set of usernames who played any episode
    const watchedByUsers = needsWatchHistory
      ? Array.from(
          new Set(
            episodes.flatMap((ep) =>
              "watchHistory" in ep
                ? (ep.watchHistory as Array<{ serverUsername: string | null }>)
                    .map((h) => h.serverUsername)
                    .filter((u): u is string => !!u)
                : [],
            ),
          ),
        )
      : [];

    aggregated.push({
      ...representative,
      // Use series name as title so "title" rules match against the series
      title: representative.parentTitle ?? representative.title,
      // Use series-level summary instead of episode summary
      summary: representative.parentSummary ?? representative.summary,
      // Clear episode-specific fields — this is a series-level aggregate, and
      // the match's group snapshot. Rules read the show's name as its
      // parentTitle (withGroupParentTitle, below).
      parentTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      playCount: totalPlays,
      fileSize: totalSize > BigInt(0) ? totalSize.toString() : null,
      lastPlayedAt: latestPlayed,
      addedAt: earliestAdded,
      episodeCount: episodes.length,
      watchedEpisodeCount: watchedCount,
      latestEpisodeViewDate,
      lastEpisodeAddedAt: latestEpisodeAdded,
      lastEpisodeAiredAt: latestEpisodeAired,
      watchedByUsers,
      allStreams,
      memberIds: episodes.map((ep) => ep.id),
    });
  }

  // Cross-system fields: each episode's own. A whole show is judged through
  // every episode's (`isEveryMemberField`), a per-episode run each episode by
  // its own.
  const crossSystem = hasCrossSystemFieldRules(rules)
    ? await fetchCrossSystemData(allEpisodes.map((ep) => ep.id), crossSystemOptions)
    : undefined;
  const everyEpisode = crossSystem
    ? (ep: { id: string }) => ({ ...crossSystemValuesOf(crossSystem, ep.id) })
    : undefined;

  // Evaluate rules in-memory against aggregated series records
  const externalIdSource = "TVDB";
  // Whether a rule reads a value an episode holds on its own — each show is
  // then judged through its episodes; otherwise it is evaluated once, as every
  // episode would answer alike. Decided once for the run.
  const perMember = restrictMembersToEpisodeMatches
    ? hasEpisodeValueRules(rules)
    : hasMemberValueRules(rules);

  // The match record: the show (its name, totals, aggregates) carrying the
  // per-episode values of the episode it was selected through, plus the
  // computed fields getMatchedCriteriaForItems reports (they exist only on the
  // evaluation object, not on the raw aggregated series record).
  const toResult = (series: (typeof aggregated)[number]) => ({
    ...series,
    fileSize: series.fileSize ?? null,
    matchedEpisodes: series.episodeCount,
    memberIds: series.memberIds,
    latestEpisodeViewDate: series.latestEpisodeViewDate ?? null,
    // MAX(lastPlayedAt) across all episodes — the aggregate already stores it on lastPlayedAt.
    seriesLastPlayedAt: series.lastPlayedAt ?? null,
    availableEpisodeCount: series.episodeCount,
    watchedEpisodePercentage: series.episodeCount > 0
      ? (series.watchedEpisodeCount / series.episodeCount) * 100
      : 0,
    streams: series.allStreams ?? [],
  });
  const matching: Array<ReturnType<typeof toResult>> = [];

  for (const series of aggregated) {
    // Serialize for in-memory evaluation (mirrors evaluateLifecycleRules output format).
    // No cross-system values: the show has none of its own, and each episode
    // carries its own in either scope (below).
    const item: Record<string, unknown> = {
      // The show's name answers "Artist / Series" (withGroupParentTitle).
      ...withGroupParentTitle(series),
      fileSize: series.fileSize,
      lastPlayedAt: series.lastPlayedAt
        ? series.lastPlayedAt instanceof Date
          ? series.lastPlayedAt.toISOString()
          : series.lastPlayedAt
        : null,
      addedAt: series.addedAt
        ? series.addedAt instanceof Date
          ? series.addedAt.toISOString()
          : series.addedAt
        : null,
      streams: series.allStreams ?? [],
      // MAX(lastPlayedAt) across all episodes — the "Series Last Played" aggregate.
      seriesLastPlayedAt: series.lastPlayedAt
        ? series.lastPlayedAt instanceof Date
          ? series.lastPlayedAt.toISOString()
          : series.lastPlayedAt
        : null,
      latestEpisodeViewDate: series.latestEpisodeViewDate
        ? series.latestEpisodeViewDate instanceof Date
          ? series.latestEpisodeViewDate.toISOString()
          : series.latestEpisodeViewDate
        : null,
      availableEpisodeCount: series.episodeCount,
      watchedEpisodeCount: series.watchedEpisodeCount,
      watchedEpisodePercentage: series.episodeCount > 0
        ? (series.watchedEpisodeCount / series.episodeCount) * 100
        : 0,
      lastEpisodeAddedAt: series.lastEpisodeAddedAt
        ? series.lastEpisodeAddedAt instanceof Date
          ? series.lastEpisodeAddedAt.toISOString()
          : series.lastEpisodeAddedAt
        : null,
      lastEpisodeAiredAt: series.lastEpisodeAiredAt
        ? series.lastEpisodeAiredAt instanceof Date
          ? series.lastEpisodeAiredAt.toISOString()
          : series.lastEpisodeAiredAt
        : null,
      watchedByUsers: series.watchedByUsers,
    };

    const extId = series.externalIds?.find(
      (e) => e.source === externalIdSource
    );
    const arrMeta = arrData && extId ? arrData[extId.externalId] : undefined;

    const seerrMeta = lookupSeerrMeta(series.externalIds ?? [], seerrData, "SERIES");

    // Lowest id first: the first to pass is the one the match is stored with.
    const episodes = episodesByRepId.get(series.id) ?? [];

    if (restrictMembersToEpisodeMatches) {
      // Per episode: the show is a match when an episode passes on its own,
      // with the series aggregates carried over as series-level constants —
      // the selection the query engine's aggregate path shares — and its
      // members are exactly those episodes. The show's own record is no gate:
      // it read every per-episode field off the representative. Same arr/seerr
      // meta: correlation is series-level.
      const first: { episode?: EpisodeRow; record?: Record<string, unknown> } = {};
      const memberIds = episodesMatchingIndividually(
        episodes,
        item,
        (ep, seriesFields) => {
          const epExternalIds = "externalIds" in ep
            ? (ep.externalIds as Array<{ source: string; externalId: string }>)
            : [];
          const epItem: Record<string, unknown> = {
            ...ep,
            fileSize: ep.fileSize?.toString() ?? null,
            lastPlayedAt: ep.lastPlayedAt?.toISOString() ?? null,
            addedAt: ep.addedAt?.toISOString() ?? null,
            originallyAvailableAt: ep.originallyAvailableAt?.toISOString() ?? null,
            streams: "streams" in ep ? ep.streams : [],
            watchHistory: "watchHistory" in ep ? ep.watchHistory : [],
            externalIds: epExternalIds,
            ...crossSystem?.get(ep.id),
            ...seriesFields,
          };
          const passes = evaluateAllRulesInMemory(rules, epItem, arrMeta, seerrMeta);
          if (passes && !first.record) {
            first.episode = ep;
            first.record = epItem;
          }
          return passes;
        },
        perMember,
      );
      // Passing only as a whole (a summed file size, say) is not a match when
      // the rule is per episode: with no member an episode-scoped action fell
      // back to the representative, which never matched, and its settled
      // empty member list then read as covering the whole show.
      if (memberIds.length === 0 || !first.episode || !first.record) continue;
      // Stored as the show with the first matching episode's per-episode
      // values; its criteria are reported from that episode's own record.
      matching.push(withEvaluatedRecord(
        toResult({ ...series, ...(memberValuesOf(first.episode) as Partial<typeof series>), memberIds }),
        first.record,
      ));
      continue;
    }

    // Whole show: a match when one episode, seen as the show carrying its own
    // per-episode values, satisfies the rules — and, for a cross-system
    // criterion, only when every episode does with its own cross-system
    // values; every episode stays a member. The match reports those values
    // per episode (withEveryMemberValues).
    const selection = evaluateGroupThroughMembers(rules, item, episodes, perMember, arrMeta, seerrMeta, everyEpisode);
    if (!selection) continue;
    matching.push(withEveryMemberValues(
      toResult({ ...series, ...(selection.memberValues as Partial<typeof series>) }),
      selection.everyMemberValues,
    ));
  }

  return matching;
}

/**
 * Evaluate rules at the artist scope: aggregate ALL tracks into artists
 * first, then evaluate rules against the aggregated artist data.
 * This is the default for MUSIC type rule sets. Criteria that describe one
 * track (Audio Codec, Year, Album, a stream query, …) are not allowed in
 * artist scope (`groupScopeViolation`): rules holding one match nothing here.
 * The cross-system fields are each track's own: an artist matches only when
 * the rules hold for every track read with its own (`isEveryMemberField`).
 */
export async function evaluateMusicScope(
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  serverIds: string[],
  arrData?: ArrDataMap,
  /** Passed to `fetchCrossSystemData`: the rule set being evaluated. */
  crossSystemOptions: CrossSystemDataOptions = {},
) {
  // Defense-in-depth: refuse to evaluate if no active rules exist
  if (rules.length === 0 || !hasAnyActiveRules(rules)) return [];
  if (refusesGroupScope(rules, "MUSIC")) return [];

  const needsStreams = hasStreamRules(rules);
  const needsWatchHistory = hasWatchedByUserRules(rules);

  // Fetch ALL tracks across the user's MUSIC libraries
  const allTracks = await prisma.mediaItem.findMany({
    where: {
      type: "MUSIC",
      library: { mediaServerId: { in: serverIds } },
    },
    omit: UNREAD_ITEM_COLUMNS,
    include: {
      externalIds: true,
      ...(needsStreams ? { streams: true } : {}),
      ...(needsWatchHistory ? { watchHistory: {
          // Phase 2 must see the same rows Phase 1 filtered on, or a
          // `watchedByUser` rule matches a different set depending on
          // whether something else forced in-memory re-evaluation.
          where: COMPLETED_PLAY_FILTER,
          select: { serverUsername: true },
        } } : {}),
      library: {
        select: {
          title: true,
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  // Group tracks by artist (parentTitle + libraryId), then split a title that
  // provably names several artists — two or more MusicBrainz artist ids — so
  // same-named artists are not aggregated (and deleted) as one. See
  // `splitArtistGroupByMbid` for why a title with one id is never split.
  const titleGroups = new Map<string, typeof allTracks>();
  for (const track of allTracks) {
    const key = `${track.libraryId}::${track.parentTitle ?? track.libraryId}`;
    const group = titleGroups.get(key);
    if (group) {
      group.push(track);
    } else {
      titleGroups.set(key, [track]);
    }
  }
  const artistMap = new Map<string, typeof allTracks>();
  for (const [key, tracks] of titleGroups) {
    splitArtistGroupByMbid(tracks, (t) => artistMbidOf(t.externalIds)).forEach((group, i) => {
      artistMap.set(`${key}::${i}`, group);
    });
  }

  // Aggregate each artist into a single record for rule evaluation
  type TrackRow = (typeof allTracks)[0];
  const aggregated: Array<
    Omit<TrackRow, "fileSize"> & { trackCount: number; fileSize: string | null; allStreams?: unknown[]; watchedByUsers: string[]; memberIds: string[] }
  > = [];

  // The raw track rows per artist (lowest id first): an artist is judged
  // through them below.
  const tracksByRepId = new Map<string, typeof allTracks>();

  for (const [, tracks] of artistMap) {
    // Sort by id for a stable representative across syncs (prevents false match churn)
    tracks.sort((a, b) => compareIds(a.id, b.id));
    const representative = tracks[0];
    tracksByRepId.set(representative.id, tracks);
    const totalPlays = tracks.reduce((sum, t) => sum + t.playCount, 0);
    const totalSize = tracks.reduce(
      (sum, t) => sum + (t.fileSize ?? BigInt(0)),
      BigInt(0)
    );
    const latestPlayed = tracks.reduce<Date | null>((latest, t) => {
      if (!t.lastPlayedAt) return latest;
      if (!latest || t.lastPlayedAt > latest) return t.lastPlayedAt;
      return latest;
    }, null);
    const earliestAdded = tracks.reduce<Date | null>((earliest, t) => {
      if (!t.addedAt) return earliest;
      if (!earliest || t.addedAt < earliest) return t.addedAt;
      return earliest;
    }, null);

    // Aggregate streams across all tracks for this artist
    const allStreams = needsStreams
      ? tracks.flatMap((t) => ("streams" in t ? (t.streams as unknown[]) : []))
      : undefined;

    // Aggregate watch history into a deduped set of usernames who played any track
    const watchedByUsers = needsWatchHistory
      ? Array.from(
          new Set(
            tracks.flatMap((t) =>
              "watchHistory" in t
                ? (t.watchHistory as Array<{ serverUsername: string | null }>)
                    .map((h) => h.serverUsername)
                    .filter((u): u is string => !!u)
                : [],
            ),
          ),
        )
      : [];

    aggregated.push({
      ...representative,
      // Use artist name as title so "title" rules match against the artist
      title: representative.parentTitle ?? representative.title,
      // Clear track-specific fields — this is an artist-level aggregate, and
      // the match's group snapshot. Rules read the artist's name as its
      // parentTitle (withGroupParentTitle, below).
      parentTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      playCount: totalPlays,
      fileSize: totalSize > BigInt(0) ? totalSize.toString() : null,
      lastPlayedAt: latestPlayed,
      addedAt: earliestAdded,
      trackCount: tracks.length,
      allStreams,
      watchedByUsers,
      memberIds: tracks.map((t) => t.id),
    });
  }

  // Evaluate rules in-memory against aggregated artist records
  const externalIdSource = "MUSICBRAINZ";
  // Whether a rule reads a value a track holds on its own: each artist is then
  // judged through its tracks; otherwise it is evaluated once.
  const perMember = hasMemberValueRules(rules);
  const matching: Array<{
    artist: (typeof aggregated)[number];
    everyMemberValues: GroupSelection["everyMemberValues"];
  }> = [];

  // Cross-system fields: each track's own. An artist is judged through every
  // track's (`isEveryMemberField`), as a show through its episodes'.
  const crossSystem = hasCrossSystemFieldRules(rules)
    ? await fetchCrossSystemData(allTracks.map((t) => t.id), crossSystemOptions)
    : undefined;
  const everyTrack = crossSystem
    ? (t: { id: string }) => ({ ...crossSystemValuesOf(crossSystem, t.id) })
    : undefined;

  for (const artist of aggregated) {
    // No cross-system values: the artist has none of its own (each track
    // carries its own, below).
    const item: Record<string, unknown> = {
      // The artist's name answers "Artist / Series" (withGroupParentTitle).
      ...withGroupParentTitle(artist),
      fileSize: artist.fileSize,
      lastPlayedAt: artist.lastPlayedAt
        ? artist.lastPlayedAt instanceof Date
          ? artist.lastPlayedAt.toISOString()
          : artist.lastPlayedAt
        : null,
      addedAt: artist.addedAt
        ? artist.addedAt instanceof Date
          ? artist.addedAt.toISOString()
          : artist.addedAt
        : null,
      streams: artist.allStreams ?? [],
      watchedByUsers: artist.watchedByUsers,
    };

    const extId = artist.externalIds?.find(
      (e) => e.source === externalIdSource
    );
    const arrMeta = arrData && extId ? arrData[extId.externalId] : undefined;

    // A match when one track, seen as the artist carrying its own per-track
    // values (year, codecs, album, …), satisfies the rules — and, for a
    // cross-system criterion, only when every track does with its own
    // cross-system values; stored with the first such track's values, every
    // track a member.
    const selection = evaluateGroupThroughMembers(
      rules, item, tracksByRepId.get(artist.id) ?? [], perMember, arrMeta, undefined, everyTrack,
    );
    if (selection) {
      matching.push({
        artist: { ...artist, ...(selection.memberValues as Partial<typeof artist>) },
        everyMemberValues: selection.everyMemberValues,
      });
    }
  }

  return matching.map(({ artist: item, everyMemberValues }) => withEveryMemberValues({
    ...item,
    fileSize: item.fileSize ?? null,
    matchedEpisodes: item.trackCount,
    memberIds: item.memberIds,
    // Expose allStreams as streams so getMatchedCriteriaForItems can evaluate
    // stream-based rules against the aggregated artist record
    streams: item.allStreams ?? [],
  }, everyMemberValues));
}

export async function evaluateLifecycleRules(
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  type: "MOVIE" | "SERIES" | "MUSIC",
  serverIds: string[],
  arrData?: ArrDataMap,
  seerrData?: SeerrDataMap,
  /** Passed to `fetchCrossSystemData`: the rule set being evaluated. */
  crossSystemOptions: CrossSystemDataOptions = {},
) {
  // Defense-in-depth: refuse to evaluate if no active rules exist
  if (!hasAnyActiveRules(rules)) return [];

  // Determine whether in-memory re-evaluation is needed BEFORE building WHERE,
  // because external fields dropped from OR branches can make the WHERE clause
  // incorrectly restrictive (see below).
  const hasExternal = (arrData && hasArrRules(rules)) || (seerrData && hasSeerrRules(rules));
  const needsExternalIds = !!hasExternal || hasExternalIdFieldRules(rules);
  const needsStreams = hasStreamRules(rules);
  const needsWatchHistory = hasWatchedByUserRules(rules);
  const hasCrossSystem = hasCrossSystemFieldRules(rules);
  // hasSeriesAggregateRules: aggregate fields are dropped to {} in Phase 1
  // (where-builder), so they MUST force the pre-filter WHERE + in-memory
  // re-eval, otherwise an aggregate conjunct AND-ed with a DB-expressible rule
  // is silently dropped. (Aggregate evaluation itself happens at the series
  // level — see detect-matches routing to evaluateSeriesScope.)
  const needsInMemoryEval = hasWildcardRules(rules) || hasStreamCountRules(rules) || hasStreamQueryInMemoryRules(rules) || hasCrossSystem || hasResolutionRules(rules) || hasArrayFieldRules(rules) || hasSeriesAggregateRules(rules);
  const needsFullReeval = needsInMemoryEval || !!hasExternal;

  let andConditions: Prisma.MediaItemWhereInput[];

  // When needsFullReeval is true, use pre-filter-aware WHERE construction.
  // ruleToWhere() returns {} for external fields (Arr/Seerr), wildcards,
  // and stream counts. Silently dropping these from OR branches makes the DB
  // query MORE restrictive than the in-memory evaluation — items that should
  // match get excluded from Phase 1 and never reach Phase 2.
  // The pre-filter variant treats dropped rules as EXTERNAL_RULE and propagates
  // correctly through AND/OR: EXTERNAL_RULE OR X = EXTERNAL_RULE (broadens),
  // EXTERNAL_RULE AND X = X (safe). This keeps DB-expressible conditions for
  // performance while guaranteeing the Phase 1 result is a superset of Phase 2.
  // Legacy flat rule sets are converted to the equivalent group tree so they
  // share the pre-filter and disabled-rule handling (see legacyRulesToGroups).
  const groupRules: LifecycleRuleGroup[] = isRuleGroups(rules)
    ? (rules as LifecycleRuleGroup[])
    : legacyRulesToGroups(rules as LifecycleRule[]);

  if (needsFullReeval) {
    const combined = buildGroupConditionsPreFilter(groupRules, ruleToWhere);
    andConditions = Object.keys(combined).length > 0 ? [combined] : [];
  } else {
    const combined = buildGroupConditions(groupRules, ruleToWhere);
    andConditions = Object.keys(combined).length > 0 ? [combined] : [];
  }

  const where: Prisma.MediaItemWhereInput = {
    type,
    library: { mediaServerId: { in: serverIds } },
    ...(andConditions.length > 0 ? { AND: andConditions } : {}),
  };

  // Safety net: if all rules produced empty WHERE clauses (e.g. invalid operators)
  // AND no in-memory re-evaluation is needed, return empty rather than matching
  // the entire library. Legitimate empty-WHERE rules (Arr/Seerr fields, stream
  // counts, wildcards) always set needsFullReeval=true.
  if (andConditions.length === 0 && !needsFullReeval) {
    return [];
  }

  const items = await prisma.mediaItem.findMany({
    where,
    omit: UNREAD_ITEM_COLUMNS,
    include: {
      ...(needsExternalIds ? { externalIds: true } : {}),
      ...(needsStreams ? { streams: true } : {}),
      ...(needsWatchHistory ? { watchHistory: {
          // Phase 2 must see the same rows Phase 1 filtered on, or a
          // `watchedByUser` rule matches a different set depending on
          // whether something else forced in-memory re-evaluation.
          where: COMPLETED_PLAY_FILTER,
          select: { serverUsername: true },
        } } : {}),
      library: {
        select: {
          title: true,
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  let filteredItems = items;

  // Unified in-memory post-filter: applies when ANY rules can't be fully expressed in Prisma
  // (wildcard operators, stream counts, Arr/Seerr fields). Evaluates ALL rules together so that
  // AND/OR logic between groups with mixed field types is correctly enforced.
  let crossSystemData: Map<string, { serverCount: number; matchedRuleSets: string[]; hasPendingAction: boolean }> | undefined;
  if (needsFullReeval) {
    const arrIdSource = type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";

    // Batch-fetch cross-system data if needed
    if (hasCrossSystem) {
      crossSystemData = await fetchCrossSystemData(filteredItems.map((i) => i.id), crossSystemOptions);
    }

    filteredItems = filteredItems.filter((item) => {
      const externalIds = "externalIds" in item
        ? (item.externalIds as Array<{ source: string; externalId: string }>)
        : [];
      const arrExtId = externalIds.find((e) => e.source === arrIdSource);
      const itemArrMeta = arrData && arrExtId ? arrData[arrExtId.externalId] : undefined;
      const itemSeerrMeta = lookupSeerrMeta(externalIds, seerrData, type);

      const crossData = crossSystemData?.get(item.id);
      const serialized: Record<string, unknown> = {
        ...item,
        fileSize: item.fileSize?.toString() ?? null,
        lastPlayedAt: item.lastPlayedAt?.toISOString() ?? null,
        addedAt: item.addedAt?.toISOString() ?? null,
        originallyAvailableAt: item.originallyAvailableAt?.toISOString() ?? null,
        streams: "streams" in item ? item.streams : [],
        watchHistory: "watchHistory" in item ? item.watchHistory : [],
        externalIds,
        ...(crossData ?? {}),
      };
      return evaluateAllRulesInMemory(rules, serialized, itemArrMeta, itemSeerrMeta);
    });
  }

  // The cross-system values ride on the returned rows, as the series- and
  // artist-scope engines carry theirs: detection, the preview and the diff
  // explain a match from these records, and without them a match made on
  // "Matched By Rule Set" or "Has Pending Action" recorded neither among the
  // criteria it matched on.
  return filteredItems.map((item) => ({
    ...item,
    ...(crossSystemData?.get(item.id) ?? {}),
    fileSize: item.fileSize?.toString() ?? null,
  }));
}

/**
 * Group series-level results by parentTitle+libraryId so that each series
 * appears once instead of once per episode.  Keeps the first matched
 * episode as a representative (for external IDs, etc.) and adds a
 * `matchedEpisodes` count.
 */
export function groupSeriesResults<
  T extends { id: string; title: string; parentTitle: string | null; seriesKey?: string | null; externalIds?: ReadonlyArray<{ source: string; externalId: string }> | null; libraryId: string; playCount: number; fileSize: string | null; lastPlayedAt?: string | Date | null; seasonNumber?: number | null; episodeNumber?: number | null }
>(items: T[]): (T & { matchedEpisodes: number; memberIds: string[] })[] {
  const groups = new Map<string, { representative: T; count: number; totalPlays: number; totalSize: bigint; latestPlayed: Date | null; memberIds: string[] }>();

  for (const item of items) {
    // Series identity per library — same rationale as evaluateSeriesScope.
    const key = `${item.libraryId}::${resolveSeriesKey(item) ?? item.libraryId}`;
    const existing = groups.get(key);
    const playedDate = item.lastPlayedAt ? new Date(item.lastPlayedAt) : null;
    const size = item.fileSize ? BigInt(item.fileSize) : BigInt(0);

    if (!existing) {
      groups.set(key, {
        representative: item,
        count: 1,
        totalPlays: item.playCount,
        totalSize: size,
        latestPlayed: playedDate,
        memberIds: [item.id],
      });
    } else {
      existing.count++;
      existing.totalPlays += item.playCount;
      existing.totalSize += size;
      existing.memberIds.push(item.id);
      if (playedDate && (!existing.latestPlayed || playedDate > existing.latestPlayed)) {
        existing.latestPlayed = playedDate;
      }
      // Keep representative with lowest id for stability across syncs
      if (compareIds(item.id, existing.representative.id) < 0) {
        existing.representative = item;
      }
    }
  }

  return [...groups.values()].map(({ representative, count, totalPlays, totalSize, latestPlayed, memberIds }) => ({
    ...representative,
    // Use series name as title, clear episode-specific fields. The rules were
    // already evaluated per episode, against each episode's own parentTitle;
    // this is the match's group snapshot, whose criteria are reported with the
    // show's name as its parentTitle (asEvaluated → withGroupParentTitle).
    title: representative.parentTitle ?? representative.title,
    parentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    playCount: totalPlays,
    fileSize: totalSize > BigInt(0) ? totalSize.toString() : null,
    lastPlayedAt: latestPlayed?.toISOString() ?? null,
    matchedEpisodes: count,
    memberIds,
  }));
}
