import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { QueryRule, QueryGroup, QueryDefinition, LifecycleRuleCondition } from "./types";
import { GENRE_FIELD, LABELS_FIELD, EXTERNAL_ID_FIELD, ARR_QUERY_FIELDS, SEERR_QUERY_FIELDS, isExternalQueryField, isCrossSystemQueryField, isSeriesAggregateField, hasArrRules, hasSeerrRules, hasCrossSystemRules, hasSeriesAggregateRules, hasWatchedByUserRules, hasResolutionRules, hasStreamCountRules } from "./types";
import {
  isStreamQueryField, isStreamQueryGroup, isStreamQueryComputedField,
  streamQueryFieldToColumn, STREAM_TYPE_INT_MAP,
} from "@/lib/rules/types";
import { normalizeResolutionLabel } from "@/lib/resolution";
import type { StreamQueryField } from "@/lib/rules/types";
import { detectStreamAudioProfile, detectStreamDynamicRange } from "@/lib/rules/stream-detection";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { evaluateQueryArrRule } from "./arr-filter";
import { evaluateQuerySeerrRule } from "./seerr-filter";
import { fetchArrDataForQuery } from "./fetch-arr-data";
import { fetchSeerrDataForQuery } from "./fetch-seerr-data";
import type { ProgressEmit, ProgressPhase } from "@/lib/progress/types";
import type { ArrDataMap, ArrMetadata, SeerrDataMap, SeerrMetadata } from "@/lib/rules/lifecycle-engine";
import { lookupSeerrMeta } from "@/lib/rules/lifecycle-engine";
import {
  MB_IN_BYTES,
  DURATION_MS_PER_MIN,
  wildcardToRegex,
  aggregateEpisodesIntoSeries,
  serializeSeriesAggregateForEval,
  type AggregableEpisode,
} from "@/lib/conditions";
import { isEnumerableField, isOperatorApplicable, isValueValidForRule } from "@/lib/conditions/helpers";
import {
  isUnconfiguredContainsRule,
  validateRulePreamble,
  FIELD_HANDLERS,
  textGenericHandler,
  UNSATISFIABLE_WHERE,
} from "@/lib/conditions/where-builder";
import { fetchCrossSystemData } from "@/lib/conditions/cross-system-data";
import { streamQueryNeedsInMemory } from "@/lib/conditions/stream-query-where";
import { buildGroupConditions, buildGroupConditionsPreFilter } from "@/lib/conditions/group-composition";
import { pushDownGroupNegation } from "@/lib/conditions/negation";
import { nullValueResult } from "@/lib/conditions/helpers";

/**
 * Convert a single query rule to a Prisma WHERE clause.
 */
