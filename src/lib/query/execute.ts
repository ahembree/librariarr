import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { QueryRule, QueryGroup, QueryDefinition, RuleCondition } from "./types";
import { STREAM_FIELDS, GENRE_FIELD, LABELS_FIELD, EXTERNAL_ID_FIELD, ARR_QUERY_FIELDS, SEERR_QUERY_FIELDS, isExternalQueryField, isCrossSystemQueryField, hasArrRules, hasSeerrRules, hasCrossSystemRules } from "./types";
import {
  isStreamQueryField, isStreamQueryGroup, isStreamQueryComputedField,
  streamQueryFieldToColumn, STREAM_TYPE_INT_MAP,
} from "@/lib/rules/types";
import type { StreamQueryField } from "@/lib/rules/types";
import { detectStreamAudioProfile, detectStreamDynamicRange } from "@/lib/rules/stream-detection";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { evaluateQueryArrRule } from "./arr-filter";
import { evaluateQuerySeerrRule } from "./seerr-filter";
import { fetchArrDataForQuery } from "./fetch-arr-data";
import { fetchSeerrDataForQuery } from "./fetch-seerr-data";
import type { ArrDataMap, ArrMetadata, SeerrDataMap, SeerrMetadata } from "@/lib/rules/engine";

const MB_IN_BYTES = 1024 * 1024;
const DURATION_MS_PER_MIN = 60_000;

/** Batch-fetch cross-system enrichment data for candidate items */
async function fetchCrossSystemData(
  itemIds: string[],
): Promise<Map<string, { serverCount: number; matchedRuleSets: string[]; hasPendingAction: boolean }>> {
  const result = new Map<string, { serverCount: number; matchedRuleSets: string[]; hasPendingAction: boolean }>();
  if (itemIds.length === 0) return result;

  for (const id of itemIds) {
    result.set(id, { serverCount: 1, matchedRuleSets: [], hasPendingAction: false });
  }

  // Server count via dedupKey
  const itemsWithDedup = await prisma.mediaItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, dedupKey: true },
  });
  const dedupKeys = itemsWithDedup.map((i) => i.dedupKey).filter(Boolean) as string[];
  if (dedupKeys.length > 0) {
    const uniqueKeys = [...new Set(dedupKeys)];
    const serverCounts = await prisma.mediaItem.groupBy({
      by: ["dedupKey"],
      where: { dedupKey: { in: uniqueKeys } },
      _count: { id: true },
    });
    const countMap = new Map(serverCounts.map((r) => [r.dedupKey, r._count.id]));
    for (const item of itemsWithDedup) {
      if (item.dedupKey) {
        const entry = result.get(item.id);
        if (entry) entry.serverCount = countMap.get(item.dedupKey) ?? 1;
      }
    }
  }

  // Matched rule sets
  const ruleMatches = await prisma.ruleMatch.findMany({
    where: { mediaItemId: { in: itemIds } },
    select: { mediaItemId: true, ruleSet: { select: { name: true } } },
  });
  for (const match of ruleMatches) {
    const entry = result.get(match.mediaItemId);
    if (entry && match.ruleSet.name && !entry.matchedRuleSets.includes(match.ruleSet.name)) {
      entry.matchedRuleSets.push(match.ruleSet.name);
    }
  }

  // Pending actions
  const pendingActions = await prisma.lifecycleAction.findMany({
    where: { mediaItemId: { in: itemIds, not: null }, status: "PENDING" },
    select: { mediaItemId: true },
    distinct: ["mediaItemId"],
  });
  for (const action of pendingActions) {
    if (!action.mediaItemId) continue;
    const entry = result.get(action.mediaItemId);
    if (entry) entry.hasPendingAction = true;
  }

  return result;
}

/** Convert a glob-style wildcard pattern to a RegExp */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "i");
}

function applyNegate(clause: Prisma.MediaItemWhereInput, negate?: boolean): Prisma.MediaItemWhereInput {
  if (!negate) return clause;
  return { NOT: clause };
}

/**
 * Convert a single query rule to a Prisma WHERE clause.
 */
