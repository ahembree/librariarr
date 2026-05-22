import { prisma } from "@/lib/db";
import type { Rule, RuleGroup, RuleCondition, StreamQueryField } from "./types";
import {
  isArrField, isSeerrField, isExternalField, isStreamField, isSeriesAggregateField,
  isCrossSystemField,
  isStreamQueryField, isStreamQueryGroup, isStreamQueryComputedField,
  streamQueryFieldToColumn, STREAM_TYPE_INT_MAP,
  RULE_FIELDS, STREAM_QUERY_FIELDS, type RuleField,
} from "./types";
import { isEnumerableField, isOperatorApplicable, isValueValidForRule } from "@/lib/conditions/helpers";
import { detectStreamAudioProfile, detectStreamDynamicRange } from "./stream-detection";
import { normalizeResolutionLabel } from "@/lib/resolution";
import {
  MB_IN_BYTES,
  DURATION_MS_PER_MIN,
  wildcardToRegex,
} from "@/lib/conditions";
import {
  isUnconfiguredContainsRule,
  validateRulePreamble,
  FIELD_HANDLERS,
  textGenericHandler,
} from "@/lib/conditions/where-builder";
import { fetchCrossSystemData } from "@/lib/conditions/cross-system-data";
import { buildStreamQueryClause } from "@/lib/conditions/stream-query-where";
import { Prisma } from "@/generated/prisma/client";

const STREAM_COUNT_FIELDS = new Set(["audioStreamCount", "subtitleStreamCount"]);

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

function ruleToWhereClause(rule: Rule): Prisma.MediaItemWhereInput {
  const { field, operator, value, negate } = rule;

  // Safety preamble: unconfigured rule, inapplicable operator, malformed
  // value → UNSATISFIABLE_WHERE. Shared with the query builder.
  const guarded = validateRulePreamble(field, operator, value);
  if (guarded) return guarded;

  // Skip external fields — they are handled as post-filters
  if (isExternalField(field)) return {};

  // Skip series aggregate fields — computed during evaluateSeriesScope()
  if (isSeriesAggregateField(field)) return {};

  // Skip cross-system fields — enriched before Phase 2
  if (isCrossSystemField(field)) return {};

  // Stream query fields — handled at the group level via buildStreamQueryClause
  if (isStreamQueryField(field)) return {};

  // Stream count fields — always post-filtered in-memory
  if (STREAM_COUNT_FIELDS.has(field)) return {};

  // Field-specific WHERE-emitting handlers live in where-builder.ts and are
  // shared with the query builder. The dispatcher above handles all the
  // engine-specific routing (external, series aggregate, cross-system,
  // stream query/count) before reaching this lookup; stream relation,
  // hasExternalId are routed via FIELD_HANDLERS.
  const handler = FIELD_HANDLERS[field];
  if (handler) return handler(operator, value, field, negate);

  // Text-generic fallback for unrecognized text fields (parentTitle, albumTitle,
  // videoProfile, videoFrameRate, aspectRatio, scanType, contentRating, studio,
  // videoCodec, audioCodec, container, etc.).
  return textGenericHandler(operator, value, field, negate);
}

function isRuleGroups(input: Rule[] | RuleGroup[]): input is RuleGroup[] {
  return input.length > 0 && "rules" in input[0];
}

/**
 * Check whether a rule set contains at least 1 enabled rule.
 * Returns false if all rules/groups are disabled or empty — lifecycle
 * processing requires at least 1 active rule to avoid matching everything.
 */
export function hasAnyActiveRules(rules: Rule[] | RuleGroup[]): boolean {
  if (rules.length === 0) return false;
  if (isRuleGroups(rules)) {
    return (rules as RuleGroup[]).some(
      (g) =>
        g.enabled !== false &&
        (g.rules.some((r) => r.enabled !== false) ||
          (g.groups ?? []).some((sub) =>
            hasAnyActiveRules([sub] as RuleGroup[])
          ))
    );
  }
  return (rules as Rule[]).some((r) => r.enabled !== false);
}

/**
 * Check if a stream query group has any computed or wildcard rules
 * that require in-memory evaluation.
 */
function streamQueryNeedsInMemory(group: RuleGroup): boolean {
  if (!group.streamQuery) return false;
  // `all` quantifier requires Phase 2 re-evaluation: Phase 1's NOT-of-relation
  // clause cannot precisely express "every stream of this type matches" when
  // the column is nullable. PostgreSQL's `NOT (col = X)` is UNKNOWN for NULL
  // columns, so a NULL-column stream is not counted as "failing" the match,
  // and the relation-level `none-failing` clause vacuously over-matches.
  // Phase 1 still emits a superset clause via buildStreamQueryClause; Phase 2
  // narrows it to the precise `matchingStreams.every(streamMatches)` semantics.
  if ((group.streamQuery.quantifier ?? "any") === "all") return true;
  return group.rules.some((r) =>
    r.enabled !== false && (
      isStreamQueryComputedField(r.field) ||
      r.operator === "matchesWildcard" ||
      r.operator === "notMatchesWildcard"
    ),
  );
}

/**
 * Recursively evaluate a single RuleGroup into a Prisma where clause.
 * Rules and nested sub-groups are combined using their individual `condition` fields.
 */
function evaluateGroup(group: RuleGroup): Prisma.MediaItemWhereInput | null {
  if (group.enabled === false) return null;

  // Stream query groups: build a single `streams: { some: { ... } }` clause
  if (isStreamQueryGroup(group)) {
    return buildStreamQueryClause(group);
  }

  const items: Array<{ condition: RuleCondition; clause: Prisma.MediaItemWhereInput }> = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    const clause = ruleToWhereClause(rule);
    if (Object.keys(clause).length > 0) items.push({ condition: rule.condition, clause });
  }

  for (const sub of group.groups ?? []) {
    const subClause = evaluateGroup(sub);
    if (subClause) items.push({ condition: sub.condition, clause: subClause });
  }

  if (items.length === 0) return null;
  if (items.length === 1) return items[0].clause;

  let result: Prisma.MediaItemWhereInput = items[0].clause;
  for (let i = 1; i < items.length; i++) {
    const { condition, clause } = items[i];
    if (condition === "OR") {
      result = { OR: [result, clause] };
    } else {
      result = { AND: [result, clause] };
    }
  }
  return result;
}