function queryRuleToWhere(rule: QueryRule): Prisma.MediaItemWhereInput {
  const { field, operator, value, negate } = rule;

  // Safety preamble: unconfigured rule, inapplicable operator, malformed
  // value → UNSATISFIABLE_WHERE. Shared with the rule engine.
  const guarded = validateRulePreamble(field, operator, value);
  if (guarded) return guarded;

  // Skip external (arr/seerr) fields — handled as post-filters
  if (isExternalQueryField(field)) return {};

  // Stream query fields only make sense inside a stream-query group (whose
  // rules go through buildStreamQueryClause, never this dispatcher). A
  // misplaced one is a dead rule — never a dropped constraint.
  if (isStreamQueryField(field)) return UNSATISFIABLE_WHERE;

  // Skip cross-system fields — enriched before Phase 2
  if (isCrossSystemQueryField(field)) return {};

  // Skip series-aggregate fields — computed in dedicated series-scope path
  if (isSeriesAggregateField(field)) return {};

  // Stream count fields — always post-filtered in-memory
  if (field === "audioStreamCount" || field === "subtitleStreamCount") return {};

  // Field-specific WHERE-emitting handlers live in where-builder.ts and are
  // shared with the rule engine. The dispatcher above handles all the
  // query-engine-specific routing (cross-system, stream query, stream count)
  // before reaching this lookup; stream relation and hasExternalId are routed
  // via FIELD_HANDLERS.
  const handler = FIELD_HANDLERS[field];
  if (handler) return handler(operator, value, field, negate);

  // Text-generic fallback for unrecognized text fields.
  return textGenericHandler(operator, value, field, negate);
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
  ratingImage: true,
  audienceRating: true,
  audienceRatingImage: true,
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
  libraryId: true,
  parentSummary: true,
  // Condition fields that previously fell to `undefined` in Phase 2 — an
  // unselected column read as null diverged from Phase 1 (e.g.
  // `videoProfile notMatchesWildcard` matched every item).
  albumTitle: true,
  videoProfile: true,
  scanType: true,
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

/**
 * Build a full-select object, optionally including the `watchHistory` relation.
 * `watchHistory` is only meaningful when a `watchedByUser` rule is present;
 * joining it unconditionally costs O(plays) per query on large libraries.
 */
function buildItemSelectFull(opts: { includeWatchHistory: boolean }) {
  if (!opts.includeWatchHistory) return ITEM_SELECT_FULL;
  return {
    ...ITEM_SELECT_FULL,
    watchHistory: { select: { serverUsername: true } } as const,
  };
}

/** Build the shared WHERE clause from a query definition and resolved server IDs */
function buildBaseWhere(
  definition: QueryDefinition,
  effectiveServerIds: string[],
  usePreFilter: boolean,
): Prisma.MediaItemWhereInput {
  const { mediaTypes, groups } = definition;

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: effectiveServerIds } },
  };

  if (mediaTypes.length > 0) {
    where.type = { in: mediaTypes };
  }

  if (groups.length > 0) {
    // When Phase 2 will run, the rule WHERE is only a pre-filter and must be
    // a SUPERSET of the in-memory result: dropped {} clauses in OR position
    // (arr/seerr/wildcard/stream-count/resolution rules) would otherwise
    // exclude rows Phase 2 should see (EXTERNAL-aware composition).
    const conditions = usePreFilter
      ? buildGroupConditionsPreFilter(groups, queryRuleToWhere)
      : buildGroupConditions(groups, queryRuleToWhere);
    if (Object.keys(conditions).length > 0) {
      where.AND = [conditions];
    }
  }

  return where;
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
  summary: string | null;
  genres: unknown;
  studio: string | null;
  contentRating: string | null;
  rating: number | null;
  ratingImage: string | null;
  audienceRating: number | null;
  audienceRatingImage: string | null;
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
      (array_agg(ms.type ORDER BY mi."seasonNumber" NULLS LAST, mi."episodeNumber" NULLS LAST))[1] as "serverType",
      COALESCE(
        (array_agg(mi."parentSummary" ORDER BY mi."seasonNumber", mi."episodeNumber") FILTER (WHERE mi."parentSummary" IS NOT NULL))[1],
        (array_agg(mi."summary" ORDER BY mi."seasonNumber", mi."episodeNumber") FILTER (WHERE mi."summary" IS NOT NULL))[1]
      ) as summary,
      (array_agg(mi."genres" ORDER BY mi."seasonNumber", mi."episodeNumber") FILTER (WHERE mi."genres" IS NOT NULL))[1] as genres,
      (array_agg(mi."studio" ORDER BY mi."seasonNumber", mi."episodeNumber") FILTER (WHERE mi."studio" IS NOT NULL))[1] as studio,
      (array_agg(mi."contentRating" ORDER BY mi."seasonNumber", mi."episodeNumber") FILTER (WHERE mi."contentRating" IS NOT NULL))[1] as "contentRating",
      (array_agg(mi."rating" ORDER BY mi."seasonNumber", mi."episodeNumber") FILTER (WHERE mi."rating" IS NOT NULL))[1] as rating,
      (array_agg(mi."ratingImage" ORDER BY mi."seasonNumber", mi."episodeNumber") FILTER (WHERE mi."ratingImage" IS NOT NULL))[1] as "ratingImage",
      (array_agg(mi."audienceRating" ORDER BY mi."seasonNumber", mi."episodeNumber") FILTER (WHERE mi."audienceRating" IS NOT NULL))[1] as "audienceRating",
      (array_agg(mi."audienceRatingImage" ORDER BY mi."seasonNumber", mi."episodeNumber") FILTER (WHERE mi."audienceRatingImage" IS NOT NULL))[1] as "audienceRatingImage"
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
    contentRating: r.contentRating,
    rating: r.rating,
    ratingImage: r.ratingImage,
    audienceRating: r.audienceRating,
    audienceRatingImage: r.audienceRatingImage,
    summary: r.summary,
    genres: r.genres as string[] | null,
    studio: r.studio,
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
// How often (in items) the in-memory evaluation loop reports sub-progress.
// Coarse enough to avoid flooding the stream, fine enough to feel live.
const EVAL_PROGRESS_INTERVAL = 250;