function queryRuleToWhere(rule: QueryRule): Prisma.MediaItemWhereInput {
  const { field, operator, value, negate } = rule;

  // Skip external (arr/seerr) fields — handled as post-filters
  if (isExternalQueryField(field)) return {};

  // Skip stream query fields — handled at the group level via buildQueryStreamQueryClause
  if (isStreamQueryField(field)) return {};

  // Skip cross-system fields — enriched before Phase 2
  if (isCrossSystemQueryField(field)) return {};

  // Stream relation fields
  if (STREAM_FIELDS.has(field)) {
    return handleStreamField(field, operator, String(value), negate);
  }

  // Genre (JSON array)
  if (field === GENRE_FIELD) {
    return handleGenreField(operator, String(value), negate);
  }

  // Labels (JSON array — same handling as genre)
  if (field === LABELS_FIELD) {
    return handleGenreField(operator, String(value), negate, "labels");
  }

  // External ID presence
  if (field === EXTERNAL_ID_FIELD) {
    return handleExternalIdField(operator, String(value), negate);
  }

  // File size (user inputs MB, DB stores bytes as BigInt)
  if (field === "fileSize") {
    const bytesValue = BigInt(Math.round(Number(value) * MB_IN_BYTES));
    let clause: Prisma.MediaItemWhereInput;
    switch (operator) {
      case "greaterThan": clause = { fileSize: { gt: bytesValue } }; break;
      case "greaterThanOrEqual": clause = { fileSize: { gte: bytesValue } }; break;
      case "lessThan": clause = { fileSize: { lt: bytesValue } }; break;
      case "lessThanOrEqual": clause = { fileSize: { lte: bytesValue } }; break;
      case "equals": clause = { fileSize: bytesValue }; break;
      case "notEquals": clause = { fileSize: { not: bytesValue } }; break;
      case "between": { const [minStr, maxStr] = String(value).split(","); clause = { fileSize: { gte: BigInt(Math.round(Number(minStr) * MB_IN_BYTES)), lte: BigInt(Math.round(Number(maxStr) * MB_IN_BYTES)) } }; break; }
      case "isNull": clause = { fileSize: null }; break;
      case "isNotNull": clause = { fileSize: { not: null } }; break;
      default: return {};
    }
    return applyNegate(clause, negate);
  }

  // Duration (user inputs minutes, DB stores milliseconds)
  if (field === "duration") {
    const msValue = Number(value) * DURATION_MS_PER_MIN;
    let clause: Prisma.MediaItemWhereInput;
    switch (operator) {
      case "greaterThan": clause = { duration: { gt: msValue } }; break;
      case "greaterThanOrEqual": clause = { duration: { gte: msValue } }; break;
      case "lessThan": clause = { duration: { lt: msValue } }; break;
      case "lessThanOrEqual": clause = { duration: { lte: msValue } }; break;
      case "equals": clause = { duration: Math.round(msValue) }; break;
      case "notEquals": clause = { duration: { not: Math.round(msValue) } }; break;
      case "between": { const [minStr, maxStr] = String(value).split(","); clause = { duration: { gte: Number(minStr) * DURATION_MS_PER_MIN, lte: Number(maxStr) * DURATION_MS_PER_MIN } }; break; }
      case "isNull": clause = { duration: null }; break;
      case "isNotNull": clause = { duration: { not: null } }; break;
      default: return {};
    }
    return applyNegate(clause, negate);
  }

  // Boolean fields
  if (field === "isWatchlisted") {
    const boolVal = String(value).toLowerCase() === "true";
    let boolClause: Prisma.MediaItemWhereInput;
    switch (operator) {
      case "equals":
        boolClause = { isWatchlisted: boolVal };
        break;
      case "notEquals":
        boolClause = { isWatchlisted: !boolVal };
        break;
      default:
        return {};
    }
    return applyNegate(boolClause, negate);
  }

  // Date fields
  const dateFields = new Set(["lastPlayedAt", "addedAt", "originallyAvailableAt"]);
  if (dateFields.has(field)) {
    let clause: Prisma.MediaItemWhereInput;
    switch (operator) {
      case "before": clause = { [field]: { lt: new Date(String(value)) } }; break;
      case "after": clause = { [field]: { gt: new Date(String(value)) } }; break;
      case "inLastDays": {
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - Number(value));
        clause = { [field]: { gte: daysAgo } };
        break;
      }
      case "notInLastDays": {
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - Number(value));
        clause = { [field]: { lt: daysAgo } };
        break;
      }
      case "equals": {
        const dayStart = new Date(String(value));
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        clause = { [field]: { gte: dayStart, lt: dayEnd } };
        break;
      }
      case "notEquals": {
        const dayStart = new Date(String(value));
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        clause = { OR: [{ [field]: { lt: dayStart } }, { [field]: { gte: dayEnd } }] };
        break;
      }
      case "between": {
        const [fromStr, toStr] = String(value).split(",");
        const endDate = new Date(toStr);
        endDate.setDate(endDate.getDate() + 1);
        clause = { [field]: { gte: new Date(fromStr), lt: endDate } };
        break;
      }
      case "isNull": clause = { [field]: null }; break;
      case "isNotNull": clause = { [field]: { not: null } }; break;
      default: return {};
    }
    return applyNegate(clause, negate);
  }

  // Numeric fields
  const numericFields = new Set([
    "playCount", "videoBitrate", "audioChannels", "year",
    "videoBitDepth", "audioSamplingRate", "audioBitrate",
    "rating", "audienceRating", "ratingCount",
  ]);
  if (numericFields.has(field)) {
    const numValue = Number(value);
    let clause: Prisma.MediaItemWhereInput;
    switch (operator) {
      case "equals": clause = { [field]: numValue }; break;
      case "notEquals": clause = { [field]: { not: numValue } }; break;
      case "greaterThan": clause = { [field]: { gt: numValue } }; break;
      case "greaterThanOrEqual": clause = { [field]: { gte: numValue } }; break;
      case "lessThan": clause = { [field]: { lt: numValue } }; break;
      case "lessThanOrEqual": clause = { [field]: { lte: numValue } }; break;
      case "between": { const [minStr, maxStr] = String(value).split(","); clause = { [field]: { gte: Number(minStr), lte: Number(maxStr) } }; break; }
      case "isNull": clause = { [field]: null }; break;
      case "isNotNull": clause = { [field]: { not: null } }; break;
      default: return {};
    }
    return applyNegate(clause, negate);
  }

  // Text fields (default)
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
      clause = { [field]: { equals: String(value), mode: "insensitive" } };
      break;
    case "notEquals":
      clause = { [field]: { not: String(value), mode: "insensitive" } };
      break;
    case "contains": {
      const values = String(value).split("|").filter(Boolean);
      if (values.length > 1) {
        clause = { OR: values.map((v) => ({ [field]: { contains: v, mode: "insensitive" as const } })) };
      } else {
        clause = { [field]: { contains: String(value), mode: "insensitive" } };
      }
      break;
    }
    case "notContains": {
      const values = String(value).split("|").filter(Boolean);
      if (values.length > 1) {
        clause = { AND: values.map((v) => ({ NOT: { [field]: { contains: v, mode: "insensitive" as const } } })) };
      } else {
        clause = { NOT: { [field]: { contains: String(value), mode: "insensitive" } } };
      }
      break;
    }
    case "isNull":
      clause = { OR: [{ [field]: null }, { [field]: "" }] };
      break;
    case "isNotNull":
      clause = { AND: [{ [field]: { not: null } }, { NOT: { [field]: "" } }] };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
}

function handleStreamField(
  field: string,
  operator: string,
  value: string,
  negate?: boolean,
): Prisma.MediaItemWhereInput {
  // audioStreamCount / subtitleStreamCount — handled via raw SQL separately
  if (field === "audioStreamCount" || field === "subtitleStreamCount") {
    return {};
  }

  // Determine stream type and which column to query
  let streamType: number;
  let columnName: string;
  if (field === "audioLanguage") {
    streamType = 2;
    columnName = "language";
  } else if (field === "streamAudioCodec") {
    streamType = 2;
    columnName = "codec";
  } else {
    // subtitleLanguage
    streamType = 3;
    columnName = "language";
  }

  // For language fields, exclude streams with unknown/null/empty language
  const isLangField = columnName === "language";
  const knownLangFilter = isLangField
    ? { language: { not: null, notIn: ["", "Unknown"] } }
    : {};

  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
      clause = {
        streams: { some: { streamType, ...knownLangFilter, [columnName]: { equals: value, mode: "insensitive" } } },
      };
      break;
    case "notEquals":
      clause = {
        NOT: { streams: { some: { streamType, ...knownLangFilter, [columnName]: { equals: value, mode: "insensitive" } } } },
      };
      break;
    case "contains":
      clause = {
        streams: { some: { streamType, ...knownLangFilter, [columnName]: { contains: value, mode: "insensitive" } } },
      };
      break;
    case "notContains":
      clause = {
        NOT: { streams: { some: { streamType, ...knownLangFilter, [columnName]: { contains: value, mode: "insensitive" } } } },
      };
      break;
    case "isNull": {
      // "Is Empty" — no stream of this type has a known value
      const hasValueFilter = isLangField
        ? knownLangFilter
        : { [columnName]: { not: null } };
      clause = { NOT: { streams: { some: { streamType, ...hasValueFilter } } } };
      break;
    }
    case "isNotNull": {
      // "Is Not Empty" — at least one stream of this type has a known value
      const hasValueFilter = isLangField
        ? knownLangFilter
        : { [columnName]: { not: null } };
      clause = { streams: { some: { streamType, ...hasValueFilter } } };
      break;
    }
    default:
      return {};
  }
  return applyNegate(clause, negate);
}

function handleGenreField(
  operator: string,
  value: string,
  negate?: boolean,
  column: string = "genres",
): Prisma.MediaItemWhereInput {
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
    case "contains":
      clause = { [column]: { array_contains: value } };
      break;
    case "notContains":
      clause = { NOT: { [column]: { array_contains: value } } };
      break;
    case "isNull":
      clause = { [column]: { equals: Prisma.DbNull } };
      break;
    case "isNotNull":
      clause = { NOT: { [column]: { equals: Prisma.DbNull } } };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
}

function handleExternalIdField(
  operator: string,
  value: string,
  negate?: boolean,
): Prisma.MediaItemWhereInput {
  let clause: Prisma.MediaItemWhereInput;
  switch (operator) {
    case "equals":
    case "isNotNull":
      clause = { externalIds: { some: { source: value } } };
      break;
    case "notEquals":
    case "isNull":
      clause = { externalIds: { none: { source: value } } };
      break;
    default:
      return {};
  }
  return applyNegate(clause, negate);
}

/**
 * Build a Prisma WHERE clause for a stream query group.
 * Uses `streams: { some: { streamType, AND: [...] } }` so all conditions
 * apply to the SAME stream record (existential semantics).
 */
