import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import {
  evaluateAllRulesInMemory,
  evaluateGroupThroughMembers,
  hasMemberValueRules,
  getMatchedCriteriaForItems,
  getActualValuesForAllRules,
  hasArrRules,
  hasSeerrRules,
  hasAnyActiveRules,
  hasStreamRules,
  hasSeriesAggregateRules,
  hasWatchedByUserRules,
  hasCrossSystemFieldRules,
  hasCustomFormatScoreRules,
  lookupSeerrMeta,
} from "@/lib/rules/lifecycle-engine";
import { fetchCrossSystemData, foldCrossSystemData } from "@/lib/conditions/cross-system-data";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRuleGroup, LifecycleRule } from "@/lib/rules/types";
import { fetchArrRecordForPreview } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadataForPreview } from "@/lib/lifecycle/fetch-seerr-metadata";
import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import { validateRequest, ruleTestItemSchema } from "@/lib/validation";
import { COMPLETED_PLAY_FILTER } from "@/lib/media/watch-completion";
import { resolveSeriesKey } from "@/lib/media/series-key";
import { artistMbidOf, splitArtistGroupByMbid } from "@/lib/media/artist-key";
import { withGroupParentTitle } from "@/lib/conditions/series-aggregates";

export const POST = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, ruleTestItemSchema);
  if (error) return error;

  const { rules, type, seriesScope, mediaItemId, serverIds, arrInstanceId, ruleSetId } = data;
  const typedRules = rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];

  if (!hasAnyActiveRules(typedRules)) {
    return NextResponse.json(
      { error: "No active rules to evaluate" },
      { status: 400 }
    );
  }

  // `watchedByUser` is answered from the WatchHistory relation, exactly as the
  // engines load it: completed plays only (`COMPLETED_PLAY_FILTER`), so a
  // partial Tracearr play counts here exactly as little as it does in detection.
  // Without it the evaluator saw an item watched by nobody, and the preview
  // gave the opposite answer to detection for every `watchedByUser` rule.
  const watchHistoryInclude = hasWatchedByUserRules(typedRules)
    ? {
        watchHistory: {
          where: COMPLETED_PLAY_FILTER,
          select: { serverUsername: true },
        },
      }
    : {};

  // Fetch the item with full relations
  const item = await prisma.mediaItem.findFirst({
    where: {
      id: mediaItemId,
      library: { mediaServer: { userId: session.userId } },
    },
    include: {
      externalIds: true,
      streams: true,
      ...watchHistoryInclude,
      library: {
        select: {
          id: true,
          title: true,
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "Media item not found" }, { status: 404 });
  }

  // MATCH-ALL SAFETY: mirror detection — Arr/Seerr rules with no enabled
  // instance behind them would report a vacuous "matches" for any item.
  // Scoped to the tested item's OWN server rather than the rule set's whole
  // target list: this route evaluates exactly one item, so only that server's
  // watch history is read, and a different server still importing says nothing
  // about whether this item's plays are known.
  // (An orphaned library — its server deleted with `onDelete: SetNull` — has no
  // server to scope to, so fall back to the rule set's own targets.)
  const evaluability = await checkLifecycleRuleEvaluability(
    session.userId,
    type,
    typedRules,
    item.library.mediaServer ? [item.library.mediaServer.id] : serverIds,
    arrInstanceId,
    // As the group scope below reads it: per-episode criteria at series or
    // artist scope are refused with the reason, not answered.
    !!seriesScope,
  );
  if (!evaluability.evaluable) {
    return NextResponse.json({ error: evaluability.reason }, { status: 400 });
  }

  // The item is evaluated against its own Arr record only — the one under its
  // Arr-family id, which a group record shares (it spreads the item) — so only
  // that record is read, not the instance's whole library. Seerr has no
  // per-item listing that folds requests as the request walk does, so it is
  // read whole, through the editor's short-lived cache. Both at once.
  const arrIdSource = type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";
  const arrLookupId = item.externalIds.find((e) => e.source === arrIdSource)?.externalId;
  const [arrData, seerrData]: [ArrDataMap | undefined, SeerrDataMap | undefined] = await Promise.all([
    hasArrRules(typedRules)
      ? arrLookupId
        ? fetchArrRecordForPreview(session.userId, type, arrLookupId, arrInstanceId, {
            customFormatScores: hasCustomFormatScoreRules(typedRules),
          })
        : Promise.resolve({})
      : Promise.resolve(undefined),
    hasSeerrRules(typedRules) && type !== "MUSIC"
      ? fetchSeerrMetadataForPreview(session.userId, type)
      : Promise.resolve(undefined),
  ]);

  // Cross-system fields, enriched as detection enriches them: the item's own,
  // and a group's read across its members (below), leaving out the rule set's
  // own pending actions.
  const crossSystemFor = (ids: string[]) =>
    hasCrossSystemFieldRules(typedRules)
      ? fetchCrossSystemData(ids, { excludeRuleSetId: ruleSetId })
      : Promise.resolve(undefined);

  // Single item, as the episode/movie/track itself.
  const single: Record<string, unknown> = {
    ...item,
    ...(await crossSystemFor([item.id]))?.get(item.id),
    fileSize: item.fileSize?.toString() ?? null,
    lastPlayedAt: item.lastPlayedAt?.toISOString() ?? null,
    addedAt: item.addedAt?.toISOString() ?? null,
    originallyAvailableAt: item.originallyAvailableAt?.toISOString() ?? null,
    streams: item.streams ?? [],
  };

  // A SERIES rule reading a series-aggregate field is evaluated at the series
  // level even with seriesScope off, exactly as detection routes it
  // (`evaluateSeriesScope(…, restrictMembersToEpisodeMatches)`): the episode
  // matches when it passes on its own with the series aggregates injected.
  const aggregateForced =
    type === "SERIES" && !seriesScope && hasSeriesAggregateRules(typedRules);
  const groupScope =
    (seriesScope && (type === "SERIES" || type === "MUSIC")) || aggregateForced;

  let group: Record<string, unknown> | null = null;
  // The show's episodes or the artist's tracks, which a group is judged through.
  let groupMembers: Array<{ id: string }> = [];

  // Series/music scope: aggregate all episodes/tracks of this series/artist
  if (groupScope) {
    const groupField = item.parentTitle ?? item.title;
    // A show is grouped by `seriesKey` within its library, as detection does —
    // never by `parentTitle`, which merges two different shows sharing a title
    // (The Office UK and US). A row predating the column has no stored key, so
    // those are fetched too and keyed the way detection keys them. An artist
    // is grouped by `parentTitle`, split by MusicBrainz id only when the title
    // carries several (`splitArtistGroupByMbid`), as in detection.
    const seriesKey = type === "SERIES" ? resolveSeriesKey(item) : null;
    const candidates = await prisma.mediaItem.findMany({
      where: {
        type,
        libraryId: item.libraryId,
        ...(type === "SERIES"
          ? {
              OR: seriesKey
                ? [{ seriesKey }, { seriesKey: null }]
                : [{ seriesKey: null }],
            }
          : { parentTitle: groupField }),
        library: { mediaServerId: { in: serverIds } },
      },
      include: {
        externalIds: true,
        ...(hasStreamRules(typedRules) ? { streams: true } : {}),
        ...watchHistoryInclude,
        library: {
          select: {
            title: true,
            mediaServer: { select: { id: true, name: true, type: true } },
          },
        },
      },
    });
    const allItems =
      type === "SERIES"
        ? candidates.filter((ep) => resolveSeriesKey(ep) === seriesKey)
        : (splitArtistGroupByMbid(candidates, (t) => artistMbidOf(t.externalIds)).find((g) =>
            g.some((t) => t.id === item.id),
          ) ?? candidates);
    groupMembers = allItems;

    const totalPlays = allItems.reduce((sum, ep) => sum + ep.playCount, 0);
    const totalSize = allItems.reduce(
      (sum, ep) => sum + (ep.fileSize ?? BigInt(0)),
      BigInt(0)
    );
    const latestPlayed = allItems.reduce<Date | null>((latest, ep) => {
      if (!ep.lastPlayedAt) return latest;
      if (!latest || ep.lastPlayedAt > latest) return ep.lastPlayedAt;
      return latest;
    }, null);
    const earliestAdded = allItems.reduce<Date | null>((earliest, ep) => {
      if (!ep.addedAt) return earliest;
      if (!earliest || ep.addedAt < earliest) return ep.addedAt;
      return earliest;
    }, null);
    const watchedCount = allItems.filter((ep) => ep.playCount > 0).length;
    const latestEpisodeAdded = allItems.reduce<Date | null>((latest, ep) => {
      if (!ep.addedAt) return latest;
      if (!latest || ep.addedAt > latest) return ep.addedAt;
      return latest;
    }, null);
    const latestEpisodeAired = allItems.reduce<Date | null>((latest, ep) => {
      if (!ep.originallyAvailableAt) return latest;
      if (!latest || ep.originallyAvailableAt > latest)
        return ep.originallyAvailableAt;
      return latest;
    }, null);
    const allStreams = allItems.flatMap((ep) =>
      "streams" in ep ? (ep.streams as unknown[]) : []
    );
    const sortedByNewest = [...allItems].sort((a, b) => {
      const seasonDiff = (b.seasonNumber ?? 0) - (a.seasonNumber ?? 0);
      if (seasonDiff !== 0) return seasonDiff;
      return (b.episodeNumber ?? 0) - (a.episodeNumber ?? 0);
    });
    const latestEpisodeViewDate = sortedByNewest[0]?.lastPlayedAt ?? null;
    // Everyone who completed a play of any member — the aggregate shape the
    // evaluator reads for `watchedByUser`, built as the engines build it.
    const watchedByUsers = Array.from(
      new Set(
        allItems.flatMap((ep) =>
          "watchHistory" in ep
            ? (ep.watchHistory as Array<{ serverUsername: string | null }>)
                .map((h) => h.serverUsername)
                .filter((u): u is string => !!u)
            : []
        )
      )
    );

    // The show or artist, named by `title`; "Artist / Series" reads that name
    // too (withGroupParentTitle), as detection evaluates a group.
    group = withGroupParentTitle({
      ...item,
      ...foldCrossSystemData(allItems.map((ep) => ep.id), await crossSystemFor(allItems.map((ep) => ep.id))),
      title: groupField,
      ...(type === "SERIES"
        ? { summary: item.parentSummary ?? item.summary }
        : {}),
      seasonNumber: null,
      episodeNumber: null,
      playCount: totalPlays,
      fileSize: totalSize > BigInt(0) ? totalSize.toString() : null,
      lastPlayedAt: latestPlayed?.toISOString() ?? null,
      // "Series Last Played" — MAX(lastPlayedAt) across the episodes.
      seriesLastPlayedAt: latestPlayed?.toISOString() ?? null,
      addedAt: earliestAdded?.toISOString() ?? null,
      // A per-member value, as the other per-item fields spread from the item:
      // each member's own when the group is judged through its members.
      originallyAvailableAt: item.originallyAvailableAt?.toISOString() ?? null,
      episodeCount: allItems.length,
      matchedEpisodes: allItems.length,
      watchedEpisodeCount: watchedCount,
      latestEpisodeViewDate: latestEpisodeViewDate?.toISOString() ?? null,
      availableEpisodeCount: allItems.length,
      watchedEpisodePercentage:
        allItems.length > 0 ? (watchedCount / allItems.length) * 100 : 0,
      lastEpisodeAddedAt: latestEpisodeAdded?.toISOString() ?? null,
      lastEpisodeAiredAt: latestEpisodeAired?.toISOString() ?? null,
      streams: allStreams,
      watchedByUsers,
    });
  }

  // What is evaluated: the group in group scope; in a forced-aggregate run,
  // the episode carrying the series aggregates.
  const evaluated: Record<string, unknown> =
    group && aggregateForced
      ? {
          ...single,
          availableEpisodeCount: group.availableEpisodeCount,
          watchedEpisodeCount: group.watchedEpisodeCount,
          watchedEpisodePercentage: group.watchedEpisodePercentage,
          latestEpisodeViewDate: group.latestEpisodeViewDate,
          seriesLastPlayedAt: group.seriesLastPlayedAt,
          lastEpisodeAddedAt: group.lastEpisodeAddedAt,
          lastEpisodeAiredAt: group.lastEpisodeAiredAt,
        }
      : (group ?? single);

  // Evaluate rules against the item
  const externalIds = (evaluated.externalIds as Array<{
    source: string;
    externalId: string;
  }>) ?? [];
  const arrExtId = externalIds.find((e) => e.source === arrIdSource);
  const arrMeta =
    arrData && arrExtId ? arrData[arrExtId.externalId] : undefined;
  // Use the shared namespaced lookup — fetchSeerrMetadata keys entries as
  // "TMDB:<id>" / "TVDB:<id>", so a bare externalId lookup always missed,
  // making the `matches` result disagree with matchedCriteria for Seerr rules.
  const seerrMeta = lookupSeerrMeta(externalIds, seerrData, type);

  // What the criteria and values are reported for: what the match was
  // selected on.
  let serialized = evaluated;
  let matches: boolean;
  if (group && !aggregateForced) {
    // Group scope: the show or artist matches when one member, seen as the
    // group carrying its own per-member values, satisfies the rules — the
    // first such member (lowest id) reported, as detection stores it. When
    // none does, the tested item's own values are reported.
    const selection = evaluateGroupThroughMembers(
      typedRules, group, groupMembers, hasMemberValueRules(typedRules), arrMeta, seerrMeta,
    );
    matches = selection !== null;
    if (selection) serialized = selection.record;
  } else {
    // A single item, or — forced aggregate — this episode on its own with the
    // series aggregates injected: the check detection makes per episode
    // (episodesMatchingIndividually). The show's own record is no gate.
    matches = evaluateAllRulesInMemory(typedRules, evaluated, arrMeta, seerrMeta);
  }

  // Get matched criteria and actual values
  const criteriaMap = getMatchedCriteriaForItems(
    [serialized],
    typedRules,
    type,
    arrData,
    seerrData
  );
  const actualValuesMap = getActualValuesForAllRules(
    [serialized],
    typedRules,
    type,
    arrData,
    seerrData
  );

  const itemId = serialized.id as string;
  const matchedCriteria = criteriaMap.get(itemId) ?? [];
  const actualValuesEntry = actualValuesMap.get(itemId);
  const actualValues = actualValuesEntry
    ? Object.fromEntries(actualValuesEntry)
    : {};

  return NextResponse.json({
    matches,
    matchedCriteria,
    actualValues,
    item: {
      id: item.id,
      title:
        seriesScope && (type === "SERIES" || type === "MUSIC")
          ? (item.parentTitle ?? item.title)
          : item.title,
      parentTitle: item.parentTitle,
      year: item.year,
      thumbUrl: item.thumbUrl,
    },
  });
});