export async function executeQuery(
  definition: QueryDefinition,
  userId: string,
  page: number = 1,
  limit: number = 50,
  onProgress?: ProgressEmit,
): Promise<QueryResult> {
  const { mediaTypes, serverIds: requestedServerIds, groups, sortBy, sortOrder } = definition;

  // Announce the phases this run will execute so the UI can render a stepper.
  const willFetchArr = !!(hasArrRules(groups) && definition.arrServerIds &&
    (definition.arrServerIds.radarr || definition.arrServerIds.sonarr || definition.arrServerIds.lidarr));
  const willFetchSeerr = !!(hasSeerrRules(groups) && definition.seerrInstanceId);
  const willEvaluate = willFetchArr || willFetchSeerr || hasWildcardRules(groups) ||
    hasStreamQueryInMemoryRules(groups) || hasCrossSystemRules(groups) || hasArrRules(groups) ||
    hasSeerrRules(groups) || hasSeriesAggregateRules(groups) || hasResolutionRules(groups) ||
    hasStreamCountRules(groups);
  const phases: ProgressPhase[] = [
    { key: "servers", label: "Resolving servers" },
    ...(willFetchArr ? [{ key: "arr", label: "Fetching Arr metadata" }] : []),
    ...(willFetchSeerr ? [{ key: "seerr", label: "Fetching Seerr metadata" }] : []),
    { key: "query", label: "Querying library" },
    ...(willEvaluate ? [{ key: "evaluate", label: "Evaluating rules" }] : []),
    { key: "finalize", label: "Finalizing" },
  ];
  onProgress?.({ type: "plan", phases });

  // Resolve server filter
  onProgress?.({ type: "phase", key: "servers" });
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

  // Fetch Arr data if query uses Arr rules and servers are selected
  const needsArr = hasArrRules(groups) && definition.arrServerIds &&
    (definition.arrServerIds.radarr || definition.arrServerIds.sonarr || definition.arrServerIds.lidarr);
  // Adapts a phase key into a 0..1 fraction reporter that emits phase events,
  // so the fetchers can drive determinate sub-progress within their phase.
  const phaseReporter = (key: string) =>
    onProgress ? (f: number) => onProgress({ type: "phase", key, fraction: f }) : undefined;

  let arrDataByType: Record<string, ArrDataMap> | undefined;
  if (needsArr) {
    onProgress?.({ type: "phase", key: "arr", fraction: 0 });
    arrDataByType = await fetchArrDataForQuery(userId, definition.arrServerIds!, mediaTypes, phaseReporter("arr"));
  }

  // Fetch Seerr data if query uses Seerr rules and instance is selected
  const needsSeerr = hasSeerrRules(groups) && definition.seerrInstanceId;
  let seerrDataByType: Record<string, SeerrDataMap> | undefined;
  if (needsSeerr) {
    onProgress?.({ type: "phase", key: "seerr", fraction: 0 });
    seerrDataByType = await fetchSeerrDataForQuery(userId, definition.seerrInstanceId!, mediaTypes, phaseReporter("seerr"));
  }

  // Determine if we need unified in-memory evaluation
  const hasCrossSystem = hasCrossSystemRules(groups);
  const needsFullInMemoryEval = !!arrDataByType || !!seerrDataByType || hasWildcardRules(groups) || hasStreamQueryInMemoryRules(groups) || hasCrossSystem || hasArrRules(groups) || hasSeerrRules(groups) || hasSeriesAggregateRules(groups) || hasResolutionRules(groups) || hasStreamCountRules(groups);

  // Build base WHERE (includes type filter + conditions). Built AFTER the
  // in-memory decision so pre-filter (superset) composition applies when
  // Phase 2 runs.
  const where = buildBaseWhere(definition, effectiveServerIds, needsFullInMemoryEval);

  // Check if we need to group series
  const seriesInScope = mediaTypes.length === 0 || mediaTypes.includes("SERIES");
  const groupSeries = seriesInScope && !definition.includeEpisodes;

  if (!groupSeries) {
    // Ungrouped path
    return executeUngrouped(where, groups, sortBy, sortOrder, page, limit, arrDataByType, seerrDataByType, onProgress);
  }

  onProgress?.({ type: "phase", key: "query" });

  // Grouped series path: combine grouped shows with flat non-series items
  const flatTypes = mediaTypes.length === 0
    ? ["MOVIE", "MUSIC"] as const
    : mediaTypes.filter((t) => t !== "SERIES");
  const hasFlatTypes = flatTypes.length > 0;

  const needsWatchHistory = hasWatchedByUserRules(groups);
  const selectToUse = needsFullInMemoryEval
    ? buildItemSelectFull({ includeWatchHistory: needsWatchHistory })
    : ITEM_SELECT;

  // Run queries in parallel
  const flatWhere: Prisma.MediaItemWhereInput = { ...where, type: { in: [...flatTypes] } };

  // For grouped series with external/wildcard filtering: use unified evaluation
  // For series-aggregate rules: aggregate episodes into series first, then evaluate
  let groupedShowsPromise: Promise<Array<Record<string, unknown>>>;
  if (hasSeriesAggregateRules(groups)) {
    groupedShowsPromise = aggregateSeriesAndFilter(effectiveServerIds, groups, arrDataByType, seerrDataByType);
  } else if (needsFullInMemoryEval) {
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
    onProgress?.({ type: "phase", key: "evaluate", fraction: 0 });
    let crossSystemData: Map<string, { serverCount: number; matchedRuleSets: string[]; hasPendingAction: boolean }> | undefined;
    if (hasCrossSystem) {
      crossSystemData = await fetchCrossSystemData(serializedFlat.map((i) => i.id as string));
    }
    const flatTotal = serializedFlat.length;
    let evaluated = 0;
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
      const keep = evaluateAllQueryRulesInMemory(groups, item, arrMeta, seerrMeta);
      if (onProgress && ++evaluated % EVAL_PROGRESS_INTERVAL === 0) {
        onProgress({ type: "phase", key: "evaluate", fraction: evaluated / flatTotal });
      }
      return keep;
    });
  }

  onProgress?.({ type: "phase", key: "finalize" });

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
 * For grouped series queries that reference series-aggregate fields
 * (`watchedEpisodePercentage`, `availableEpisodeCount`, etc.): fetch ALL
 * episodes for the relevant SERIES libraries (with NO rule-level WHERE),
 * aggregate into one record per series, then evaluate every rule against
 * the aggregate. This matches the rule engine's `evaluateSeriesScope`
 * semantics — aggregates must be computed over every episode of a series,
 * not over the subset that happens to satisfy other rules, otherwise
 * counts and percentages are skewed.
 *
 * Episode-level fields (year, fileSize, etc.) are evaluated against the
 * representative episode's value via the aggregated record.
 */