function buildQueryStreamQueryClause(group: QueryGroup): Prisma.MediaItemWhereInput | null {
  if (!group.streamQuery) return null;
  const streamTypeInt = STREAM_TYPE_INT_MAP[group.streamQuery.streamType as keyof typeof STREAM_TYPE_INT_MAP];
  const conditions: Prisma.MediaStreamWhereInput[] = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    const field = rule.field as StreamQueryField;
    if (isStreamQueryComputedField(field)) continue; // Phase 2 only
    if (rule.operator === "matchesWildcard" || rule.operator === "notMatchesWildcard") continue; // Phase 2

    const column = streamQueryFieldToColumn(field);
    if (!column) continue;

    const { operator, value, negate } = rule;
    let cond: Prisma.MediaStreamWhereInput | null = null;

    // Boolean fields
    if (field === "sqIsDefault" || field === "sqForced") {
      const boolVal = String(value).toLowerCase() === "true";
      switch (operator) {
        case "equals": cond = { [column]: boolVal }; break;
        case "notEquals": cond = { [column]: !boolVal }; break;
      }
    }
    // Numeric fields
    else if (["sqChannels", "sqBitrate", "sqBitDepth", "sqWidth", "sqHeight", "sqFrameRate", "sqSamplingRate"].includes(field)) {
      const numValue = Number(value);
      switch (operator) {
        case "equals": cond = { [column]: numValue }; break;
        case "notEquals": cond = { [column]: { not: numValue } }; break;
        case "greaterThan": cond = { [column]: { gt: numValue } }; break;
        case "greaterThanOrEqual": cond = { [column]: { gte: numValue } }; break;
        case "lessThan": cond = { [column]: { lt: numValue } }; break;
        case "lessThanOrEqual": cond = { [column]: { lte: numValue } }; break;
        case "between": { const [minStr, maxStr] = String(value).split(","); cond = { [column]: { gte: Number(minStr), lte: Number(maxStr) } }; break; }
        case "isNull": cond = { [column]: null }; break;
        case "isNotNull": cond = { [column]: { not: null } }; break;
      }
    }
    // Text fields
    else {
      const strValue = String(value);
      switch (operator) {
        case "equals": cond = { [column]: { equals: strValue, mode: "insensitive" } }; break;
        case "notEquals": cond = { [column]: { not: strValue, mode: "insensitive" } }; break;
        case "contains": cond = { [column]: { contains: strValue, mode: "insensitive" } }; break;
        case "notContains": cond = { NOT: { [column]: { contains: strValue, mode: "insensitive" } } }; break;
        case "isNull": cond = { [column]: null }; break;
        case "isNotNull": cond = { [column]: { not: null } }; break;
      }
    }

    if (cond) {
      conditions.push(negate ? { NOT: cond } : cond);
    }
  }

  if (conditions.length === 0) return null;

  const quantifier = group.streamQuery.quantifier ?? "any";
  const streamCondition = { streamType: streamTypeInt, AND: conditions };

  if (quantifier === "none") {
    return { streams: { none: streamCondition } };
  }
  if (quantifier === "all") {
    return { streams: { none: { streamType: streamTypeInt, NOT: { AND: conditions } } } };
  }
  return { streams: { some: streamCondition } };
}

/** Check if a stream query group needs in-memory evaluation (computed/wildcard rules) */
function streamQueryNeedsInMemory(group: QueryGroup): boolean {
  if (!group.streamQuery) return false;
  return group.rules.some((r) =>
    r.enabled !== false && (
      isStreamQueryComputedField(r.field) ||
      r.operator === "matchesWildcard" ||
      r.operator === "notMatchesWildcard"
    ),
  );
}

/** Check if any group tree contains stream query groups needing in-memory eval */
function hasStreamQueryInMemoryRules(groups: QueryGroup[]): boolean {
  for (const group of groups) {
    if (group.enabled === false) continue;
    if (isStreamQueryGroup(group) && streamQueryNeedsInMemory(group)) return true;
    if (group.groups?.length && hasStreamQueryInMemoryRules(group.groups)) return true;
  }
  return false;
}

/**
 * Recursively evaluate a QueryGroup into a Prisma WHERE clause.
 * Rules and sub-groups are combined using their individual `condition` fields.
 */