function buildGroupConditions(ruleGroups: RuleGroup[]): Prisma.MediaItemWhereInput {
  const groupClauses: Array<{ condition: "AND" | "OR"; where: Prisma.MediaItemWhereInput }> = [];

  for (const group of ruleGroups) {
    const where = evaluateGroup(group);
    if (!where) continue;
    groupClauses.push({ condition: group.condition, where });
  }

  if (groupClauses.length === 0) return {};
  if (groupClauses.length === 1) return groupClauses[0].where;

  // Build nested AND/OR tree from left to right
  let result: Prisma.MediaItemWhereInput = groupClauses[0].where;
  for (let i = 1; i < groupClauses.length; i++) {
    const { condition, where } = groupClauses[i];
    if (condition === "OR") {
      result = { OR: [result, where] };
    } else {
      result = { AND: [result, where] };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pre-filter variants for Phase 1 queries when Phase 2 in-memory re-eval
// will follow. Non-DB-expressible rules (Arr/Seerr fields, wildcards, stream
// counts) produce EXTERNAL_RULE instead of being silently dropped.
//
// Propagation rules:
//   EXTERNAL_RULE OR  X             = EXTERNAL_RULE  (dropped OR branch might match anything)
//   X             OR  EXTERNAL_RULE = EXTERNAL_RULE
//   EXTERNAL_RULE AND X             = X              (dropped AND constraint is safely relaxed)
//   X             AND EXTERNAL_RULE = X
//
// This ensures the pre-filter WHERE is always a SUPERSET of the in-memory
// result, so no items that would pass Phase 2 are excluded by Phase 1.
// ---------------------------------------------------------------------------

const EXTERNAL_RULE = "EXTERNAL_RULE" as const;
type PreFilterClause = Prisma.MediaItemWhereInput | typeof EXTERNAL_RULE;

function combinePreFilter(
  left: PreFilterClause,
  right: PreFilterClause,
  condition: "AND" | "OR"
): PreFilterClause {
  if (condition === "OR") {
    if (left === EXTERNAL_RULE || right === EXTERNAL_RULE) return EXTERNAL_RULE;
    return { OR: [left, right] };
  } else {
    if (left === EXTERNAL_RULE) return right;
    if (right === EXTERNAL_RULE) return left;
    return { AND: [left, right] };
  }
}

/**
 * Pre-filter variant of evaluateGroup. Non-DB-expressible rules (Arr/Seerr
 * fields, wildcards, stream counts) produce EXTERNAL_RULE so that OR branches
 * with external fields don't incorrectly narrow results. Returns null only for
 * disabled groups (truly skip), EXTERNAL_RULE for groups that can't be filtered
 * in DB, or a concrete Prisma clause.
 */
function evaluateGroupPreFilter(group: RuleGroup): PreFilterClause | null {
  if (group.enabled === false) return null;

  // Stream query groups: build DB clause if possible, EXTERNAL_RULE if it has computed/wildcard rules
  if (isStreamQueryGroup(group)) {
    const dbClause = buildStreamQueryClause(group);
    if (streamQueryNeedsInMemory(group)) {
      // Has computed fields — the DB clause is a partial pre-filter at best
      return dbClause ? combinePreFilter(dbClause, EXTERNAL_RULE, "AND") : EXTERNAL_RULE;
    }
    return dbClause ?? EXTERNAL_RULE;
  }

  const items: Array<{ condition: RuleCondition; clause: PreFilterClause }> = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    const clause = ruleToWhereClause(rule);
    items.push({
      condition: rule.condition,
      clause: Object.keys(clause).length > 0 ? clause : EXTERNAL_RULE,
    });
  }

  for (const sub of group.groups ?? []) {
    const subClause = evaluateGroupPreFilter(sub);
    if (subClause === null) continue; // Disabled sub-group, truly skip
    items.push({ condition: sub.condition, clause: subClause });
  }

  if (items.length === 0) return null;
  if (items.length === 1) return items[0].clause;

  let result: PreFilterClause = items[0].clause;
  for (let i = 1; i < items.length; i++) {
    result = combinePreFilter(result, items[i].clause, items[i].condition);
  }
  return result;
}

function buildGroupConditionsPreFilter(ruleGroups: RuleGroup[]): Prisma.MediaItemWhereInput {
  const groupClauses: Array<{ condition: "AND" | "OR"; clause: PreFilterClause }> = [];

  for (const group of ruleGroups) {
    const result = evaluateGroupPreFilter(group);
    if (result === null) continue;
    groupClauses.push({ condition: group.condition, clause: result });
  }

  if (groupClauses.length === 0) return {};

  let result: PreFilterClause = groupClauses[0].clause;
  for (let i = 1; i < groupClauses.length; i++) {
    result = combinePreFilter(result, groupClauses[i].clause, groupClauses[i].condition);
  }
  return result === EXTERNAL_RULE ? {} : result;
}

function legacyRulesToConditions(rules: Rule[]): Prisma.MediaItemWhereInput[] {
  const groups: Prisma.MediaItemWhereInput[][] = [[]];
  for (let i = 0; i < rules.length; i++) {
    const clause = ruleToWhereClause(rules[i]);
    if (Object.keys(clause).length > 0) {
      groups[groups.length - 1].push(clause);
    }
    if (i < rules.length - 1 && rules[i].condition === "AND") {
      groups.push([]);
    }
  }
  return groups
    .filter((g) => g.length > 0)
    .map((group) => {
      if (group.length === 1) return group[0];
      return { OR: group };
    });
}

/** Check if any rule in the tree uses arr fields */
function hasArrRules(rules: Rule[] | RuleGroup[]): boolean {
  if (rules.length === 0) return false;
  if (isRuleGroups(rules)) {
    for (const group of rules) {
      if (group.enabled === false) continue;
      if (group.rules.some((r) => r.enabled !== false && isArrField(r.field))) return true;
      if (hasArrRules(group.groups ?? [])) return true;
    }
    return false;
  }
  return (rules as Rule[]).some((r) => r.enabled !== false && isArrField(r.field));
}

/** Check if any rule in the tree uses seerr fields */
function hasSeerrRules(rules: Rule[] | RuleGroup[]): boolean {
  if (rules.length === 0) return false;
  if (isRuleGroups(rules)) {
    for (const group of rules) {
      if (group.enabled === false) continue;
      if (group.rules.some((r) => r.enabled !== false && isSeerrField(r.field))) return true;
      if (hasSeerrRules(group.groups ?? [])) return true;
    }
    return false;
  }
  return (rules as Rule[]).some((r) => r.enabled !== false && isSeerrField(r.field));
}

/** Check if any rule uses wildcard operators on non-external fields */
function hasWildcardRules(rules: Rule[] | RuleGroup[]): boolean {
  if (rules.length === 0) return false;
  if (isRuleGroups(rules)) {
    for (const group of rules) {
      if (group.enabled === false) continue;
      if (group.rules.some((r) => r.enabled !== false && !isExternalField(r.field) && (r.operator === "matchesWildcard" || r.operator === "notMatchesWildcard"))) return true;
      if (hasWildcardRules(group.groups ?? [])) return true;
    }
    return false;
  }
  return (rules as Rule[]).some((r) => r.enabled !== false && !isExternalField(r.field) && (r.operator === "matchesWildcard" || r.operator === "notMatchesWildcard"));
}

/** Check if any rule uses stream fields or stream query groups */
function hasStreamRules(rules: Rule[] | RuleGroup[]): boolean {
  if (rules.length === 0) return false;
  if (isRuleGroups(rules)) {
    for (const group of rules) {
      if (group.enabled === false) continue;
      if (isStreamQueryGroup(group)) return true;
      if (group.rules.some((r) => r.enabled !== false && isStreamField(r.field))) return true;
      if (hasStreamRules(group.groups ?? [])) return true;
    }
    return false;
  }
  return (rules as Rule[]).some((r) => r.enabled !== false && isStreamField(r.field));
}

/** Check if any stream query group requires in-memory evaluation (computed/wildcard fields) */
function hasStreamQueryInMemoryRules(rules: Rule[] | RuleGroup[]): boolean {
  if (rules.length === 0) return false;
  if (isRuleGroups(rules)) {
    for (const group of rules) {
      if (group.enabled === false) continue;
      if (isStreamQueryGroup(group) && streamQueryNeedsInMemory(group)) return true;
      if (hasStreamQueryInMemoryRules(group.groups ?? [])) return true;
    }
    return false;
  }
  return false;
}

/** Check if any rule uses stream count fields (always require in-memory evaluation) */
function hasStreamCountRules(rules: Rule[] | RuleGroup[]): boolean {
  if (rules.length === 0) return false;
  if (isRuleGroups(rules)) {
    for (const group of rules) {
      if (group.enabled === false) continue;
      if (group.rules.some((r) => r.enabled !== false && STREAM_COUNT_FIELDS.has(r.field))) return true;
      if (hasStreamCountRules(group.groups ?? [])) return true;
    }
    return false;
  }
  return (rules as Rule[]).some((r) => r.enabled !== false && STREAM_COUNT_FIELDS.has(r.field));
}

/** Check if any rule uses cross-system fields (always require in-memory evaluation) */
function hasCrossSystemFieldRules(rules: Rule[] | RuleGroup[]): boolean {
  if (rules.length === 0) return false;
  if (isRuleGroups(rules)) {
    for (const group of rules) {
      if (group.enabled === false) continue;
      if (group.rules.some((r) => r.enabled !== false && isCrossSystemField(r.field))) return true;
      if (hasCrossSystemFieldRules(group.groups ?? [])) return true;
    }
    return false;
  }
  return (rules as Rule[]).some((r) => r.enabled !== false && isCrossSystemField(r.field));
}

/** Check if any rule uses hasExternalId field */
function hasExternalIdFieldRules(rules: Rule[] | RuleGroup[]): boolean {
  if (rules.length === 0) return false;
  if (isRuleGroups(rules)) {
    for (const group of rules) {
      if (group.enabled === false) continue;
      if (group.rules.some((r) => r.enabled !== false && r.field === "hasExternalId")) return true;
      if (hasExternalIdFieldRules(group.groups ?? [])) return true;
    }
    return false;
  }
  return (rules as Rule[]).some((r) => r.enabled !== false && r.field === "hasExternalId");
}

/** Evaluate a single arr rule against arr metadata for an item */
function evaluateArrRule(rule: Rule, meta: ArrMetadata | undefined): boolean {
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
    const boolVal = String(rule.value).toLowerCase() === "true";
    const found = meta !== undefined;
    const result = rule.operator === "notEquals" ? found !== boolVal : found === boolVal;
    return rule.negate ? !result : result;
  }
  if (!meta) return false;
  const { field, operator, value, negate } = rule;
  let result: boolean;

  switch (field) {
    case "arrTag": {
      const strVal = String(value).toLowerCase();
      switch (operator) {
        case "equals":
          result = meta.tags.some((t) => t.toLowerCase() === strVal);
          break;
        case "notEquals":
          result = !meta.tags.some((t) => t.toLowerCase() === strVal);
          break;
        case "contains": {
          // Enumerable multi-select — exact list membership against tag set.
          const values = strVal.split("|").filter(Boolean);
          result = values.some((v) => meta.tags.some((t) => t.toLowerCase() === v));
          break;
        }
        case "notContains": {
          const values = strVal.split("|").filter(Boolean);
          result = !values.some((v) => meta.tags.some((t) => t.toLowerCase() === v));
          break;
        }
        case "matchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = meta.tags.some((t) => re.test(t));
          break;
        }
        case "notMatchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = !meta.tags.some((t) => re.test(t));
          break;
        }
        default:
          return false;
      }
      break;
    }
    case "arrQualityProfile": {
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
      if (meta.rating === null) { result = false; break; }
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
      if (meta.tmdbRating === null) { result = false; break; }
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
      if (meta.rtCriticRating === null) { result = false; break; }
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
      if (!itemDate || isNaN(itemDate.getTime())) {
        result = false;
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
          result = itemDay >= fromStr && itemDay <= toStr;
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
      if (meta.sizeOnDisk === null) { result = false; break; }
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
    case "arrMonitoredSeasonCount":
    case "arrMonitoredEpisodeCount": {
      const metaVal =
        field === "arrRuntime" ? meta.runtime :
        field === "arrSeasonCount" ? meta.seasonCount :
        field === "arrEpisodeCount" ? meta.episodeCount :
        field === "arrMonitoredSeasonCount" ? meta.monitoredSeasonCount :
        meta.monitoredEpisodeCount;
      if (operator === "isNull") { result = metaVal === null; break; }
      if (operator === "isNotNull") { result = metaVal !== null; break; }
      if (metaVal === null) { result = false; break; }
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
      if (metaVal === null) { result = false; break; }
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
      if (metaVal === null) { result = false; break; }
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

/** Evaluate a single seerr rule against seerr metadata for an item */
function evaluateSeerrRule(rule: Rule, meta: SeerrMetadata | undefined): boolean {
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
      if (!itemDate || isNaN(itemDate.getTime())) {
        result = false;
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
          result = itemDay >= fromStr && itemDay <= toStr;
          break;
        }
        default:
          return false;
      }
      break;
    }
    case "seerrRequestedBy": {
      const strVal = String(value).toLowerCase();
      switch (operator) {
        case "equals":
          result = m.requestedBy.some((u) => u.toLowerCase() === strVal);
          break;
        case "notEquals":
          result = !m.requestedBy.some((u) => u.toLowerCase() === strVal);
          break;
        case "contains": {
          // Enumerable multi-select — exact list membership against requester usernames.
          const values = strVal.split("|").filter(Boolean);
          result = values.some((v) =>
            m.requestedBy.some((u) => u.toLowerCase() === v)
          );
          break;
        }
        case "notContains": {
          const values = strVal.split("|").filter(Boolean);
          result = !values.some((v) =>
            m.requestedBy.some((u) => u.toLowerCase() === v)
          );
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

export interface MatchedCriterion {
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
  rule: Rule,
  item: Record<string, unknown>,
  arrMeta?: ArrMetadata,
  seerrMeta?: SeerrMetadata
): boolean {
  // Safety: unconfigured contains/notContains matches nothing (ignoring negate).
  // Mirrors `ruleToWhereClause`'s UNSATISFIABLE_WHERE so Phase 1 and Phase 2 agree.
  if (isUnconfiguredContainsRule(rule.operator, rule.value)) return false;
  // Safety: unknown operator or operator/field-type mismatch → match nothing.
  // Without this, `default: result = false` in any operator switch would be
  // vacuously flipped to true by negate=true and sweep the library.
  if (!isOperatorApplicable(rule.operator, rule.field)) return false;
  // Safety: malformed value (NaN, unparseable date, etc.) → match nothing,
  // bypassing negate.
  if (!isValueValidForRule(rule.operator, rule.value, rule.field)) return false;

  const { field, operator, value, negate } = rule;

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

    // isNull/isNotNull check whether any known values exist
    if (operator === "isNull" || operator === "isNotNull") {
      const result = operator === "isNull" ? streamValues.length === 0 : streamValues.length > 0;
      return negate ? !result : result;
    }

    // If all language streams were filtered out, the item has no known language — don't match
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
      default: return false;
    }
    return negate ? !result : result;
  }

  // Genre / Labels (JSON array fields). Enumerable multi-select: `contains`
  // means "any selected value is present in the array".
  if (field === "genre" || field === "labels") {
    const sourceCol = field === "labels" ? "labels" : "genres";
    const arr = Array.isArray(item[sourceCol]) ? (item[sourceCol] as string[]).map((g) => g.toLowerCase()) : [];
    const strValue = String(value).toLowerCase();
    let result: boolean;
    switch (operator) {
      case "equals":
        result = arr.some((g) => g === strValue);
        break;
      case "contains": {
        const parts = strValue.split("|").filter(Boolean);
        const matchValues = parts.length > 0 ? parts : [strValue];
        result = matchValues.some((v) => arr.some((g) => g === v));
        break;
      }
      case "notContains": {
        const parts = strValue.split("|").filter(Boolean);
        const matchValues = parts.length > 0 ? parts : [strValue];
        result = !matchValues.some((v) => arr.some((g) => g === v));
        break;
      }
      case "notEquals":
        result = !arr.some((g) => g === strValue);
        break;
      case "matchesWildcard": {
        const re = wildcardToRegex(strValue);
        result = arr.some((g) => re.test(g));
        break;
      }
      case "notMatchesWildcard": {
        const re = wildcardToRegex(strValue);
        result = !arr.some((g) => re.test(g));
        break;
      }
      case "isNull":
        // No genres assigned (NULL JSON column OR empty array). Mirrors the
        // Phase 1 `{ [column]: { equals: Prisma.DbNull } }` and treats the
        // "no assignments" case symmetrically.
        result = arr.length === 0;
        break;
      case "isNotNull":
        result = arr.length > 0;
        break;
      default: return false;
    }
    return negate ? !result : result;
  }

  // Has External ID
  if (field === "hasExternalId") {
    const externalIds = (item.externalIds as Array<{ source: string }>) ?? [];
    const strValue = String(value);
    let result: boolean;
    switch (operator) {
      case "equals":
      case "isNotNull":
        result = externalIds.some((e) => e.source === strValue);
        break;
      case "notEquals":
      case "isNull":
        result = !externalIds.some((e) => e.source === strValue);
        break;
      default: return false;
    }
    return negate ? !result : result;
  }

  // Is Watchlisted (boolean)
  if (field === "isWatchlisted") {
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
      const matchedSets = (item.matchedRuleSets as string[]) ?? [];
      const matchedLower = matchedSets.map((s) => s.toLowerCase());
      const strValue = String(value).toLowerCase();
      let result: boolean;
      switch (operator) {
        case "equals": result = matchedLower.includes(strValue); break;
        case "notEquals": result = !matchedLower.includes(strValue); break;
        case "contains": {
          // Enumerable multi-select — exact list membership against rule-set names.
          const values = strValue.split("|").filter(Boolean);
          result = values.some((v) => matchedLower.includes(v));
          break;
        }
        case "notContains": {
          const values = strValue.split("|").filter(Boolean);
          result = !values.some((v) => matchedLower.includes(v));
          break;
        }
        case "isNull": result = matchedSets.length === 0; break;
        case "isNotNull": result = matchedSets.length > 0; break;
        default: return false;
      }
      return negate ? !result : result;
    }
    if (field === "hasPendingAction") {
      const hasPending = !!item.hasPendingAction;
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
    const bytesValue = BigInt(Math.round(Number(value) * MB_IN_BYTES));
    const fileBytes = item.fileSize ? BigInt(item.fileSize as string) : BigInt(0);
    let result: boolean;
    switch (operator) {
      case "greaterThan": result = fileBytes > bytesValue; break;
      case "greaterThanOrEqual": result = fileBytes >= bytesValue; break;
      case "lessThan": result = fileBytes < bytesValue; break;
      case "lessThanOrEqual": result = fileBytes <= bytesValue; break;
      case "equals": result = fileBytes === bytesValue; break;
      case "notEquals": result = fileBytes !== bytesValue; break;
      case "between": {
        const [minStr, maxStr] = String(value).split(",");
        const minBytes = BigInt(Math.round(Number(minStr) * MB_IN_BYTES));
        const maxBytes = BigInt(Math.round(Number(maxStr) * MB_IN_BYTES));
        result = fileBytes >= minBytes && fileBytes <= maxBytes;
        break;
      }
      default: return false;
    }
    return negate ? !result : result;
  }

  // Duration: rule value is in minutes, item.duration is in milliseconds
  if (field === "duration") {
    const msValue = Number(value) * DURATION_MS_PER_MIN;
    const itemMs = Number(itemValue ?? 0);
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
    "latestEpisodeViewDate", "lastEpisodeAddedAt", "lastEpisodeAiredAt",
  ]);
  if (dateFields.has(field)) {
    const itemDate = itemValue ? new Date(itemValue as string) : null;
    let result: boolean;
    if (!itemDate || isNaN(itemDate.getTime())) {
      result = false;
    } else {
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
          result = itemDay >= fromStr && itemDay <= toStr;
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
    const numValue = Number(value);
    const itemNum = Number(itemValue ?? 0);
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
    const normalizedLabel = normalizeResolutionLabel(rawRes);
    const strVal = String(value);
    let resResult: boolean;
    if (rawRes === null || rawRes === "") {
      resResult = false;
    } else {
      const labelLower = normalizedLabel.toLowerCase();
      const valLower = strVal.toLowerCase();
      switch (operator) {
        case "equals": resResult = labelLower === valLower; break;
        case "notEquals": resResult = labelLower !== valLower; break;
        case "contains": {
          // Resolution is enumerable — `contains` is multi-select list membership.
          const parts = valLower.split("|").filter(Boolean);
          resResult = parts.some((p) => labelLower === p);
          break;
        }
        case "notContains": {
          const parts = valLower.split("|").filter(Boolean);
          resResult = !parts.some((p) => labelLower === p);
          break;
        }
        case "matchesWildcard": resResult = wildcardToRegex(valLower).test(labelLower); break;
        case "notMatchesWildcard": resResult = !wildcardToRegex(valLower).test(labelLower); break;
        default: resResult = false;
      }
    }
    return negate ? !resResult : resResult;
  }

  // Text fields (case-insensitive to match Prisma behavior).
  // Enumerable fields use list-membership semantics for contains/notContains
  // (mirrors the multi-select UI), free-text fields use substring search.
  const strValue = String(value).toLowerCase();
  const itemStr = String(itemValue ?? "").toLowerCase();
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

function collectAllRulesWithGroup(rules: Rule[] | RuleGroup[]): Array<{ rule: Rule; groupName?: string }> {
  const all: Array<{ rule: Rule; groupName?: string }> = [];
  if (isRuleGroups(rules)) {
    for (const group of rules as RuleGroup[]) {
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
    for (const rule of rules as Rule[]) {
      if (rule.enabled === false) continue;
      all.push({ rule });
    }
  }
  return all;
}

/** Collect stream query groups from the rule tree */
function collectStreamQueryGroups(rules: Rule[] | RuleGroup[]): RuleGroup[] {
  const groups: RuleGroup[] = [];
  if (!isRuleGroups(rules)) return groups;
  for (const group of rules as RuleGroup[]) {
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
 * Items must already be confirmed matches from evaluateRules().
 */

/** Extract the actual item value for a rule field, formatted for display */
function getActualValueForField(
  field: RuleField,
  item: Record<string, unknown>,
  arrMeta?: ArrMetadata,
  seerrMeta?: SeerrMetadata,
): string | null {
  // Helper to format dates nicely
  const fmtDate = (v: unknown): string | null => {
    if (!v) return null;
    const d = new Date(v as string);
    if (isNaN(d.getTime())) return null;
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

  // Genre / Labels (JSON array fields)
  if (field === "genre" || field === "labels") {
    const sourceCol = field === "labels" ? "labels" : "genres";
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
    "latestEpisodeViewDate", "lastEpisodeAddedAt", "lastEpisodeAiredAt",
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

export function getMatchedCriteriaForItems(
  items: Array<Record<string, unknown>>,
  rules: Rule[] | RuleGroup[],
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

  for (const item of items) {
    const criteria: MatchedCriterion[] = [];
    const externalIds = (item.externalIds ?? []) as Array<{ source: string; externalId: string }>;
    const arrExtId = externalIds.find((e) => e.source === arrIdSource);
    const arrMeta = arrData && arrExtId ? arrData[arrExtId.externalId] : undefined;
    const seerrMeta = lookupSeerrMeta(externalIds, seerrData, type);

    for (const { rule, groupName } of allRulesWithGroup) {
      if (evaluateRuleAgainstItem(rule, item, arrMeta, seerrMeta)) {
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
          actualValue: getActualValueForField(rule.field, item, arrMeta, seerrMeta) ?? undefined,
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

    result.set(item.id as string, criteria);
  }

  return result;
}

/**
 * Compute actual item values for ALL enabled rules (not just matched ones).
 * Returns a map of itemId → Map<ruleId, actualValue>.
 */
export function getActualValuesForAllRules(
  items: Array<Record<string, unknown>>,
  rules: Rule[] | RuleGroup[],
  type: "MOVIE" | "SERIES" | "MUSIC",
  arrData?: ArrDataMap,
  seerrData?: SeerrDataMap
): Map<string, Map<string, string>> {
  const arrIdSource = type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";
  const allRulesWithGroup = collectAllRulesWithGroup(rules);
  const result = new Map<string, Map<string, string>>();

  for (const item of items) {
    const values = new Map<string, string>();
    const externalIds = (item.externalIds ?? []) as Array<{ source: string; externalId: string }>;
    const arrExtId = externalIds.find((e) => e.source === arrIdSource);
    const arrMeta = arrData && arrExtId ? arrData[arrExtId.externalId] : undefined;
    const seerrMeta = lookupSeerrMeta(externalIds, seerrData, type);

    for (const { rule } of allRulesWithGroup) {
      const actual = getActualValueForField(rule.field, item, arrMeta, seerrMeta);
      if (actual != null) values.set(rule.id, actual);
    }

    result.set(item.id as string, values);
  }

  return result;
}

/**
 * Evaluate a single stream query rule against one stream record.
 * Returns true if the rule matches this specific stream.
 */
function evaluateStreamQueryRuleAgainstStream(
  rule: Rule,
  stream: Record<string, unknown>,
): boolean {
  // Safety: unconfigured contains/notContains matches nothing (ignoring negate).
  if (isUnconfiguredContainsRule(rule.operator, rule.value)) return false;
  // Safety: unknown operator or wrong-type combo → match nothing (bypass negate).
  if (!isOperatorApplicable(rule.operator, rule.field)) return false;
  // Safety: malformed value → match nothing.
  if (!isValueValidForRule(rule.operator, rule.value, rule.field)) return false;
  const field = rule.field as StreamQueryField;
  const { operator, value, negate } = rule;

  // Get the value from the stream
  let streamValue: unknown;
  if (field === "sqAudioProfile") {
    streamValue = detectStreamAudioProfile(stream as Record<string, string | null>);
  } else if (field === "sqDynamicRange") {
    streamValue = detectStreamDynamicRange(stream as Record<string, string | null>);
  } else {
    const column = streamQueryFieldToColumn(field);
    if (!column) return false;
    streamValue = stream[column];
  }

  // Boolean fields
  if (field === "sqIsDefault" || field === "sqForced") {
    const boolVal = String(value).toLowerCase() === "true";
    const actual = !!streamValue;
    let result: boolean;
    switch (operator) {
      case "equals": result = actual === boolVal; break;
      case "notEquals": result = actual !== boolVal; break;
      default: return false;
    }
    return negate ? !result : result;
  }

  // Numeric fields
  if (["sqChannels", "sqBitrate", "sqBitDepth", "sqWidth", "sqHeight", "sqFrameRate", "sqSamplingRate"].includes(field)) {
    const numValue = Number(value);
    const actual = streamValue != null ? Number(streamValue) : null;

    let result: boolean;
    switch (operator) {
      case "isNull": result = actual == null; break;
      case "isNotNull": result = actual != null; break;
      default: {
        if (actual == null) return negate ? true : false;
        switch (operator) {
          case "equals": result = actual === numValue; break;
          case "notEquals": result = actual !== numValue; break;
          case "greaterThan": result = actual > numValue; break;
          case "greaterThanOrEqual": result = actual >= numValue; break;
          case "lessThan": result = actual < numValue; break;
          case "lessThanOrEqual": result = actual <= numValue; break;
          case "between": {
            const [minStr, maxStr] = String(value).split(",");
            result = actual >= Number(minStr) && actual <= Number(maxStr);
            break;
          }
          default: return false;
        }
      }
    }
    return negate ? !result : result;
  }

  // Text fields (including computed)
  const strActual = streamValue != null ? String(streamValue).toLowerCase() : "";
  const strValue = String(value).toLowerCase();
  const streamEnumerable = isEnumerableField(field);

  let result: boolean;
  switch (operator) {
    case "isNull": result = streamValue == null || strActual === ""; break;
    case "isNotNull": result = streamValue != null && strActual !== ""; break;
    case "equals": result = strActual === strValue; break;
    case "notEquals": result = strActual !== strValue; break;
    case "contains": {
      if (streamEnumerable) {
        const parts = strValue.split("|").filter(Boolean);
        result = parts.length > 0
          ? parts.some((p) => strActual === p)
          : strActual === strValue;
      } else {
        result = strActual.includes(strValue);
      }
      break;
    }
    case "notContains": {
      if (streamEnumerable) {
        const parts = strValue.split("|").filter(Boolean);
        result = parts.length > 0
          ? !parts.some((p) => strActual === p)
          : strActual !== strValue;
      } else {
        result = !strActual.includes(strValue);
      }
      break;
    }
    case "matchesWildcard": {
      const re = wildcardToRegex(strValue);
      result = re.test(strActual);
      break;
    }
    case "notMatchesWildcard": {
      const re = wildcardToRegex(strValue);
      result = !re.test(strActual);
      break;
    }
    default: return false;
  }
  return negate ? !result : result;
}

/**
 * Evaluate a stream query group in-memory: check if ANY stream of the
 * matching type satisfies ALL active rules.
 */
function evaluateStreamQueryGroupInMemory(
  group: RuleGroup,
  item: Record<string, unknown>,
): boolean {
  if (!group.streamQuery) return false;
  const streamTypeInt = STREAM_TYPE_INT_MAP[group.streamQuery.streamType];
  const streams = (item.streams as Array<Record<string, unknown>>) ?? [];
  const matchingStreams = streams.filter((s) => s.streamType === streamTypeInt);

  const activeRules = group.rules.filter((r) => r.enabled !== false);
  if (activeRules.length === 0) return false;

  // Safety: an unconfigured contains/notContains rule, an operator that
  // doesn't apply to the field type, or a malformed value makes the entire
  // group unsatisfiable. Without this guard, quantifier="none" would be
  // vacuously true ("no stream matches false") and sweep the library.
  if (activeRules.some((rule) =>
    isUnconfiguredContainsRule(rule.operator, rule.value) ||
    !isOperatorApplicable(rule.operator, rule.field) ||
    !isValueValidForRule(rule.operator, rule.value, rule.field)
  )) {
    return false;
  }

  const quantifier = group.streamQuery.quantifier ?? "any";
  const streamMatches = (stream: Record<string, unknown>) =>
    activeRules.every((rule) => evaluateStreamQueryRuleAgainstStream(rule, stream));

  if (quantifier === "none") {
    return !matchingStreams.some(streamMatches);
  }
  if (quantifier === "all") {
    return matchingStreams.length > 0 && matchingStreams.every(streamMatches);
  }
  // Default: "any" (EXISTS)
  return matchingStreams.some(streamMatches);
}

function evaluateRuleGroupInMemory(
  group: RuleGroup,
  item: Record<string, unknown>,
  arrMeta?: ArrMetadata,
  seerrMeta?: SeerrMetadata
): boolean | null {
  if (group.enabled === false) return null; // Skip disabled group (mirrors Phase 1)

  // Stream query groups: evaluate per-stream
  if (isStreamQueryGroup(group)) {
    return evaluateStreamQueryGroupInMemory(group, item);
  }

  const items: Array<{ condition: RuleCondition; result: boolean }> = [];

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
  rules: Rule[] | RuleGroup[],
  item: Record<string, unknown>,
  arrMeta?: ArrMetadata,
  seerrMeta?: SeerrMetadata
): boolean {
  if (rules.length === 0) return false;

  if (isRuleGroups(rules)) {
    const groups = rules as RuleGroup[];
    const results: Array<{ condition: RuleCondition; result: boolean }> = [];

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

  // Legacy flat rules: grouped by AND boundaries, within-group OR
  const flat = (rules as Rule[]).filter((r) => r.enabled !== false);
  if (flat.length === 0) return false;
  const buckets: Rule[][] = [[]];
  for (let i = 0; i < flat.length; i++) {
    buckets[buckets.length - 1].push(flat[i]);
    if (i < flat.length - 1 && flat[i].condition === "AND") {
      buckets.push([]);
    }
  }
  return buckets.every((bucket) =>
    bucket.some((rule) => evaluateRuleAgainstItem(rule, item, arrMeta, seerrMeta))
  );
}

export { hasArrRules, hasSeerrRules, hasStreamRules, hasExternalIdFieldRules, hasStreamQueryInMemoryRules };

/**
 * Evaluate rules at the series scope: aggregate ALL episodes into series
 * first, then evaluate rules against the aggregated series data.
 * This is the default for SERIES type rule sets.
 */
export async function evaluateSeriesScope(
  rules: Rule[] | RuleGroup[],
  serverIds: string[],
  arrData?: ArrDataMap,
  seerrData?: SeerrDataMap
) {
  // Defense-in-depth: refuse to evaluate if no active rules exist
  if (rules.length === 0 || !hasAnyActiveRules(rules)) return [];

  const needsStreams = hasStreamRules(rules);

  // Fetch ALL episodes across the user's SERIES libraries
  const allEpisodes = await prisma.mediaItem.findMany({
    where: {
      type: "SERIES",
      library: { mediaServerId: { in: serverIds } },
    },
    include: {
      externalIds: true,
      ...(needsStreams ? { streams: true } : {}),
      library: {
        select: {
          title: true,
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  // Group episodes by series (parentTitle + libraryId)
  const seriesMap = new Map<string, typeof allEpisodes>();
  for (const ep of allEpisodes) {
    const key = `${ep.libraryId}::${ep.parentTitle ?? ep.libraryId}`;
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
      memberIds: string[];
    }
  > = [];

  for (const [, episodes] of seriesMap) {
    // Sort by id for a stable representative across syncs (prevents false match churn)
    episodes.sort((a, b) => a.id.localeCompare(b.id));
    const representative = episodes[0];
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

    aggregated.push({
      ...representative,
      // Use series name as title so "title" rules match against the series
      title: representative.parentTitle ?? representative.title,
      // Use series-level summary instead of episode summary
      summary: representative.parentSummary ?? representative.summary,
      // Clear episode-specific fields — this is a series-level aggregate
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
      allStreams,
      memberIds: episodes.map((ep) => ep.id),
    });
  }

  // Evaluate rules in-memory against aggregated series records
  const externalIdSource = "TVDB";
  const matching = [];

  for (const series of aggregated) {
    // Serialize for in-memory evaluation (mirrors evaluateRules output format)
    const item: Record<string, unknown> = {
      ...series,
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
    };

    const extId = series.externalIds?.find(
      (e) => e.source === externalIdSource
    );
    const arrMeta = arrData && extId ? arrData[extId.externalId] : undefined;

    const seerrMeta = lookupSeerrMeta(series.externalIds ?? [], seerrData, "SERIES");

    if (evaluateAllRulesInMemory(rules, item, arrMeta, seerrMeta)) {
      matching.push(series);
    }
  }

  return matching.map((item) => ({
    ...item,
    fileSize: item.fileSize ?? null,
    matchedEpisodes: item.episodeCount,
    memberIds: item.memberIds,
    // Expose computed fields so getMatchedCriteriaForItems can evaluate
    // series-scope rules (these only exist on the enriched evaluation object,
    // not on the raw aggregated series record)
    latestEpisodeViewDate: item.latestEpisodeViewDate ?? null,
    availableEpisodeCount: item.episodeCount,
    watchedEpisodePercentage: item.episodeCount > 0
      ? (item.watchedEpisodeCount / item.episodeCount) * 100
      : 0,
    streams: item.allStreams ?? [],
  }));
}

/**
 * Evaluate rules at the artist scope: aggregate ALL tracks into artists
 * first, then evaluate rules against the aggregated artist data.
 * This is the default for MUSIC type rule sets.
 */
export async function evaluateMusicScope(
  rules: Rule[] | RuleGroup[],
  serverIds: string[],
  arrData?: ArrDataMap
) {
  // Defense-in-depth: refuse to evaluate if no active rules exist
  if (rules.length === 0 || !hasAnyActiveRules(rules)) return [];

  const needsStreams = hasStreamRules(rules);

  // Fetch ALL tracks across the user's MUSIC libraries
  const allTracks = await prisma.mediaItem.findMany({
    where: {
      type: "MUSIC",
      library: { mediaServerId: { in: serverIds } },
    },
    include: {
      externalIds: true,
      ...(needsStreams ? { streams: true } : {}),
      library: {
        select: {
          title: true,
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  // Group tracks by artist (parentTitle + libraryId)
  const artistMap = new Map<string, typeof allTracks>();
  for (const track of allTracks) {
    const key = `${track.libraryId}::${track.parentTitle ?? track.libraryId}`;
    const group = artistMap.get(key);
    if (group) {
      group.push(track);
    } else {
      artistMap.set(key, [track]);
    }
  }

  // Aggregate each artist into a single record for rule evaluation
  type TrackRow = (typeof allTracks)[0];
  const aggregated: Array<
    Omit<TrackRow, "fileSize"> & { trackCount: number; fileSize: string | null; allStreams?: unknown[]; memberIds: string[] }
  > = [];

  for (const [, tracks] of artistMap) {
    // Sort by id for a stable representative across syncs (prevents false match churn)
    tracks.sort((a, b) => a.id.localeCompare(b.id));
    const representative = tracks[0];
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

    aggregated.push({
      ...representative,
      // Use artist name as title so "title" rules match against the artist
      title: representative.parentTitle ?? representative.title,
      // Clear track-specific fields — this is an artist-level aggregate
      parentTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      playCount: totalPlays,
      fileSize: totalSize > BigInt(0) ? totalSize.toString() : null,
      lastPlayedAt: latestPlayed,
      addedAt: earliestAdded,
      trackCount: tracks.length,
      allStreams,
      memberIds: tracks.map((t) => t.id),
    });
  }

  // Evaluate rules in-memory against aggregated artist records
  const externalIdSource = "MUSICBRAINZ";
  const matching = [];

  for (const artist of aggregated) {
    const item: Record<string, unknown> = {
      ...artist,
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
    };

    const extId = artist.externalIds?.find(
      (e) => e.source === externalIdSource
    );
    const arrMeta = arrData && extId ? arrData[extId.externalId] : undefined;

    if (evaluateAllRulesInMemory(rules, item, arrMeta)) {
      matching.push(artist);
    }
  }

  return matching.map((item) => ({
    ...item,
    fileSize: item.fileSize ?? null,
    matchedEpisodes: item.trackCount,
    memberIds: item.memberIds,
    // Expose allStreams as streams so getMatchedCriteriaForItems can evaluate
    // stream-based rules against the aggregated artist record
    streams: item.allStreams ?? [],
  }));
}

export async function evaluateRules(
  rules: Rule[] | RuleGroup[],
  type: "MOVIE" | "SERIES" | "MUSIC",
  serverIds: string[],
  arrData?: ArrDataMap,
  seerrData?: SeerrDataMap
) {
  // Defense-in-depth: refuse to evaluate if no active rules exist
  if (!hasAnyActiveRules(rules)) return [];

  // Determine whether in-memory re-evaluation is needed BEFORE building WHERE,
  // because external fields dropped from OR branches can make the WHERE clause
  // incorrectly restrictive (see below).
  const hasExternal = (arrData && hasArrRules(rules)) || (seerrData && hasSeerrRules(rules));
  const needsExternalIds = !!hasExternal || hasExternalIdFieldRules(rules);
  const needsStreams = hasStreamRules(rules);
  const hasCrossSystem = hasCrossSystemFieldRules(rules);
  const needsInMemoryEval = hasWildcardRules(rules) || hasStreamCountRules(rules) || hasStreamQueryInMemoryRules(rules) || hasCrossSystem;
  const needsFullReeval = needsInMemoryEval || !!hasExternal;

  let andConditions: Prisma.MediaItemWhereInput[];

  // When needsFullReeval is true, use pre-filter-aware WHERE construction.
  // ruleToWhereClause() returns {} for external fields (Arr/Seerr), wildcards,
  // and stream counts. Silently dropping these from OR branches makes the DB
  // query MORE restrictive than the in-memory evaluation — items that should
  // match get excluded from Phase 1 and never reach Phase 2.
  // The pre-filter variant treats dropped rules as EXTERNAL_RULE and propagates
  // correctly through AND/OR: EXTERNAL_RULE OR X = EXTERNAL_RULE (broadens),
  // EXTERNAL_RULE AND X = X (safe). This keeps DB-expressible conditions for
  // performance while guaranteeing the Phase 1 result is a superset of Phase 2.
  if (needsFullReeval && isRuleGroups(rules)) {
    const combined = buildGroupConditionsPreFilter(rules as unknown as RuleGroup[]);
    andConditions = Object.keys(combined).length > 0 ? [combined] : [];
  } else if (isRuleGroups(rules)) {
    const combined = buildGroupConditions(rules);
    andConditions = Object.keys(combined).length > 0 ? [combined] : [];
  } else {
    andConditions = legacyRulesToConditions(rules);
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
    include: {
      ...(needsExternalIds ? { externalIds: true } : {}),
      ...(needsStreams ? { streams: true } : {}),
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
  if (needsFullReeval) {
    const arrIdSource = type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";

    // Batch-fetch cross-system data if needed
    let crossSystemData: Map<string, { serverCount: number; matchedRuleSets: string[]; hasPendingAction: boolean }> | undefined;
    if (hasCrossSystem) {
      crossSystemData = await fetchCrossSystemData(filteredItems.map((i) => i.id));
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
        externalIds,
        ...(crossData ?? {}),
      };
      return evaluateAllRulesInMemory(rules, serialized, itemArrMeta, itemSeerrMeta);
    });
  }

  return filteredItems.map((item) => ({
    ...item,
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
  T extends { id: string; title: string; parentTitle: string | null; libraryId: string; playCount: number; fileSize: string | null; lastPlayedAt?: string | Date | null; seasonNumber?: number | null; episodeNumber?: number | null }
>(items: T[]): (T & { matchedEpisodes: number; memberIds: string[] })[] {
  const groups = new Map<string, { representative: T; count: number; totalPlays: number; totalSize: bigint; latestPlayed: Date | null; memberIds: string[] }>();

  for (const item of items) {
    const key = `${item.libraryId}::${item.parentTitle ?? item.libraryId}`;
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
      if (item.id.localeCompare(existing.representative.id) < 0) {
        existing.representative = item;
      }
    }
  }

  return [...groups.values()].map(({ representative, count, totalPlays, totalSize, latestPlayed, memberIds }) => ({
    ...representative,
    // Use series name as title, clear episode-specific fields
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