async function aggregateSeriesAndFilter(
  effectiveServerIds: string[],
  groups: QueryGroup[],
  arrDataByType?: Record<string, ArrDataMap>,
  seerrDataByType?: Record<string, SeerrDataMap>,
): Promise<Array<Record<string, unknown>>> {
  const seriesWhere: Prisma.MediaItemWhereInput = {
    type: "SERIES",
    parentTitle: { not: null },
    library: { mediaServerId: { in: effectiveServerIds } },
  };

  const episodes = await prisma.mediaItem.findMany({
    where: seriesWhere,
    select: buildItemSelectFull({ includeWatchHistory: hasWatchedByUserRules(groups) }),
  });

  if (episodes.length === 0) return [];

  const aggregates = aggregateEpisodesIntoSeries(
    episodes as unknown as AggregableEpisode[],
    { includeStreams: true },
  );

  const survivingIds: string[] = [];
  for (const series of aggregates) {
    const item = serializeSeriesAggregateForEval(series);
    const { arrMeta, seerrMeta } = lookupExternalMeta(
      item, arrDataByType, seerrDataByType,
    );
    if (evaluateAllQueryRulesInMemory(groups, item, arrMeta, seerrMeta)) {
      survivingIds.push(...series.memberIds);
    }
  }

  if (survivingIds.length === 0) return [];

  return groupSeriesEpisodes(seriesWhere, survivingIds);
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
    select: buildItemSelectFull({ includeWatchHistory: hasWatchedByUserRules(groups) }),
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
  onProgress?: ProgressEmit,
): Promise<QueryResult> {
  // When any in-memory evaluation is needed (external rules, wildcards, stream query computed fields), fetch all items
  const hasCrossSystem = hasCrossSystemRules(groups);
  const needsFullInMemoryEval = !!arrDataByType || !!seerrDataByType || hasWildcardRules(groups) || hasStreamQueryInMemoryRules(groups) || hasCrossSystem || hasArrRules(groups) || hasSeerrRules(groups) || hasSeriesAggregateRules(groups) || hasResolutionRules(groups) || hasStreamCountRules(groups);
  const useInMemoryPagination = needsFullInMemoryEval;
  const selectToUse = needsFullInMemoryEval
    ? buildItemSelectFull({ includeWatchHistory: hasWatchedByUserRules(groups) })
    : ITEM_SELECT;

  let orderBy: Prisma.MediaItemOrderByWithRelationInput | Prisma.MediaItemOrderByWithRelationInput[];
  const order = sortOrder === "desc" ? "desc" as const : "asc" as const;
  // Whitelist: an unknown column in orderBy is a Prisma validation error
  // (HTTP 500) — fall back to title for anything unrecognized.
  const SORTABLE = new Set([
    "title", "year", "rating", "audienceRating", "fileSize", "playCount",
    "lastPlayedAt", "addedAt", "duration", "resolution", "createdAt",
  ]);
  const sortField = SORTABLE.has(sortBy) ? sortBy : "title";
  if (sortField === "title") {
    orderBy = [{ titleSort: { sort: order, nulls: "last" } }, { title: order }];
  } else {
    orderBy = { [sortField]: order };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const findArgs: any = { where, orderBy, select: selectToUse };

  if (!useInMemoryPagination && limit > 0) {
    findArgs.skip = (page - 1) * limit;
    findArgs.take = limit;
  }

  onProgress?.({ type: "phase", key: "query" });
  const items = await prisma.mediaItem.findMany(findArgs);

  let filteredItems = items;

  if (needsFullInMemoryEval) {
    // Unified in-memory evaluation: evaluates ALL rules (standard + external + wildcards)
    // with correct AND/OR group logic
    onProgress?.({ type: "phase", key: "evaluate", fraction: 0 });
    let crossSystemData: Map<string, { serverCount: number; matchedRuleSets: string[]; hasPendingAction: boolean }> | undefined;
    if (hasCrossSystem) {
      crossSystemData = await fetchCrossSystemData(filteredItems.map((i: Record<string, unknown>) => i.id as string));
    }
    const evalTotal = filteredItems.length;
    let evaluated = 0;
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
      const keep = evaluateAllQueryRulesInMemory(groups, item, arrMeta, seerrMeta);
      if (onProgress && ++evaluated % EVAL_PROGRESS_INTERVAL === 0) {
        onProgress({ type: "phase", key: "evaluate", fraction: evaluated / evalTotal });
      }
      return keep;
    });
  }

  onProgress?.({ type: "phase", key: "finalize" });
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
    // Unknown operator → match nothing; a vacuous `true` here let negate
    // and quantifier logic sweep the library.
    default: return false;
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
    val !== null && val !== "" && val.toLowerCase() !== "unknown";

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
    case "contains": {
      // Enumerable multi-select — exact list membership against stream values.
      const parts = value.toLowerCase().split("|").filter(Boolean);
      result = parts.some(v => knownStreams.some(s => s[columnName]!.toLowerCase() === v));
      break;
    }
    case "notContains": {
      const parts = value.toLowerCase().split("|").filter(Boolean);
      result = !parts.some(v => knownStreams.some(s => s[columnName]!.toLowerCase() === v));
      break;
    }
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
      // Unknown operator → match nothing (bypass negate), never fail open
      return false;
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
  // Computed counts are never NULL — "is empty" reads as "has none".
  if (operator === "isNull") { result = count === 0; }
  else if (operator === "isNotNull") { result = count > 0; }
  else if (operator === "between") {
    const [minStr, maxStr] = String(rawValue ?? value).split(",");
    result = count >= Number(minStr) && count <= Number(maxStr);
  } else {
    result = compareNumeric(count, operator, value);
  }
  return negate ? !result : result;
}

