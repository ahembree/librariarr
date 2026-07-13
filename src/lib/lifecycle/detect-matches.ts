import { prisma } from "@/lib/db";
import { evaluateLifecycleRules, evaluateSeriesScope, evaluateMusicScope, hasArrRules, hasSeerrRules, hasAnyActiveRules, hasWatchedByUserRules, hasSeriesAggregateRules, groupSeriesResults, getMatchedCriteriaForItems, getActualValuesForAllRules } from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import { logger } from "@/lib/logger";
import { syncCollectionById, syncAllCollections } from "@/lib/lifecycle/collections";
import { describePlexError } from "@/lib/plex/errors";

interface RuleSetConfig {
  id: string;
  name: string;
  userId: string;
  type: "MOVIE" | "SERIES" | "MUSIC";
  rules: unknown;
  seriesScope: boolean;
  serverIds: string[];
  actionEnabled: boolean;
  actionType: string | null;
  actionDelayDays: number;
  arrInstanceId: string | null;
  addImportExclusion: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  stickyMatches: boolean;
}

/** Format matched criteria into a readable string like "Resolution = 4K, Year > 2020" */
function formatCriteria(criteria: Array<{ field: string; operator: string; value: unknown; negate?: boolean }>): string {
  return criteria.map(c => `${c.negate ? "NOT " : ""}${c.field} ${c.operator} ${c.value}`).join(", ");
}

// BigInt-safe JSON serializer for Prisma Json columns
function jsonSafe(value: unknown): string | number | boolean | object {
  return JSON.parse(JSON.stringify(value, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ));
}

/**
 * Evaluate rules for a single rule set, compute match metadata, and
 * persist the results to the RuleMatch table.
 *
 * Returns the enriched items (same shape as the old live matches API).
 */
