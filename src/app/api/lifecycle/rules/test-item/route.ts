import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import {
  evaluateAllRulesInMemory,
  getMatchedCriteriaForItems,
  getActualValuesForAllRules,
  hasArrRules,
  hasSeerrRules,
  hasAnyActiveRules,
  hasStreamRules,
} from "@/lib/rules/engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/engine";
import type { RuleGroup, Rule } from "@/lib/rules/types";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import { validateRequest, ruleTestItemSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, ruleTestItemSchema);
  if (error) return error;

  const { rules, type, seriesScope, mediaItemId, serverIds } = data;
  const typedRules = rules as unknown as Rule[] | RuleGroup[];

  if (!hasAnyActiveRules(typedRules)) {
    return NextResponse.json(
      { error: "No active rules to evaluate" },
      { status: 400 }
    );
  }

  // Fetch the item with full relations
  const item = await prisma.mediaItem.findFirst({
    where: {
      id: mediaItemId,
      library: { mediaServer: { userId: session.userId } },
    },
    include: {
      externalIds: true,
      streams: true,
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

  // Fetch Arr/Seerr metadata if needed
  let arrData: ArrDataMap | undefined;
  if (hasArrRules(typedRules)) {
    arrData = await fetchArrMetadata(session.userId!, type);
  }

  let seerrData: SeerrDataMap | undefined;
  if (hasSeerrRules(typedRules) && type !== "MUSIC") {
    seerrData = await fetchSeerrMetadata(session.userId!, type);
  }

  let serialized: Record<string, unknown>;

  // Series/music scope: aggregate all episodes/tracks of this series/artist
  if (seriesScope && (type === "SERIES" || type === "MUSIC")) {
    const groupField = item.parentTitle ?? item.title;
    const allItems = await prisma.mediaItem.findMany({
      where: {
        type,
        libraryId: item.libraryId,
        parentTitle: groupField,
        library: { mediaServerId: { in: serverIds } },
      },
      include: {
        externalIds: true,
        ...(hasStreamRules(typedRules) ? { streams: true } : {}),
        library: {
          select: {
            title: true,
            mediaServer: { select: { id: true, name: true, type: true } },
          },
        },
      },
    });

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

    serialized = {
      ...item,
      title: groupField,
      parentTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      playCount: totalPlays,
      fileSize: totalSize > BigInt(0) ? totalSize.toString() : null,
      lastPlayedAt: latestPlayed?.toISOString() ?? null,
      addedAt: earliestAdded?.toISOString() ?? null,
      originallyAvailableAt: null,
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
    };
  } else {
    // Single item evaluation
    serialized = {
      ...item,
      fileSize: item.fileSize?.toString() ?? null,
      lastPlayedAt: item.lastPlayedAt?.toISOString() ?? null,
      addedAt: item.addedAt?.toISOString() ?? null,
      originallyAvailableAt: item.originallyAvailableAt?.toISOString() ?? null,
      streams: item.streams ?? [],
    };
  }

  // Evaluate rules against the item
  const arrIdSource =
    type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";
  const seerrIdSource = type === "MOVIE" ? "TMDB" : "TVDB";
  const externalIds = (serialized.externalIds as Array<{
    source: string;
    externalId: string;
  }>) ?? [];
  const arrExtId = externalIds.find((e) => e.source === arrIdSource);
  const arrMeta =
    arrData && arrExtId ? arrData[arrExtId.externalId] : undefined;
  const seerrExtId = externalIds.find((e) => e.source === seerrIdSource);
  const seerrMeta =
    seerrData && seerrExtId ? seerrData[seerrExtId.externalId] : undefined;

  const matches = evaluateAllRulesInMemory(
    typedRules,
    serialized,
    arrMeta,
    seerrMeta
  );

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
}