/** Evaluate a JSON array field (genre, labels) in memory. Enumerable
 * multi-select: `contains` with pipe-separated values is list membership. */
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
      result = arr !== null && arr.includes(value);
      break;
    case "notEquals":
      // NULL array matches notEquals (Phase 1 unions Prisma.DbNull)
      result = arr === null || !arr.includes(value);
      break;
    case "contains": {
      const parts = value.split("|").filter(Boolean);
      const matchValues = parts.length > 0 ? parts : [value];
      result = arr !== null && matchValues.some((v) => arr.includes(v));
      break;
    }
    case "notContains": {
      const parts = value.split("|").filter(Boolean);
      const matchValues = parts.length > 0 ? parts : [value];
      result = arr === null || !matchValues.some((v) => arr.includes(v));
      break;
    }
    case "matchesWildcard": {
      const re = wildcardToRegex(value.toLowerCase());
      result = arr !== null && arr.some((v) => re.test(String(v).toLowerCase()));
      break;
    }
    case "notMatchesWildcard": {
      const re = wildcardToRegex(value.toLowerCase());
      result = arr === null || !arr.some((v) => re.test(String(v).toLowerCase()));
      break;
    }
    case "isNull":
      result = arr === null || arr.length === 0;
      break;
    case "isNotNull":
      result = arr !== null && arr.length > 0;
      break;
    default:
      // Unknown operator → match nothing (bypass negate), never fail open
      return false;
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
  const sources = value.split("|").map((v) => v.trim()).filter(Boolean);
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
    case "contains":
      result = extIds.some(e => sources.includes(e.source));
      break;
    case "notContains":
      result = !extIds.some(e => sources.includes(e.source));
      break;
    case "matchesWildcard": {
      const re = wildcardToRegex(value.toLowerCase());
      result = extIds.some(e => re.test(e.source.toLowerCase()));
      break;
    }
    case "notMatchesWildcard": {
      const re = wildcardToRegex(value.toLowerCase());
      result = !extIds.some(e => re.test(e.source.toLowerCase()));
      break;
    }
    default:
      // Unknown operator → match nothing (bypass negate), never the
      // fail-open `true` this previously returned.
      return false;
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
  // Safety: unconfigured contains/notContains matches nothing (ignoring negate).
  // Mirrors `queryRuleToWhere`'s UNSATISFIABLE_WHERE so Phase 1 and Phase 2 agree.
  if (isUnconfiguredContainsRule(rule.operator, rule.value)) return false;
  // Safety: unknown operator or wrong-type combo → match nothing (bypass negate).
  if (!isOperatorApplicable(rule.operator, rule.field)) return false;
  // Safety: malformed value → match nothing.
  if (!isValueValidForRule(rule.operator, rule.value, rule.field)) return false;

  const { field, operator, value, negate } = rule;

  // Misplaced stream-query field → dead rule (stream-query groups evaluate
  // through evaluateStreamQueryGroupInMemory, not here).
  if (isStreamQueryField(field)) return false;


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
    if (operator === "isNull") { result = itemBytes === null; }
    else if (operator === "isNotNull") { result = itemBytes !== null; }
    // NULL semantics mirror the Phase 1 clause shapes — see nullValueResult
    else if (itemBytes === null) { result = nullValueResult(operator); }
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
    else if (itemMs === null) { result = nullValueResult(operator); }
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
    // Non-nullable Boolean tautology — mirrors Phase 1 MATCH_ALL/UNSATISFIABLE.
    if (operator === "isNotNull") return negate ? false : true;
    if (operator === "isNull") return negate ? true : false;
    const boolVal = String(value).toLowerCase() === "true";
    let result: boolean;
    switch (operator) {
      case "equals": result = item[field] === boolVal; break;
      case "notEquals": result = item[field] !== boolVal; break;
      default: return false;
    }
    return negate ? !result : result;
  }

  // Watched By User — series aggregates flatten episode history into
  // `watchedByUsers: string[]`; individual items expose `watchHistory` directly.
  if (field === "watchedByUser") {
    const aggregated = Array.isArray(item.watchedByUsers)
      ? (item.watchedByUsers as string[]).map((u) => u.toLowerCase())
      : null;
    const users = aggregated ?? (
      Array.isArray(item.watchHistory)
        ? (item.watchHistory as Array<{ serverUsername: string | null }>)
            .map((h) => (h.serverUsername ?? "").toLowerCase())
            .filter(Boolean)
        : []
    );
    const strVal = String(value).toLowerCase();
    let result: boolean;
    switch (operator) {
      case "equals":
        result = users.some((u) => u === strVal);
        break;
      case "notEquals":
        result = !users.some((u) => u === strVal);
        break;
      case "contains": {
        const values = strVal.split("|").filter(Boolean);
        result = values.some((v) => users.some((u) => u === v));
        break;
      }
      case "notContains": {
        const values = strVal.split("|").filter(Boolean);
        result = !values.some((v) => users.some((u) => u === v));
        break;
      }
      case "matchesWildcard": {
        const re = wildcardToRegex(strVal);
        result = users.some((u) => re.test(u));
        break;
      }
      case "notMatchesWildcard": {
        const re = wildcardToRegex(strVal);
        result = !users.some((u) => re.test(u));
        break;
      }
      case "isNull":
        result = users.length === 0;
        break;
      case "isNotNull":
        result = users.length > 0;
        break;
      default:
        return false;
    }
    return negate ? !result : result;
  }

  // Date fields
  const dateFields = new Set(["lastPlayedAt", "addedAt", "originallyAvailableAt",
    // Series-aggregate date fields (attached by serializeSeriesAggregateForEval).
    // Without these, aggregate date comparisons fell through to the text
    // default and every comparison operator returned false.
    "latestEpisodeViewDate", "lastEpisodeAddedAt", "lastEpisodeAiredAt"]);
  if (dateFields.has(field)) {
    const raw = item[field];
    const itemDate = raw ? new Date(String(raw)) : null;
    let result: boolean;
    if (operator === "isNull") {
      result = !itemDate || isNaN(itemDate.getTime());
    } else if (operator === "isNotNull") {
      result = !!itemDate && !isNaN(itemDate.getTime());
    } else if (!itemDate || isNaN(itemDate.getTime())) {
      result = nullValueResult(operator);
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
    // Series-aggregate numeric fields (attached by serializeSeriesAggregateForEval).
    "availableEpisodeCount", "watchedEpisodeCount", "watchedEpisodePercentage",
  ]);
  if (numericFields.has(field)) {
    const itemVal = item[field] != null ? Number(item[field]) : null;
    const numVal = Number(value);
    let result: boolean;
    if (operator === "isNull") { result = itemVal === null; }
    else if (operator === "isNotNull") { result = itemVal !== null; }
    else if (itemVal === null) { result = nullValueResult(operator); }
    else if (operator === "between") { const [minStr, maxStr] = String(value).split(","); result = itemVal >= Number(minStr) && itemVal <= Number(maxStr); }
    else { result = compareNumeric(itemVal, operator, numVal); }
    return negate ? !result : result;
  }

  // Resolution field — normalize DB value to display label before comparing
  if (field === "resolution") {
    const itemStr = item[field] != null ? String(item[field]) : null;
    const normalizedLabel = normalizeResolutionLabel(itemStr);
    const strVal = String(value);
    let result: boolean;
    if (operator === "isNull") {
      result = itemStr === null || itemStr === "";
    } else if (operator === "isNotNull") {
      result = itemStr !== null && itemStr !== "";
    } else if (itemStr === null || itemStr === "") {
      result = nullValueResult(operator);
    } else {
      const labelLower = normalizedLabel.toLowerCase();
      // Normalize the rule value too: stored rules may carry raw forms
      // ("720", "4k") while the UI writes labels ("720P", "4K")
      const valLower = normalizeResolutionLabel(strVal).toLowerCase();
      switch (operator) {
        case "equals": result = labelLower === valLower; break;
        case "notEquals": result = labelLower !== valLower; break;
        case "contains": {
          // Resolution is enumerable — `contains` is multi-select list membership.
          const parts = strVal.split("|").filter(Boolean).map((pp) => normalizeResolutionLabel(pp).toLowerCase());
          result = parts.some((p) => labelLower === p);
          break;
        }
        case "notContains": {
          const parts = strVal.split("|").filter(Boolean).map((pp) => normalizeResolutionLabel(pp).toLowerCase());
          result = !parts.some((p) => labelLower === p);
          break;
        }
        // Wildcards match against the raw value (patterns like "1080*"
        // must not be normalized away)
        case "matchesWildcard": result = wildcardToRegex(String(value).toLowerCase()).test(labelLower); break;
        case "notMatchesWildcard": result = !wildcardToRegex(String(value).toLowerCase()).test(labelLower); break;
        default: return false;
      }
    }
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
    // NULL semantics mirror the Phase 1 clause shapes — see nullValueResult
    result = nullValueResult(operator);
  } else {
    const strVal = String(value).toLowerCase();
    const lower = itemStr.toLowerCase();
    const textEnumerable = isEnumerableField(field);
    switch (operator) {
      case "equals": result = lower === strVal; break;
      case "notEquals": result = lower !== strVal; break;
      case "contains": {
        const values = strVal.split("|").filter(Boolean);
        result = textEnumerable
          ? values.some((v) => lower === v)
          : values.some((v) => lower.includes(v));
        break;
      }
      case "notContains": {
        const values = strVal.split("|").filter(Boolean);
        result = textEnumerable
          ? !values.some((v) => lower === v)
          : !values.some((v) => lower.includes(v));
        break;
      }
      default: return false;
    }
  }
  return negate ? !result : result;
}