export async function detectAndSaveMatches(
  ruleSet: RuleSetConfig,
  serverIds: string[],
  arrData?: ArrDataMap,
  seerrData?: SeerrDataMap,
  fullReEval: boolean = false,
): Promise<{ items: Record<string, unknown>[]; count: number; episodeIdMap: Map<string, string[]>; currentItems: Record<string, unknown>[] }> {
  const rules = ruleSet.rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];

  // SAFETY: Refuse to evaluate if no rules are active — would match everything
  if (!hasAnyActiveRules(rules)) {
    if (fullReEval) {
      await prisma.ruleMatch.deleteMany({ where: { ruleSetId: ruleSet.id } });
      logger.info("Lifecycle", `Skipping rule set "${ruleSet.name}" — no active rules (cleared matches)`);
      return { items: [], count: 0, episodeIdMap: new Map(), currentItems: [] };
    }
    // Incremental: preserve existing matches, add nothing new
    const existingMatches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id },
      select: { itemData: true },
    });
    logger.info("Lifecycle", `Skipping rule set "${ruleSet.name}" — no active rules (preserving ${existingMatches.length} existing matches)`);
    return {
      items: existingMatches.map((m) => m.itemData as Record<string, unknown>),
      count: existingMatches.length,
      episodeIdMap: new Map(),
      currentItems: [],
    };
  }

  // Defense-in-depth: refuse to evaluate when the rules' Arr/Seerr instances
  // are unavailable — an empty metadata map turns "foundInArr = false" /
  // "seerrRequested = false" into a whole-library match. Callers normally
  // pre-check via the same helper (and handle permanent-case disarming); this
  // internal check is the choke point that protects any future caller.
  const evaluability = await checkLifecycleRuleEvaluability(ruleSet.userId, ruleSet.type, rules);
  if (!evaluability.evaluable) {
    const existingMatches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id },
      select: { itemData: true },
    });
    logger.warn("Lifecycle", `Refusing to evaluate rule set "${ruleSet.name}" — ${evaluability.reason} (preserving ${existingMatches.length} existing matches)`);
    return {
      items: existingMatches.map((m) => m.itemData as Record<string, unknown>),
      count: existingMatches.length,
      episodeIdMap: new Map(),
      currentItems: [],
    };
  }

  let matched;
  const episodeIdMap = new Map<string, string[]>();
  // A SERIES rule that references a series-aggregate field (episodeCount,
  // watchedEpisodePercentage, …) MUST be evaluated at the series level even
  // when seriesScope is false — the aggregate cannot be computed per-episode,
  // and the episode path silently drops it (see hasSeriesAggregateRules). This
  // mirrors the query engine's aggregateSeriesAndFilter routing.
  const seriesUsesAggregate = ruleSet.type === "SERIES" && hasSeriesAggregateRules(rules);
  if (ruleSet.type === "SERIES" && (ruleSet.seriesScope || seriesUsesAggregate)) {
    // When seriesScope is false the series path is FORCED by an aggregate field;
    // the user still asked for per-episode scope, so restrict each matched
    // series' member episodes to those that individually satisfy the rule (a
    // member-scoped file delete then acts only on matching episodes, not the
    // whole series). With seriesScope true, every episode stays a member.
    matched = await evaluateSeriesScope(rules, serverIds, arrData, seerrData, !ruleSet.seriesScope);
    // Build episode ID map so actions track individual episodes for file size calculation
    for (const m of matched) {
      const ids = (m as unknown as { memberIds?: string[] }).memberIds;
      if (ids && ids.length > 0) {
        episodeIdMap.set(m.id, ids);
      }
    }
  } else if (ruleSet.type === "MUSIC" && ruleSet.seriesScope) {
    matched = await evaluateMusicScope(rules, serverIds, arrData);
    // Build track ID map so actions track individual tracks for file size calculation
    for (const m of matched) {
      const ids = (m as unknown as { memberIds?: string[] }).memberIds;
      if (ids && ids.length > 0) {
        episodeIdMap.set(m.id, ids);
      }
    }
  } else {
    const rawItems = await evaluateLifecycleRules(rules, ruleSet.type, serverIds, arrData, seerrData);
    if (ruleSet.type === "SERIES") {
      const grouped = groupSeriesResults(rawItems);
      // Build episode ID map: grouped item id → individual episode ids
      for (const g of grouped) {
        episodeIdMap.set(g.id as string, (g as unknown as { memberIds: string[] }).memberIds);
      }
      matched = grouped;
    } else {
      matched = rawItems;
    }
  }

  // Compute which rules matched and actual values for each item
  const records = matched as unknown as Array<Record<string, unknown>>;
  const criteriaMap = getMatchedCriteriaForItems(records, rules, ruleSet.type, arrData, seerrData);
  const actualValuesMap = getActualValuesForAllRules(records, rules, ruleSet.type, arrData, seerrData);

  // Build arrId lookup: resolve each item's external ID → arrData entry → arrId
  const arrIdSource = ruleSet.type === "MOVIE" ? "TMDB" : ruleSet.type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";

  const enrichedItems: Record<string, unknown>[] = matched
    .map((item) => {
      const rec = item as Record<string, unknown>;
      const ms = rec.library as
        | { mediaServer?: { id: string; name: string; type: string } }
        | undefined;
      const itemActualValues = actualValuesMap.get(item.id);

      // Resolve internal Arr ID
      let arrId: number | null = null;
      if (arrData) {
        const externalIds = (rec.externalIds ?? []) as Array<{ source: string; externalId: string }>;
        const extId = externalIds.find((e) => e.source === arrIdSource);
        if (extId && arrData[extId.externalId]) {
          arrId = arrData[extId.externalId].arrId;
        }
      }

      return {
        ...rec,
        arrId,
        // Explicitly preserve memberIds for episode-level deletion tracking
        ...(rec.memberIds ? { memberIds: rec.memberIds } : {}),
        matchedCriteria: criteriaMap.get(item.id) ?? [],
        actualValues: itemActualValues ? Object.fromEntries(itemActualValues) : {},
        servers: ms?.mediaServer
          ? [{ serverId: ms.mediaServer.id, serverName: ms.mediaServer.name, serverType: ms.mediaServer.type }]
          : [],
      } as Record<string, unknown>;
    })
    .sort((a, b) => {
      const titleA = ((a.parentTitle ?? a.title ?? "") as string).toLowerCase();
      const titleB = ((b.parentTitle ?? b.title ?? "") as string).toLowerCase();
      return titleA.localeCompare(titleB);
    });

  // Filter out items that have a LifecycleException for this user
  const isGroupedScope =
    (ruleSet.type === "SERIES" || ruleSet.type === "MUSIC") && ruleSet.seriesScope;

  if (isGroupedScope) {
    // For series/music scope rules, the enriched items are aggregated (representative
    // episode/track ID).  Exceptions are stored against individual episode/track IDs,
    // so we must look up by parentTitle (the series/artist name, stored as `title` on
    // the aggregated item since the engine swaps title/parentTitle).
    const groupTitles = enrichedItems
      .map((item) => item.title as string)
      .filter(Boolean);
    if (groupTitles.length > 0) {
      const excludedTitles = await prisma.lifecycleException.findMany({
        where: {
          userId: ruleSet.userId,
          mediaItem: {
            parentTitle: { in: groupTitles },
            type: ruleSet.type,
            library: { mediaServerId: { in: ruleSet.serverIds } },
          },
        },
        select: {
          mediaItem: { select: { parentTitle: true } },
        },
      });
      if (excludedTitles.length > 0) {
        const excludedSet = new Set(
          excludedTitles.map((e) => e.mediaItem.parentTitle)
        );
        const beforeCount = enrichedItems.length;
        const filtered = enrichedItems.filter(
          (item) => !excludedSet.has(item.title as string)
        );
        logger.info("Lifecycle", `Filtered ${beforeCount - filtered.length} excluded items from rule set "${ruleSet.name}"`);
        enrichedItems.length = 0;
        enrichedItems.push(...filtered);
      }
    }
  } else {
    // Individual-scope rules: check by exact mediaItemId.
    // For grouped SERIES (seriesScope=false), also check memberIds so excepted
    // episodes are removed from groups without dropping the entire series.
    const allIds = new Set<string>();
    for (const item of enrichedItems) {
      allIds.add(item.id as string);
      const members = item.memberIds as string[] | undefined;
      if (members) {
        for (const mid of members) allIds.add(mid);
      }
    }

    const excludedItems = await prisma.lifecycleException.findMany({
      where: {
        userId: ruleSet.userId,
        mediaItemId: { in: [...allIds] },
      },
      select: { mediaItemId: true },
    });
    if (excludedItems.length > 0) {
      const excludedIds = new Set(excludedItems.map((e) => e.mediaItemId));
      const beforeCount = enrichedItems.length;
      const filtered: Record<string, unknown>[] = [];
      for (const item of enrichedItems) {
        const members = item.memberIds as string[] | undefined;
        if (members) {
          // Grouped item: remove excepted members, keep group if any remain
          const remainingMembers = members.filter((mid) => !excludedIds.has(mid));
          if (remainingMembers.length > 0) {
            const updated: Record<string, unknown> = { ...item, memberIds: remainingMembers };
            // If the representative ID itself was excepted, promote the first
            // remaining member so execution-time exception checks don't cancel
            // the action for the non-excepted episodes.
            if (excludedIds.has(item.id as string)) {
              updated.id = remainingMembers[0];
            }
            filtered.push(updated);
          }
        } else if (!excludedIds.has(item.id as string)) {
          filtered.push(item);
        }
      }
      const removedCount = beforeCount - filtered.length;
      if (removedCount > 0) {
        logger.info("Lifecycle", `Filtered ${removedCount} excluded items from rule set "${ruleSet.name}"`);
      }
      enrichedItems.length = 0;
      enrichedItems.push(...filtered);

      // Rebuild episodeIdMap from filtered items so scheduled actions
      // only reference non-excepted episode/track IDs
      episodeIdMap.clear();
      for (const item of enrichedItems) {
        const members = item.memberIds as string[] | undefined;
        if (members && members.length > 0) {
          episodeIdMap.set(item.id as string, members);
        }
      }
    }
  }

  // Multi-server: the same logical media appears once per server, but each
  // copy resolves to the SAME Arr record (same TMDB/TVDB/MBID). Collapse those
  // duplicates so we don't schedule two destructive actions against one Arr
  // record or double-count deletedBytes. We dedupe by the resolved EXTERNAL id
  // (TMDB/TVDB/MBID), which is globally unique — NOT the internal `arrId`,
  // which is an instance-local auto-increment id that collides across two
  // different Arr instances (two unrelated series can both be id 5 on their
  // respective Sonarr instances and would wrongly collapse into one match). We
  // still gate on `arrId != null` so only items that actually resolved to an
  // Arr record are collapsed (a rule set may target a server SUBSET whose
  // dedupCanonical copy lives on a non-targeted server, so we can't key on
  // dedupCanonical). Items with no Arr id are left as-is.
  if (ruleSet.serverIds.length > 1) {
    const byExternalId = new Map<string, Record<string, unknown>>();
    const deduped: Record<string, unknown>[] = [];
    for (const item of enrichedItems) {
      const arrId = item.arrId as number | null;
      const externalIds = (item.externalIds ?? []) as Array<{ source: string; externalId: string }>;
      const externalKey = externalIds.find((e) => e.source === arrIdSource)?.externalId;
      if (arrId == null || !externalKey) {
        deduped.push(item);
        continue;
      }
      const existing = byExternalId.get(externalKey);
      if (!existing) {
        byExternalId.set(externalKey, item);
        deduped.push(item);
      } else {
        // Merge server presence so the matches view still shows every server.
        const merged = [
          ...((existing.servers as unknown[]) ?? []),
          ...((item.servers as unknown[]) ?? []),
        ];
        const seen = new Set<string>();
        existing.servers = merged.filter((s) => {
          const sid = (s as { serverId?: string }).serverId;
          if (!sid) return true;
          if (seen.has(sid)) return false;
          seen.add(sid);
          return true;
        });
        // Merge member ids (episode/track ids) so a member that exists only on
        // the dropped server's copy is still acted on and still counted toward
        // deletedBytes. Dropping the dropped copy's members (the old behavior)
        // under-deleted and under-counted for multi-server series/music.
        const existingMembers = (existing.memberIds as string[] | undefined) ?? [];
        const itemMembers = (item.memberIds as string[] | undefined) ?? [];
        if (existingMembers.length > 0 || itemMembers.length > 0) {
          const mergedMembers = [...new Set([...existingMembers, ...itemMembers])];
          existing.memberIds = mergedMembers;
          // Keep the returned episodeIdMap in sync with the merged member set,
          // and drop the now-removed duplicate's stale entry.
          episodeIdMap.set(existing.id as string, mergedMembers);
        }
        episodeIdMap.delete(item.id as string);
      }
    }
    if (deduped.length < enrichedItems.length) {
      logger.info(
        "Lifecycle",
        `Collapsed ${enrichedItems.length - deduped.length} cross-server duplicate match(es) by external ID for rule set "${ruleSet.name}"`,
      );
      enrichedItems.length = 0;
      enrichedItems.push(...deduped);
    }
  }

  const now = new Date();

  if (fullReEval) {
    // Full re-evaluation: atomic delete + recreate (clears stale matches)
    await prisma.$transaction(async (tx) => {
      await tx.ruleMatch.deleteMany({ where: { ruleSetId: ruleSet.id } });

      if (enrichedItems.length > 0) {
        await tx.ruleMatch.createMany({
          data: enrichedItems.map((item) => ({
            ruleSetId: ruleSet.id,
            mediaItemId: item.id as string,
            itemData: jsonSafe(item),
            detectedAt: now,
          })),
        });
      }
    });

    logger.info("Lifecycle", `Detected ${enrichedItems.length} matches for rule set "${ruleSet.name}" (full re-evaluation)`);
    return { items: enrichedItems, count: enrichedItems.length, episodeIdMap, currentItems: enrichedItems };
  }

  // Incremental: add new matches and remove stale ones
  const existingMatches = await prisma.ruleMatch.findMany({
    where: { ruleSetId: ruleSet.id },
    select: { mediaItemId: true, itemData: true },
  });
  const existingIds = new Set(existingMatches.map((m) => m.mediaItemId));
  const existingDataMap = new Map(existingMatches.map((m) => [m.mediaItemId, m.itemData as Record<string, unknown>]));
  const currentIds = new Set(enrichedItems.map((item) => item.id as string));

  const newItems = enrichedItems.filter(
    (item) => !existingIds.has(item.id as string)
  );
  const staleIds = [...existingIds].filter((id) => !currentIds.has(id));

  // Atomic create + delete: a partial failure must not leave a half-updated
  // match set (e.g. new matches written but stale ones never removed).
  const removeStale = !ruleSet.stickyMatches && staleIds.length > 0;
  if (newItems.length > 0 || removeStale) {
    await prisma.$transaction([
      ...(newItems.length > 0
        ? [
            prisma.ruleMatch.createMany({
              data: newItems.map((item) => ({
                ruleSetId: ruleSet.id,
                mediaItemId: item.id as string,
                itemData: jsonSafe(item),
                detectedAt: now,
              })),
              skipDuplicates: true,
            }),
          ]
        : []),
      ...(removeStale
        ? [
            prisma.ruleMatch.deleteMany({
              where: { ruleSetId: ruleSet.id, mediaItemId: { in: staleIds } },
            }),
          ]
        : []),
    ]);
  }

  if (removeStale) {
    // Fetch current state of stale items to determine which criteria changed.
    // Scope by the rule set's serverIds so logs can never refer to items outside
    // the rule set's intended library scope.
    const staleItems = await prisma.mediaItem.findMany({
      where: {
        id: { in: staleIds },
        library: { mediaServerId: { in: serverIds } },
      },
      include: {
        externalIds: true,
        streams: true,
        // Re-evaluation needs per-user play history to compute accurate
        // "no longer matching" reasons for watchedByUser rules.
        ...(hasWatchedByUserRules(rules) ? { watchHistory: { select: { serverUsername: true } } } : {}),
        library: {
          select: {
            title: true,
            mediaServer: { select: { id: true, name: true, type: true } },
          },
        },
      },
    });
    const staleItemMap = new Map(staleItems.map((item) => [item.id, item as unknown as Record<string, unknown>]));

    for (const id of staleIds) {
      const oldData = existingDataMap.get(id);
      const title = (oldData?.parentTitle ?? oldData?.title ?? id) as string;
      const oldCriteria = oldData?.matchedCriteria as Array<{ ruleId: string; field: string; operator: string; value: unknown; negate?: boolean }> | undefined;

      if (!oldCriteria?.length) {
        logger.info("Lifecycle", `Removed stale match "${title}" from rule set "${ruleSet.name}"`);
        continue;
      }

      const currentItem = staleItemMap.get(id);
      if (!currentItem) {
        logger.info("Lifecycle", `Removed stale match "${title}" from rule set "${ruleSet.name}" (item no longer exists)`);
        continue;
      }

      // Re-evaluate each rule independently against current item data
      const currentCriteriaMap = getMatchedCriteriaForItems([currentItem], rules, ruleSet.type, arrData, seerrData);
      const currentRuleIds = new Set((currentCriteriaMap.get(id) ?? []).map((c) => c.ruleId));

      // Criteria in old set but not current = the rules that caused the item to drop
      const changedCriteria = oldCriteria.filter((c) => !currentRuleIds.has(c.ruleId));

      if (changedCriteria.length > 0) {
        logger.info("Lifecycle", `Removed stale match "${title}" from rule set "${ruleSet.name}" (no longer matching: ${formatCriteria(changedCriteria)})`);
      } else {
        logger.info("Lifecycle", `Removed stale match "${title}" from rule set "${ruleSet.name}" (was matching: ${formatCriteria(oldCriteria)})`);
      }
    }
  }

  // When sticky, return all items (existing + new); otherwise return only current matches
  const returnItems = ruleSet.stickyMatches
    ? [...existingMatches.map((m) => m.itemData as Record<string, unknown>), ...newItems]
    : enrichedItems;

  // Rebuild episodeIdMap from the returned set
  const fullEpisodeIdMap = new Map<string, string[]>();
  for (const item of returnItems) {
    const id = item.id as string;
    const memberIds = item.memberIds as string[] | undefined;
    if (memberIds && memberIds.length > 0) {
      fullEpisodeIdMap.set(id, memberIds);
    } else if (episodeIdMap.has(id)) {
      fullEpisodeIdMap.set(id, episodeIdMap.get(id)!);
    }
  }

  const removedCount = ruleSet.stickyMatches ? 0 : staleIds.length;
  logger.info("Lifecycle", `Detected ${newItems.length} new matches for rule set "${ruleSet.name}" (${existingMatches.length - removedCount} existing, ${removedCount} removed, ${returnItems.length} total)`);
  return { items: returnItems, count: returnItems.length, episodeIdMap: fullEpisodeIdMap, currentItems: enrichedItems };
}