function evaluateQueryGroup(group: QueryGroup): Prisma.MediaItemWhereInput | null {
  if (group.enabled === false) return null;

  // Stream query groups: build stream-level clause
  if (isStreamQueryGroup(group)) {
    return buildQueryStreamQueryClause(group);
  }

  const items: Array<{ condition: RuleCondition; clause: Prisma.MediaItemWhereInput }> = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    const clause = queryRuleToWhere(rule);
    if (Object.keys(clause).length > 0) items.push({ condition: rule.condition, clause });
  }

  for (const sub of group.groups ?? []) {
    const subClause = evaluateQueryGroup(sub);
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

function buildQueryConditions(groups: QueryGroup[]): Prisma.MediaItemWhereInput {
  const groupClauses: Array<{ condition: "AND" | "OR"; where: Prisma.MediaItemWhereInput }> = [];

  for (const group of groups) {
    const where = evaluateQueryGroup(group);
    if (!where) continue;
    groupClauses.push({ condition: group.condition, where });
  }

  if (groupClauses.length === 0) return {};
  if (groupClauses.length === 1) return groupClauses[0].where;

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

/** Collect all stream count rules from the group tree */
function collectStreamCountRules(groups: QueryGroup[]): QueryRule[] {
  const rules: QueryRule[] = [];
  function traverse(group: QueryGroup) {
    if (group.enabled === false) return;
    for (const rule of group.rules) {
      if (rule.enabled === false) continue;
      if (rule.field === "audioStreamCount" || rule.field === "subtitleStreamCount") {
        rules.push(rule);
      }
    }
    for (const sub of group.groups ?? []) {
      traverse(sub);
    }
  }
  for (const g of groups) traverse(g);
  return rules;
}

/** Check if rules reference any wildcard operators on non-external fields */
function hasWildcardRules(groups: QueryGroup[]): boolean {
  for (const group of groups) {
    if (group.enabled === false) continue;
    if (group.rules.some((r) =>
      r.enabled !== false &&
      !isExternalQueryField(r.field) &&
      (r.operator === "matchesWildcard" || r.operator === "notMatchesWildcard")
    )) return true;
    if (group.groups?.length && hasWildcardRules(group.groups)) return true;
  }
  return false;
}

function opToSql(op: string): string {
  switch (op) {
    case "greaterThan": return ">";
    case "greaterThanOrEqual": return ">=";
    case "lessThan": return "<";
    case "lessThanOrEqual": return "<=";
    case "notEquals": return "!=";
    case "equals":
    default: return "=";
  }
}

function negateSqlOp(op: string): string {
  switch (op) {
    case ">": return "<=";
    case ">=": return "<";
    case "<": return ">=";
    case "<=": return ">";
    case "=": return "!=";
    default: return op;
  }
}

/**
 * Apply stream count conditions via raw SQL, returns matching media item IDs.
 */
async function getStreamCountFilterIds(rules: QueryRule[]): Promise<string[] | null> {
  if (rules.length === 0) return null;

  const havingClauses: string[] = [];
  const queryValues: number[] = [];
  let idx = 1;

  for (const rule of rules) {
    const streamType = rule.field === "audioStreamCount" ? 2 : 3;
    const countExprIsNull = `COUNT(*) FILTER (WHERE "streamType" = ${streamType})`;
    if (rule.operator === "isNull") {
      // isNull on stream count = 0 streams of this type
      const op = rule.negate ? "> 0" : "= 0";
      havingClauses.push(`${countExprIsNull} ${op}`);
      continue;
    }
    if (rule.operator === "isNotNull") {
      // isNotNull on stream count = at least 1 stream of this type
      const op = rule.negate ? "= 0" : "> 0";
      havingClauses.push(`${countExprIsNull} ${op}`);
      continue;
    }
    if (rule.operator === "between") {
      const [minStr, maxStr] = String(rule.value).split(",");
      const countExpr = `COUNT(*) FILTER (WHERE "streamType" = ${streamType})`;
      if (rule.negate) {
        havingClauses.push(`(${countExpr} < $${idx} OR ${countExpr} > $${idx + 1})`);
      } else {
        havingClauses.push(`${countExpr} >= $${idx} AND ${countExpr} <= $${idx + 1}`);
      }
      queryValues.push(Number(minStr), Number(maxStr));
      idx += 2;
    } else {
      const sqlOp = rule.negate ? negateSqlOp(opToSql(rule.operator)) : opToSql(rule.operator);
      havingClauses.push(
        `COUNT(*) FILTER (WHERE "streamType" = ${streamType}) ${sqlOp} $${idx}`
      );
      queryValues.push(Number(rule.value));
      idx++;
    }
  }

  const rows = await prisma.$queryRawUnsafe<{ mediaItemId: string }[]>(
    `SELECT "mediaItemId" FROM "MediaStream"
     GROUP BY "mediaItemId"
     HAVING ${havingClauses.join(" AND ")}`,
    ...queryValues,
  );

  return rows.map((r) => r.mediaItemId);
}

export interface QueryResult {
  items: Array<Record<string, unknown>>;
  pagination: {
    page: number;
    limit: number;
    hasMore: boolean;
    total: number;
  };
}

const ITEM_SELECT = {
  id: true,
  title: true,
  parentTitle: true,
  year: true,
  type: true,
  seasonNumber: true,
  episodeNumber: true,
  summary: true,
  resolution: true,
  dynamicRange: true,
  videoCodec: true,
  videoBitDepth: true,
  videoFrameRate: true,
  videoBitrate: true,
  aspectRatio: true,
  audioCodec: true,
  audioChannels: true,
  audioProfile: true,
  container: true,
  fileSize: true,
  duration: true,
  playCount: true,
  lastPlayedAt: true,
  addedAt: true,
  originallyAvailableAt: true,
  contentRating: true,
  rating: true,
  audienceRating: true,
  isWatchlisted: true,
  genres: true,
  studio: true,
  dedupKey: true,
  library: {
    select: {
      title: true,
      mediaServer: { select: { id: true, name: true, type: true } },
    },
  },
} as const;

/** Full select for in-memory evaluation — includes streams, labels, and externalIds */
const ITEM_SELECT_FULL = {
  ...ITEM_SELECT,
  labels: true,
  audioSamplingRate: true,
  audioBitrate: true,
  ratingCount: true,
  streams: {
    select: {
      streamType: true, language: true, languageCode: true, codec: true,
      profile: true, bitrate: true, isDefault: true, displayTitle: true,
      extendedDisplayTitle: true, channels: true, samplingRate: true,
      audioChannelLayout: true, bitDepth: true, width: true, height: true,
      frameRate: true, scanType: true, videoRangeType: true, forced: true,
      colorPrimaries: true, colorRange: true, chromaSubsampling: true,
    },
  },
  externalIds: { select: { source: true, externalId: true } },
};

/** Build the shared WHERE clause from a query definition and resolved server IDs */
function buildBaseWhere(
  definition: QueryDefinition,
  effectiveServerIds: string[],
): Prisma.MediaItemWhereInput {
  const { mediaTypes, groups } = definition;

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: effectiveServerIds } },
  };

  if (mediaTypes.length > 0) {
    where.type = { in: mediaTypes };
  }

  if (groups.length > 0) {
    const conditions = buildQueryConditions(groups);
    if (Object.keys(conditions).length > 0) {
      where.AND = [conditions];
    }
  }

  return where;
}

/** Add stream count filter IDs to a WHERE clause (mutates) */
async function applyStreamCountFilter(
  where: Prisma.MediaItemWhereInput,
  groups: QueryGroup[],
): Promise<void> {
  const streamCountRules = collectStreamCountRules(groups);
  const streamCountIds = await getStreamCountFilterIds(streamCountRules);
  if (streamCountIds !== null) {
    const andClauses: Prisma.MediaItemWhereInput[] = Array.isArray(where.AND)
      ? [...where.AND]
      : where.AND
        ? [where.AND as Prisma.MediaItemWhereInput]
        : [];
    andClauses.push({ id: { in: streamCountIds } });
    where.AND = andClauses;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeItem(item: any): Record<string, unknown> {
  return {
    ...item,
    fileSize: item.fileSize?.toString() ?? null,
    servers: [
      {
        serverId: item.library.mediaServer!.id,
        serverName: item.library.mediaServer!.name,
        serverType: item.library.mediaServer!.type,
      },
    ],
  };
}

/** Sort combined result items in memory */
function sortCombinedResults(
  items: Array<Record<string, unknown>>,
  sortBy: string,
  sortOrder: "asc" | "desc",
): void {
  const dir = sortOrder === "desc" ? -1 : 1;
  items.sort((a, b) => {
    const aVal = a[sortBy];
    const bVal = b[sortBy];
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1; // nulls last
    if (bVal == null) return -1;
    if (typeof aVal === "string" && typeof bVal === "string") {
      return aVal.localeCompare(bVal) * dir;
    }
    if (typeof aVal === "number" && typeof bVal === "number") {
      return (aVal - bVal) * dir;
    }
    return String(aVal).localeCompare(String(bVal)) * dir;
  });
}

interface SeriesGroupRow {
  title: string;
  id: string;
  matchedEpisodes: number;
  seasonCount: number;
  fileSize: string;
  lastPlayedAt: Date | null;
  addedAt: Date | null;
  year: number | null;
  playCount: number;
  serverId: string;
  serverName: string;
  serverType: string;
}

/**
 * Group matching SERIES episodes by show (parentTitle).
 * Returns one row per show with aggregate data.
 * If preFilteredIds is provided, uses those directly instead of querying.
 */
async function groupSeriesEpisodes(
  where: Prisma.MediaItemWhereInput,
  preFilteredIds?: string[],
): Promise<Array<Record<string, unknown>>> {
  let ids: string[];

  if (preFilteredIds) {
    ids = preFilteredIds;
  } else {
    const seriesWhere: Prisma.MediaItemWhereInput = {
      ...where,
      type: "SERIES",
      parentTitle: { not: null },
    };

    const matchingIds = await prisma.mediaItem.findMany({
      where: seriesWhere,
      select: { id: true },
    });

    if (matchingIds.length === 0) return [];
    ids = matchingIds.map((m) => m.id);
  }

  if (ids.length === 0) return [];

  // Step 2: Group by parentTitle via raw SQL
  const rows = await prisma.$queryRaw<SeriesGroupRow[]>`
    SELECT
      MIN(mi."parentTitle") as title,
      (array_agg(mi.id ORDER BY mi."seasonNumber" NULLS LAST, mi."episodeNumber" NULLS LAST))[1] as id,
      COUNT(*)::int as "matchedEpisodes",
      COUNT(DISTINCT mi."seasonNumber")::int as "seasonCount",
      COALESCE(SUM(mi."fileSize"), 0)::text as "fileSize",
      MAX(mi."lastPlayedAt") as "lastPlayedAt",
      MAX(mi."addedAt") as "addedAt",
      MIN(mi.year) FILTER (WHERE mi.year IS NOT NULL) as year,
      MAX(mi."playCount")::int as "playCount",
      (array_agg(l."mediaServerId" ORDER BY mi."seasonNumber" NULLS LAST, mi."episodeNumber" NULLS LAST))[1] as "serverId",
      (array_agg(ms.name ORDER BY mi."seasonNumber" NULLS LAST, mi."episodeNumber" NULLS LAST))[1] as "serverName",
      (array_agg(ms.type ORDER BY mi."seasonNumber" NULLS LAST, mi."episodeNumber" NULLS LAST))[1] as "serverType"
    FROM "MediaItem" mi
    JOIN "Library" l ON mi."libraryId" = l.id
    JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
    WHERE mi.id = ANY(${ids})
      AND mi."parentTitle" IS NOT NULL
    GROUP BY LOWER(TRIM(mi."parentTitle"))
  `;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    parentTitle: null,
    year: r.year,
    type: "SERIES",
    seasonNumber: null,
    episodeNumber: null,
    resolution: null,
    dynamicRange: null,
    videoCodec: null,
    videoBitDepth: null,
    videoFrameRate: null,
    videoBitrate: null,
    aspectRatio: null,
    audioCodec: null,
    audioChannels: null,
    audioProfile: null,
    container: null,
    fileSize: r.fileSize,
    duration: null,
    playCount: r.playCount,
    lastPlayedAt: r.lastPlayedAt?.toISOString() ?? null,
    addedAt: r.addedAt?.toISOString() ?? null,
    originallyAvailableAt: null,
    contentRating: null,
    rating: null,
    audienceRating: null,
    studio: null,
    dedupKey: null,
    matchedEpisodes: r.matchedEpisodes,
    seasonCount: r.seasonCount,
    servers: [
      {
        serverId: r.serverId,
        serverName: r.serverName,
        serverType: r.serverType,
      },
    ],
    library: null,
  }));
}