/** Evaluate a single stream query rule against a single stream record */
function evaluateStreamQueryRuleAgainstStream(
  rule: QueryRule,
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
    if (operator === "isNull" || operator === "isNotNull") {
      const result = operator === "isNull" ? streamValue == null : streamValue != null;
      return negate ? !result : result;
    }
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

  // Safety: an unconfigured contains/notContains rule, an operator that
  // doesn't apply to the field type, or a malformed value makes the entire
  // group unsatisfiable. Without this guard, quantifier="none" would be
  // vacuously true ("no stream matches false") and sweep the library.
  if (activeRules.some((rule) =>
    isUnconfiguredContainsRule(rule.operator, rule.value) ||
    !isOperatorApplicable(rule.operator, rule.field) ||
    !isValueValidForRule(rule.operator, rule.value, rule.field) ||
    // Misplaced field (no stream column, not computed) — same vacuous-"none"
    // hazard; mirrors buildStreamQueryClause returning UNSATISFIABLE_WHERE.
    (!isStreamQueryComputedField(rule.field) && !streamQueryFieldToColumn(rule.field as StreamQueryField))
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

  const items: Array<{ condition: LifecycleRuleCondition; result: boolean }> = [];

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
  // Rewrite group-level NOT into per-rule negation first (negation.ts) so
  // this phase agrees with the Phase 1 WHERE built by buildGroupConditions.
  const normalizedGroups = pushDownGroupNegation(groups);
  const results: Array<{ condition: LifecycleRuleCondition; passed: boolean }> = [];

  for (const group of normalizedGroups) {
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
    seerrMeta = lookupSeerrMeta(externalIds, seerrDataByType[itemType], itemType);
  }

  return { arrMeta, seerrMeta };
}