/**
 * Run detection for one or all enabled rule sets.
 * Fetches metadata, evaluates rules, and saves matches.
 */
export async function runDetection(userId: string, ruleSetId?: string, fullReEval: boolean = false) {
  const ruleSets = await prisma.ruleSet.findMany({
    where: {
      userId,
      enabled: true,
      ...(ruleSetId ? { id: ruleSetId } : {}),
    },
    include: {
      user: {
        include: { mediaServers: { where: { enabled: true }, select: { id: true } } },
      },
    },
  });

  // Lazy metadata caches (shared across rule sets of the same type)
  const movieArrCache: { fetched: boolean; data: ArrDataMap } = { fetched: false, data: {} };
  const seriesArrCache: { fetched: boolean; data: ArrDataMap } = { fetched: false, data: {} };
  const musicArrCache: { fetched: boolean; data: ArrDataMap } = { fetched: false, data: {} };
  const movieSeerrCache: { fetched: boolean; data: SeerrDataMap } = { fetched: false, data: {} };
  const seriesSeerrCache: { fetched: boolean; data: SeerrDataMap } = { fetched: false, data: {} };

  const results: Array<{
    ruleSet: {
      id: string;
      name: string;
      type: string;
      actionEnabled: boolean;
      actionType: string | null;
      actionDelayDays: number;
      arrInstanceId: string | null;
      addImportExclusion: boolean;
      addArrTags: string[];
      removeArrTags: string[];
      collectionId: string | null;
      stickyMatches: boolean;
    };
    items: Record<string, unknown>[];
    count: number;
  }> = [];

  for (const rs of ruleSets) {
    const allServerIds = rs.user.mediaServers.map((s) => s.id);
    const serverIds = rs.serverIds.filter((id) => allServerIds.includes(id));
    if (serverIds.length === 0) continue;

    const rules = rs.rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];
    if (!hasAnyActiveRules(rules)) continue;

    // MATCH-ALL SAFETY: mirror processLifecycleRules — Arr/Seerr rules whose
    // instances are unavailable skip the rule set instead of evaluating
    // against an empty metadata map (which would make "foundInArr = false" /
    // "seerrRequested = false" match the whole library). Permanent failures
    // (Seerr on MUSIC) also disarm the rule set — see evaluability.ts.
    const evaluability = await checkLifecycleRuleEvaluability(userId, rs.type, rules);
    if (!evaluability.evaluable) {
      logger.warn("Lifecycle", `Skipping rule set "${rs.name}" — ${evaluability.reason}`);
      if (evaluability.permanent) {
        const cancelled = await prisma.lifecycleAction.deleteMany({
          where: { ruleSetId: rs.id, status: "PENDING" },
        });
        const cleared = await prisma.ruleMatch.deleteMany({ where: { ruleSetId: rs.id } });
        if (cancelled.count > 0 || cleared.count > 0) {
          logger.warn("Lifecycle", `Disarmed permanently unevaluable rule set "${rs.name}" — cancelled ${cancelled.count} pending action(s) and cleared ${cleared.count} stale match(es)`);
        }
      }
      continue;
    }

    // Resolve Arr metadata
    let arrData: ArrDataMap | undefined;
    if (hasArrRules(rules)) {
      if (rs.type === "MOVIE") {
        if (!movieArrCache.fetched) {
          movieArrCache.data = await fetchArrMetadata(userId, "MOVIE");
          movieArrCache.fetched = true;
        }
        arrData = movieArrCache.data;
      } else if (rs.type === "MUSIC") {
        if (!musicArrCache.fetched) {
          musicArrCache.data = await fetchArrMetadata(userId, "MUSIC");
          musicArrCache.fetched = true;
        }
        arrData = musicArrCache.data;
      } else {
        if (!seriesArrCache.fetched) {
          seriesArrCache.data = await fetchArrMetadata(userId, "SERIES");
          seriesArrCache.fetched = true;
        }
        arrData = seriesArrCache.data;
      }
    }

    // Resolve Seerr metadata (not applicable for MUSIC)
    let seerrData: SeerrDataMap | undefined;
    if (hasSeerrRules(rules) && rs.type !== "MUSIC") {
      if (rs.type === "MOVIE") {
        if (!movieSeerrCache.fetched) {
          movieSeerrCache.data = await fetchSeerrMetadata(userId, "MOVIE");
          movieSeerrCache.fetched = true;
        }
        seerrData = movieSeerrCache.data;
      } else {
        if (!seriesSeerrCache.fetched) {
          seriesSeerrCache.data = await fetchSeerrMetadata(userId, "SERIES");
          seriesSeerrCache.fetched = true;
        }
        seerrData = seriesSeerrCache.data;
      }
    }

    const result = await detectAndSaveMatches(
      {
        id: rs.id,
        name: rs.name,
        userId: rs.userId,
        type: rs.type,
        rules: rs.rules,
        seriesScope: rs.seriesScope,
        serverIds,
        actionEnabled: rs.actionEnabled,
        actionType: rs.actionType,
        actionDelayDays: rs.actionDelayDays,
        arrInstanceId: rs.arrInstanceId,
        addImportExclusion: rs.addImportExclusion,
        addArrTags: rs.addArrTags,
        removeArrTags: rs.removeArrTags,
        stickyMatches: rs.stickyMatches,
      },
      serverIds,
      arrData,
      seerrData,
      fullReEval,
    );

    results.push({
      ruleSet: {
        id: rs.id,
        name: rs.name,
        type: rs.type,
        actionEnabled: rs.actionEnabled,
        actionType: rs.actionType,
        actionDelayDays: rs.actionDelayDays,
        arrInstanceId: rs.arrInstanceId,
        addImportExclusion: rs.addImportExclusion,
        addArrTags: rs.addArrTags,
        removeArrTags: rs.removeArrTags,
        collectionId: rs.collectionId,
        stickyMatches: rs.stickyMatches,
      },
      items: result.items,
      count: result.count,
    });
  }

  return results;
}

/**
 * Sync Plex collections after a manual detection run. Collection membership is
 * the UNION of every rule set feeding it, so this runs after detection (and,
 * when the caller processes actions, after those are scheduled — so
 * ACTION_DATE ordering reflects the freshly scheduled actions).
 *
 * For a single-rule-set run, only the collection(s) that rule set feeds are
 * synced; for a full run, every collection is synced (which also cleans up
 * orphaned collections).
 */
export async function syncCollectionsAfterDetection(
  userId: string,
  ruleSetId: string | undefined,
  results: Array<{ ruleSet: { collectionId: string | null } }>,
): Promise<void> {
  const plexItemsCache = new Map<string, Array<{ title: string; ratingKey: string }>>();
  if (ruleSetId) {
    const collectionIds = [
      ...new Set(results.map((r) => r.ruleSet.collectionId).filter((id): id is string => !!id)),
    ];
    for (const id of collectionIds) {
      try {
        await syncCollectionById(id, plexItemsCache);
      } catch (error) {
        logger.error("Lifecycle", `Collection sync failed for collection ${id} during detection`, { error: describePlexError(error) });
      }
    }
  } else {
    await syncAllCollections(userId, plexItemsCache);
  }
}