/**
 * Execute a query definition and return paginated results.
 */
export async function executeQuery(
  definition: QueryDefinition,
  userId: string,
  page: number = 1,
  limit: number = 50,
): Promise<QueryResult> {
  const { mediaTypes, serverIds: requestedServerIds, groups, sortBy, sortOrder } = definition;

  // Resolve server filter
  const sf = await resolveServerFilter(userId, null);
  if (!sf) {
    return { items: [], pagination: { page, limit, hasMore: false, total: 0 } };
  }

  const effectiveServerIds = requestedServerIds.length > 0
    ? sf.serverIds.filter((id) => requestedServerIds.includes(id))
    : sf.serverIds;

  if (effectiveServerIds.length === 0) {
    return { items: [], pagination: { page, limit, hasMore: false, total: 0 } };
  }

  // Build base WHERE (includes type filter + conditions)
  const where = buildBaseWhere(definition, effectiveServerIds);
  await applyStreamCountFilter(where, groups);

  // Fetch Arr data if query uses Arr rules and servers are selected
  const needsArr = hasArrRules(groups) && definition.arrServerIds &&
    (definition.arrServerIds.radarr || definition.arrServerIds.sonarr || definition.arrServerIds.lidarr);
  let arrDataByType: Record<string, ArrDataMap> | undefined;
  if (needsArr) {
    arrDataByType = await fetchArrDataForQuery(userId, definition.arrServerIds!, mediaTypes);
  }

  // Fetch Seerr data if query uses Seerr rules and instance is selected
  const needsSeerr = hasSeerrRules(groups) && definition.seerrInstanceId;
  let seerrDataByType: Record<string, SeerrDataMap> | undefined;
  if (needsSeerr) {
    seerrDataByType = await fetchSeerrDataForQuery(userId, definition.seerrInstanceId!, mediaTypes);
  }

  // Determine if we need unified in-memory evaluation
  const hasCrossSystem = hasCrossSystemRules(groups);
  const needsFullInMemoryEval = !!arrDataByType || !!seerrDataByType || hasWildcardRules(groups) || hasStreamQueryInMemoryRules(groups) || hasCrossSystem;

  // Check if we need to group series
  const seriesInScope = mediaTypes.length === 0 || mediaTypes.includes("SERIES");
  const groupSeries = seriesInScope && !definition.includeEpisodes;

  if (!groupSeries) {
    // Ungrouped path
    return executeUngrouped(where, groups, sortBy, sortOrder, page, limit, arrDataByType, seerrDataByType);
  }

  // Grouped series path: combine grouped shows with flat non-series items
  const flatTypes = mediaTypes.length === 0
    ? ["MOVIE", "MUSIC"] as const
    : mediaTypes.filter((t) => t !== "SERIES");
  const hasFlatTypes = flatTypes.length > 0;

  const selectToUse = needsFullInMemoryEval ? ITEM_SELECT_FULL : ITEM_SELECT;

  // Run queries in parallel
  const flatWhere: Prisma.MediaItemWhereInput = { ...where, type: { in: [...flatTypes] } };

  // For grouped series with external/wildcard filtering: use unified evaluation
  let groupedShowsPromise: Promise<Array<Record<string, unknown>>>;
  if (needsFullInMemoryEval) {
    groupedShowsPromise = filterAndGroupSeriesEpisodes(where, groups, arrDataByType, seerrDataByType);
  } else {
    groupedShowsPromise = groupSeriesEpisodes(where);
  }

  const [flatItems, groupedShows] = await Promise.all([
    hasFlatTypes
      ? prisma.mediaItem.findMany({ where: flatWhere, select: selectToUse })
      : Promise.resolve([]),
    groupedShowsPromise,
  ]);

  // Serialize flat items
  let serializedFlat = flatItems.map(serializeItem);

  // Unified in-memory evaluation for flat items (handles ALL rules with correct AND/OR logic)
  if (needsFullInMemoryEval) {
    let crossSystemData: Map<string, { serverCount: number; matchedRuleSets: string[]; hasPendingAction: boolean }> | undefined;
    if (hasCrossSystem) {
      crossSystemData = await fetchCrossSystemData(serializedFlat.map((i) => i.id as string));
    }
    serializedFlat = serializedFlat.filter((item) => {
      if (crossSystemData) {
        const crossData = crossSystemData.get(item.id as string);
        if (crossData) {
          item.serverCount = crossData.serverCount;
          item.matchedRuleSets = crossData.matchedRuleSets;
          item.hasPendingAction = crossData.hasPendingAction;
        }
      }
      const { arrMeta, seerrMeta } = lookupExternalMeta(item, arrDataByType, seerrDataByType);
      return evaluateAllQueryRulesInMemory(groups, item, arrMeta, seerrMeta);
    });
  }

  // Combine
  const combined: Array<Record<string, unknown>> = [...serializedFlat, ...groupedShows];
  sortCombinedResults(combined, sortBy, sortOrder);

  const total = combined.length;
  if (limit === 0) {
    return { items: combined, pagination: { page: 1, limit: 0, hasMore: false, total } };
  }
  const offset = (page - 1) * limit;
  const paged = combined.slice(offset, offset + limit);
  const hasMore = total > page * limit;

  return {
    items: paged,
    pagination: { page, limit, hasMore, total },
  };
}

/**
 * For grouped series with external filtering: find episode IDs, filter by Arr/Seerr, then group survivors.
 */
async function filterAndGroupSeriesEpisodes(
  where: Prisma.MediaItemWhereInput,
  groups: QueryGroup[],
  arrDataByType?: Record<string, ArrDataMap>,
  seerrDataByType?: Record<string, SeerrDataMap>,
): Promise<Array<Record<string, unknown>>> {
  const seriesWhere: Prisma.MediaItemWhereInput = {
    ...where,
    type: "SERIES",
    parentTitle: { not: null },
  };

  // Fetch full episode data for unified in-memory evaluation
  const episodes = await prisma.mediaItem.findMany({
    where: seriesWhere,
    select: ITEM_SELECT_FULL,
  });

  if (episodes.length === 0) return [];

  // Unified in-memory evaluation: evaluates ALL rules with correct AND/OR logic
  const survivingIds = episodes
    .filter((ep) => {
      const { arrMeta, seerrMeta } = lookupExternalMeta(
        ep as unknown as Record<string, unknown>, arrDataByType, seerrDataByType,
      );
      return evaluateAllQueryRulesInMemory(
        groups, ep as unknown as Record<string, unknown>, arrMeta, seerrMeta,
      );
    })
    .map((ep) => ep.id);

  if (survivingIds.length === 0) return [];

  return groupSeriesEpisodes(where, survivingIds);
}

/** Execute the ungrouped query path */
async function executeUngrouped(
  where: Prisma.MediaItemWhereInput,
  groups: QueryGroup[],
  sortBy: string,
  sortOrder: "asc" | "desc",
  page: number,
  limit: number,
  arrDataByType?: Record<string, ArrDataMap>,
  seerrDataByType?: Record<string, SeerrDataMap>,
): Promise<QueryResult> {
  // When any in-memory evaluation is needed (external rules, wildcards, stream query computed fields), fetch all items
  const hasCrossSystem = hasCrossSystemRules(groups);
  const needsFullInMemoryEval = !!arrDataByType || !!seerrDataByType || hasWildcardRules(groups) || hasStreamQueryInMemoryRules(groups) || hasCrossSystem;
  const useInMemoryPagination = needsFullInMemoryEval;
  const selectToUse = needsFullInMemoryEval ? ITEM_SELECT_FULL : ITEM_SELECT;

  let orderBy: Prisma.MediaItemOrderByWithRelationInput | Prisma.MediaItemOrderByWithRelationInput[];
  const order = sortOrder === "desc" ? "desc" as const : "asc" as const;
  if (sortBy === "title") {
    orderBy = [{ titleSort: { sort: order, nulls: "last" } }, { title: order }];
  } else {
    orderBy = { [sortBy]: order };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const findArgs: any = { where, orderBy, select: selectToUse };

  if (!useInMemoryPagination && limit > 0) {
    findArgs.skip = (page - 1) * limit;
    findArgs.take = limit;
  }

  const items = await prisma.mediaItem.findMany(findArgs);

  let filteredItems = items;

  if (needsFullInMemoryEval) {
    // Unified in-memory evaluation: evaluates ALL rules (standard + external + wildcards)
    // with correct AND/OR group logic
    let crossSystemData: Map<string, { serverCount: number; matchedRuleSets: string[]; hasPendingAction: boolean }> | undefined;
    if (hasCrossSystem) {
      crossSystemData = await fetchCrossSystemData(filteredItems.map((i: Record<string, unknown>) => i.id as string));
    }
    filteredItems = filteredItems.filter((item: Record<string, unknown>) => {
      if (crossSystemData) {
        const crossData = crossSystemData.get(item.id as string);
        if (crossData) {
          item.serverCount = crossData.serverCount;
          item.matchedRuleSets = crossData.matchedRuleSets;
          item.hasPendingAction = crossData.hasPendingAction;
        }
      }
      const { arrMeta, seerrMeta } = lookupExternalMeta(item, arrDataByType, seerrDataByType);
      return evaluateAllQueryRulesInMemory(groups, item, arrMeta, seerrMeta);
    });
  }

  const serializedItems = filteredItems.map(serializeItem);

  if (useInMemoryPagination) {
    // In-memory pagination after filtering
    const total = serializedItems.length;
    if (limit === 0) {
      return { items: serializedItems, pagination: { page: 1, limit: 0, hasMore: false, total } };
    }
    const offset = (page - 1) * limit;
    const paged = serializedItems.slice(offset, offset + limit);
    const hasMore = total > page * limit;
    return { items: paged, pagination: { page, limit, hasMore, total } };
  }

  // DB-level pagination (original path)
  const total = await prisma.mediaItem.count({ where });
  const hasMore = limit > 0 && total > page * limit;

  return {
    items: serializedItems,
    pagination: { page, limit, hasMore, total },
  };
}

// ---------------------------------------------------------------------------
// Unified in-memory evaluation for query builder
// ---------------------------------------------------------------------------

/** Compare two numbers using a query operator */
function compareNumeric(itemVal: number, operator: string, ruleVal: number): boolean {
  switch (operator) {
    case "equals": return itemVal === ruleVal;
    case "notEquals": return itemVal !== ruleVal;
    case "greaterThan": return itemVal > ruleVal;
    case "greaterThanOrEqual": return itemVal >= ruleVal;
    case "lessThan": return itemVal < ruleVal;
    case "lessThanOrEqual": return itemVal <= ruleVal;
    default: return true;
  }
}

/** Evaluate a stream field rule (audioLanguage, subtitleLanguage, streamAudioCodec) in memory */
function evaluateStreamRuleInMemory(
  field: string,
  operator: string,
  value: string,
  negate: boolean | undefined,
  item: Record<string, unknown>,
): boolean {
  const streams = (item.streams ?? []) as Array<{ streamType: number; language: string | null; codec: string | null }>;

  let streamType: number;
  let columnName: "language" | "codec";
  if (field === "audioLanguage") { streamType = 2; columnName = "language"; }
  else if (field === "streamAudioCodec") { streamType = 2; columnName = "codec"; }
  else { streamType = 3; columnName = "language"; }

  const isLangField = columnName === "language";
  const typeStreams = streams.filter(s => s.streamType === streamType);

  const isKnownValue = (val: string | null) =>
    val !== null && val !== "" && val !== "Unknown";

  const knownStreams = isLangField
    ? typeStreams.filter(s => isKnownValue(s[columnName]))
    : typeStreams.filter(s => s[columnName] !== null);

  let result: boolean;
  switch (operator) {
    case "equals":
      result = knownStreams.some(s => s[columnName]!.toLowerCase() === value.toLowerCase());
      break;
    case "notEquals":
      result = !knownStreams.some(s => s[columnName]!.toLowerCase() === value.toLowerCase());
      break;
    case "contains":
      result = knownStreams.some(s => s[columnName]!.toLowerCase().includes(value.toLowerCase()));
      break;
    case "notContains":
      result = !knownStreams.some(s => s[columnName]!.toLowerCase().includes(value.toLowerCase()));
      break;
    case "matchesWildcard": {
      const re = wildcardToRegex(value.toLowerCase());
      result = knownStreams.some(s => re.test(s[columnName]!.toLowerCase()));
      break;
    }
    case "notMatchesWildcard": {
      const re = wildcardToRegex(value.toLowerCase());
      result = !knownStreams.some(s => re.test(s[columnName]!.toLowerCase()));
      break;
    }
    case "isNull":
      result = knownStreams.length === 0;
      break;
    case "isNotNull":
      result = knownStreams.length > 0;
      break;
    default:
      result = true;
  }
  return negate ? !result : result;
}

/** Evaluate a stream count rule (audioStreamCount, subtitleStreamCount) in memory */
function evaluateStreamCountInMemory(
  field: string,
  operator: string,
  value: number,
  negate: boolean | undefined,
  item: Record<string, unknown>,
  rawValue?: string | number | boolean,
): boolean {
  const streams = (item.streams ?? []) as Array<{ streamType: number }>;
  const streamType = field === "audioStreamCount" ? 2 : 3;
  const count = streams.filter(s => s.streamType === streamType).length;
  let result: boolean;
  if (operator === "between") {
    const [minStr, maxStr] = String(rawValue ?? value).split(",");
    result = count >= Number(minStr) && count <= Number(maxStr);
  } else {
    result = compareNumeric(count, operator, value);
  }
  return negate ? !result : result;
}

/** Evaluate a JSON array field (genre, labels) in memory */
function evaluateArrayFieldInMemory(
  column: string,
  operator: string,
  value: string,
  negate: boolean | undefined,
  item: Record<string, unknown>,
): boolean {
  const arr = item[column] as string[] | null;
  let result: boolean;
  switch (operator) {
    case "equals":
    case "contains":
      result = arr !== null && arr.includes(value);
      break;
    case "notContains":
      result = arr === null || !arr.includes(value);
      break;
    case "isNull":
      result = arr === null || arr.length === 0;
      break;
    case "isNotNull":
      result = arr !== null && arr.length > 0;
      break;
    default:
      result = true;
  }
  return negate ? !result : result;
}

/** Evaluate an external ID presence rule in memory */
function evaluateExternalIdInMemory(
  operator: string,
  value: string,
  negate: boolean | undefined,
  item: Record<string, unknown>,
): boolean {
  const extIds = (item.externalIds ?? []) as Array<{ source: string }>;
  let result: boolean;
  switch (operator) {
    case "equals":
    case "isNotNull":
      result = extIds.some(e => e.source === value);
      break;
    case "notEquals":
    case "isNull":
      result = !extIds.some(e => e.source === value);
      break;
    default:
      result = true;
  }
  return negate ? !result : result;
}

/** Evaluate a single query rule against an in-memory item with full metadata */
function evaluateQueryRuleInMemory(
  rule: QueryRule,
  item: Record<string, unknown>,
  arrMeta: ArrMetadata | undefined,
  seerrMeta: SeerrMetadata | undefined,
): boolean {
  const { field, operator, value, negate } = rule;

  // Arr fields — delegate to existing evaluator
  if (ARR_QUERY_FIELDS.has(field)) {
    return evaluateQueryArrRule(rule, arrMeta);
  }
  // Seerr fields — delegate to existing evaluator
  if (SEERR_QUERY_FIELDS.has(field)) {
    return evaluateQuerySeerrRule(rule, seerrMeta);
  }

  // Cross-system fields — enriched by fetchCrossSystemData
  if (isCrossSystemQueryField(field)) {
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
        default: result = false;
      }
      return negate ? !result : result;
    }
    if (field === "matchedByRuleSet") {
      const matchedSets = (item.matchedRuleSets as string[]) ?? [];
      const strValue = String(value);
      let result: boolean;
      switch (operator) {
        case "equals": result = matchedSets.some((s) => s.toLowerCase() === strValue.toLowerCase()); break;
        case "notEquals": result = !matchedSets.some((s) => s.toLowerCase() === strValue.toLowerCase()); break;
        case "contains": result = matchedSets.some((s) => s.toLowerCase().includes(strValue.toLowerCase())); break;
        case "notContains": result = !matchedSets.some((s) => s.toLowerCase().includes(strValue.toLowerCase())); break;
        case "isNull": result = matchedSets.length === 0; break;
        case "isNotNull": result = matchedSets.length > 0; break;
        default: result = false;
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
        default: result = false;
      }
      return negate ? !result : result;
    }
    return false;
  }

  // Stream relation fields
  if (field === "audioLanguage" || field === "subtitleLanguage" || field === "streamAudioCodec") {
    return evaluateStreamRuleInMemory(field, operator, String(value), negate, item);
  }
  // Stream count fields
  if (field === "audioStreamCount" || field === "subtitleStreamCount") {
    return evaluateStreamCountInMemory(field, operator, Number(value), negate, item, value);
  }

  // Genre / Labels (JSON arrays)
  if (field === GENRE_FIELD || field === LABELS_FIELD) {
    const column = field === LABELS_FIELD ? "labels" : "genres";
    return evaluateArrayFieldInMemory(column, operator, String(value), negate, item);
  }

  // External ID presence
  if (field === EXTERNAL_ID_FIELD) {
    return evaluateExternalIdInMemory(operator, String(value), negate, item);
  }

  // File size (user inputs MB, DB stores bytes as BigInt)
  if (field === "fileSize") {
    const raw = item.fileSize;
    const itemBytes = raw != null ? Number(raw) : null;
    const userMB = Number(value);
    let result: boolean;
    if (operator === "isNull") { result = itemBytes === null || itemBytes === 0; }
    else if (operator === "isNotNull") { result = itemBytes !== null && itemBytes !== 0; }
    else if (itemBytes === null) { result = false; }
    else if (operator === "between") {
      const [minStr, maxStr] = String(value).split(",");
      const itemMB = itemBytes / MB_IN_BYTES;
      result = itemMB >= Number(minStr) && itemMB <= Number(maxStr);
    } else {
      const itemMB = itemBytes / MB_IN_BYTES;
      result = compareNumeric(itemMB, operator, userMB);
    }
    return negate ? !result : result;
  }

  // Duration (user inputs minutes, DB stores ms)
  if (field === "duration") {
    const itemMs = item.duration != null ? Number(item.duration) : null;
    let result: boolean;
    if (operator === "isNull") { result = itemMs === null; }
    else if (operator === "isNotNull") { result = itemMs !== null; }
    else if (itemMs === null) { result = false; }
    else if (operator === "between") {
      const [minStr, maxStr] = String(value).split(",");
      result = itemMs >= Number(minStr) * DURATION_MS_PER_MIN && itemMs <= Number(maxStr) * DURATION_MS_PER_MIN;
    } else {
      const userMs = Number(value) * DURATION_MS_PER_MIN;
      result = compareNumeric(itemMs, operator, userMs);
    }
    return negate ? !result : result;
  }

  // Boolean
  if (field === "isWatchlisted") {
    const boolVal = String(value).toLowerCase() === "true";
    let result: boolean;
    switch (operator) {
      case "equals": result = item[field] === boolVal; break;
      case "notEquals": result = item[field] !== boolVal; break;
      default: result = false;
    }
    return negate ? !result : result;
  }

  // Date fields
  const dateFields = new Set(["lastPlayedAt", "addedAt", "originallyAvailableAt"]);
  if (dateFields.has(field)) {
    const raw = item[field];
    const itemDate = raw ? new Date(String(raw)) : null;
    let result: boolean;
    if (operator === "isNull") {
      result = !itemDate || isNaN(itemDate.getTime());
    } else if (operator === "isNotNull") {
      result = !!itemDate && !isNaN(itemDate.getTime());
    } else if (!itemDate || isNaN(itemDate.getTime())) {
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
        default: result = false;
      }
    }
    return negate ? !result : result;
  }

  // Numeric fields
  const numericFields = new Set([
    "playCount", "videoBitrate", "audioChannels", "year",
    "videoBitDepth", "audioSamplingRate", "audioBitrate",
    "rating", "audienceRating", "ratingCount",
  ]);
  if (numericFields.has(field)) {
    const itemVal = item[field] != null ? Number(item[field]) : null;
    const numVal = Number(value);
    let result: boolean;
    if (operator === "isNull") { result = itemVal === null; }
    else if (operator === "isNotNull") { result = itemVal !== null; }
    else if (itemVal === null) { result = false; }
    else if (operator === "between") { const [minStr, maxStr] = String(value).split(","); result = itemVal >= Number(minStr) && itemVal <= Number(maxStr); }
    else { result = compareNumeric(itemVal, operator, numVal); }
    return negate ? !result : result;
  }

  // Text fields (default)
  const itemStr = item[field] != null ? String(item[field]) : null;
  let result: boolean;
  if (operator === "isNull") {
    result = itemStr === null || itemStr === "";
  } else if (operator === "isNotNull") {
    result = itemStr !== null && itemStr !== "";
  } else if (operator === "matchesWildcard") {
    if (itemStr === null) { result = false; }
    else {
      const re = wildcardToRegex(String(value).toLowerCase());
      result = re.test(itemStr.toLowerCase());
    }
  } else if (operator === "notMatchesWildcard") {
    if (itemStr === null) { result = true; }
    else {
      const re = wildcardToRegex(String(value).toLowerCase());
      result = !re.test(itemStr.toLowerCase());
    }
  } else if (itemStr === null) {
    result = false;
  } else {
    const strVal = String(value).toLowerCase();
    const lower = itemStr.toLowerCase();
    switch (operator) {
      case "equals": result = lower === strVal; break;
      case "notEquals": result = lower !== strVal; break;
      case "contains": {
        const values = strVal.split("|").filter(Boolean);
        result = values.some((v) => lower.includes(v));
        break;
      }
      case "notContains": {
        const values = strVal.split("|").filter(Boolean);
        result = !values.some((v) => lower.includes(v));
        break;
      }
      default: result = false;
    }
  }
  return negate ? !result : result;
}

/** Evaluate a single stream query rule against a single stream record */
function evaluateStreamQueryRuleAgainstStream(
  rule: QueryRule,
  stream: Record<string, unknown>,
): boolean {
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
      default: result = false;
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
      case "between": {
        if (actual == null) return negate ? true : false;
        const [minStr, maxStr] = String(value).split(",");
        result = actual >= Number(minStr) && actual <= Number(maxStr);
        break;
      }
      default: {
        if (actual == null) return negate ? true : false;
        result = compareNumeric(actual, operator, numValue);
      }
    }
    return negate ? !result : result;
  }

  // Text fields (including computed)
  const strActual = streamValue != null ? String(streamValue).toLowerCase() : "";
  const strValue = String(value).toLowerCase();

  let result: boolean;
  switch (operator) {
    case "isNull": result = streamValue == null || strActual === ""; break;
    case "isNotNull": result = streamValue != null && strActual !== ""; break;
    case "equals": result = strActual === strValue; break;
    case "notEquals": result = strActual !== strValue; break;
    case "contains": result = strActual.includes(strValue); break;
    case "notContains": result = !strActual.includes(strValue); break;
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
    default: result = false;
  }
  return negate ? !result : result;
}

/**
 * Evaluate a stream query group in memory: check if ANY stream of the
 * matching type satisfies ALL active rules (existential semantics).
 */
function evaluateStreamQueryGroupInMemory(
  group: QueryGroup,
  item: Record<string, unknown>,
): boolean {
  if (!group.streamQuery) return false;
  const streamTypeInt = STREAM_TYPE_INT_MAP[group.streamQuery.streamType as keyof typeof STREAM_TYPE_INT_MAP];
  const streams = (item.streams as Array<Record<string, unknown>>) ?? [];
  const matchingStreams = streams.filter((s) => s.streamType === streamTypeInt);

  const activeRules = group.rules.filter((r) => r.enabled !== false);
  if (activeRules.length === 0) return false;

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

/** Recursively evaluate a query group in memory */
function evaluateQueryGroupInMemory(
  group: QueryGroup,
  item: Record<string, unknown>,
  arrMeta: ArrMetadata | undefined,
  seerrMeta: SeerrMetadata | undefined,
): boolean | null {
  if (group.enabled === false) return null;

  // Stream query groups: evaluate per-stream
  if (isStreamQueryGroup(group)) {
    return evaluateStreamQueryGroupInMemory(group, item);
  }

  const items: Array<{ condition: RuleCondition; result: boolean }> = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    items.push({
      condition: rule.condition,
      result: evaluateQueryRuleInMemory(rule, item, arrMeta, seerrMeta),
    });
  }

  for (const sub of group.groups ?? []) {
    const subResult = evaluateQueryGroupInMemory(sub, item, arrMeta, seerrMeta);
    if (subResult !== null) {
      items.push({ condition: sub.condition, result: subResult });
    }
  }

  if (items.length === 0) return null;
  if (items.length === 1) return items[0].result;

  let combined = items[0].result;
  for (let i = 1; i < items.length; i++) {
    const { condition, result: r } = items[i];
    combined = condition === "OR" ? (combined || r) : (combined && r);
  }
  return combined;
}

/** Top-level in-memory evaluation of all query rule groups */
export function evaluateAllQueryRulesInMemory(
  groups: QueryGroup[],
  item: Record<string, unknown>,
  arrMeta: ArrMetadata | undefined,
  seerrMeta: SeerrMetadata | undefined,
): boolean {
  const results: Array<{ condition: RuleCondition; passed: boolean }> = [];

  for (const group of groups) {
    const result = evaluateQueryGroupInMemory(group, item, arrMeta, seerrMeta);
    if (result === null) continue;
    results.push({ condition: group.condition, passed: result });
  }

  if (results.length === 0) return true;

  let combined = results[0].passed;
  for (let i = 1; i < results.length; i++) {
    const { condition, passed } = results[i];
    combined = condition === "OR" ? (combined || passed) : (combined && passed);
  }
  return combined;
}

/** Look up Arr and Seerr metadata for an item from pre-fetched data maps */
function lookupExternalMeta(
  item: Record<string, unknown>,
  arrDataByType?: Record<string, ArrDataMap>,
  seerrDataByType?: Record<string, SeerrDataMap>,
): { arrMeta: ArrMetadata | undefined; seerrMeta: SeerrMetadata | undefined } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const externalIds = ((item as any).externalIds ?? []) as Array<{ source: string; externalId: string }>;
  const itemType = String(item.type ?? "");

  let arrMeta: ArrMetadata | undefined;
  if (arrDataByType) {
    const arrSource = itemType === "MOVIE" ? "TMDB" : itemType === "MUSIC" ? "MUSICBRAINZ" : "TVDB";
    const arrExtId = externalIds.find(e => e.source === arrSource);
    const arrData = arrDataByType[itemType];
    arrMeta = arrExtId && arrData ? arrData[arrExtId.externalId] : undefined;
  }

  let seerrMeta: SeerrMetadata | undefined;
  if (seerrDataByType) {
    const seerrSource = itemType === "MOVIE" ? "TMDB" : "TVDB";
    const seerrExtId = externalIds.find(e => e.source === seerrSource);
    const seerrData = seerrDataByType[itemType];
    seerrMeta = seerrExtId && seerrData ? seerrData[seerrExtId.externalId] : undefined;
  }

  return { arrMeta, seerrMeta };
}
