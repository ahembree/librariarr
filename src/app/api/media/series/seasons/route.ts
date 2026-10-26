import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/api/json-response";
import { loadDetailScope, seriesOfScope } from "@/lib/api/detail-scope";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { loadMissingSummaries } from "@/lib/media/group-summaries";

function getResolutionLabel(resolution: string | null): string {
  return normalizeResolutionLabel(resolution);
}

/**
 * An episode carrying a blurb: its show's (`parentSummary`) or its own, blank
 * text counting as none — what the fold below takes a season's summary from.
 */
const HAS_SUMMARY: Prisma.MediaItemWhereInput = {
  OR: [
    { AND: [{ parentSummary: { not: null } }, { NOT: { parentSummary: "" } }] },
    { AND: [{ summary: { not: null } }, { NOT: { summary: "" } }] },
  ],
};

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // Series identity is `seriesKey` (see src/lib/media/series-key.ts); the legacy
  // `parentTitle` param is still accepted so old links keep working, but it is
  // ambiguous (two shows can share a title), so `seriesKey` wins when both are
  // present. `itemId` names the show page's record instead, and its series is
  // read here (`loadDetailScope`) so the page need not wait for the record.
  const itemId = searchParams.get("itemId");
  let seriesKey = searchParams.get("seriesKey");
  let parentTitle = searchParams.get("parentTitle");
  const serverId = searchParams.get("serverId");

  if (itemId) {
    const scope = await loadDetailScope(session.userId!, itemId, "SERIES");
    if (!scope) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const series = seriesOfScope(scope);
    seriesKey = "seriesKey" in series ? series.seriesKey : null;
    parentTitle = "parentTitle" in series ? series.parentTitle : null;
  }

  if (!seriesKey && !parentTitle) {
    return NextResponse.json({ error: "seriesKey or parentTitle is required" }, { status: 400 });
  }

  const sf = await resolveServerFilter(session.userId!, serverId, "SERIES");
  if (!sf) {
    return NextResponse.json({ seasons: [] });
  }

  const where: Prisma.MediaItemWhereInput = {
    type: "SERIES",
    ...(seriesKey ? { seriesKey } : { parentTitle: parentTitle! }),
    library: { mediaServerId: { in: sf.serverIds } },
    ...(!sf.isSingleServer && { dedupCanonical: true }),
  };

  // The episodes without their blurbs, beside the ids of the ones that have
  // one: the fold keeps one summary per season out of every episode's, so
  // reading the prose of every episode (two paragraphs each, for hundreds of
  // episodes) to use a dozen was most of what this route transferred. The
  // dozen are read by id afterwards (`loadMissingSummaries`).
  const [items, summarised] = await Promise.all([
    prisma.mediaItem.findMany({
      where,
      select: {
        id: true,
        seasonNumber: true,
        episodeNumber: true,
        resolution: true,
        fileSize: true,
        thumbUrl: true,
        seasonThumbUrl: true,
        lastPlayedAt: true,
        addedAt: true,
        playCount: true,
        genres: true,
        studio: true,
        contentRating: true,
        rating: true,
        ratingImage: true,
        audienceRating: true,
        audienceRatingImage: true,
        year: true,
        library: {
          select: {
            mediaServer: { select: { id: true, name: true, type: true } },
          },
        },
      },
      // The fold below keeps the FIRST episode carrying each field (summary, year,
      // rating, the linked item), so the rows need a fixed order: unordered,
      // Postgres returned them in heap order and an UPDATE could change which
      // episode's values a season showed.
      orderBy: [
        { seasonNumber: { sort: "asc", nulls: "last" } },
        { episodeNumber: { sort: "asc", nulls: "last" } },
        { id: "asc" },
      ],
    }),
    prisma.mediaItem.findMany({ where: { AND: [where, HAS_SUMMARY] }, select: { id: true } }),
  ]);
  const hasSummary = new Set(summarised.map((row) => row.id));

  // Group by season number (canonical items are already deduped)
  const seasonMap = new Map<
    number,
    {
      seasonNumber: number;
      episodeCount: number;
      totalSize: bigint;
      qualityCounts: Record<string, number>;
      mediaItemId: string;
      lastPlayed: Date | null;
      addedAt: Date | null;
      totalPlayCount: number;
      servers: { serverId: string; serverName: string; serverType: string }[];
      /** The first episode, in episode order, that has a summary. */
      summaryItemId: string | null;
      genres: string[] | null;
      studio: string | null;
      contentRating: string | null;
      rating: number | null;
      ratingImage: string | null;
      audienceRating: number | null;
      audienceRatingImage: string | null;
      year: number | null;
    }
  >();

  for (const item of items) {
    const sn = item.seasonNumber ?? 0;
    let season = seasonMap.get(sn);
    if (!season) {
      season = {
        seasonNumber: sn,
        episodeCount: 0,
        totalSize: BigInt(0),
        qualityCounts: {},
        mediaItemId: item.id,
        lastPlayed: null,
        addedAt: null,
        totalPlayCount: 0,
        servers: [],
        summaryItemId: null,
        genres: null,
        studio: null,
        contentRating: null,
        rating: null,
        ratingImage: null,
        audienceRating: null,
        audienceRatingImage: null,
        year: null,
      };
      seasonMap.set(sn, season);
    }

    season.episodeCount++;

    if (item.fileSize) {
      season.totalSize += item.fileSize;
    }

    const label = getResolutionLabel(item.resolution);
    season.qualityCounts[label] = (season.qualityCounts[label] || 0) + 1;

    if (
      item.lastPlayedAt &&
      (!season.lastPlayed || item.lastPlayedAt > season.lastPlayed)
    ) {
      season.lastPlayed = item.lastPlayedAt;
    }
    if (item.addedAt && (!season.addedAt || item.addedAt > season.addedAt)) {
      season.addedAt = item.addedAt;
    }
    season.totalPlayCount += item.playCount;

    if (item.seasonThumbUrl) {
      season.mediaItemId = item.id;
    }

    if (!season.summaryItemId && hasSummary.has(item.id)) season.summaryItemId = item.id;
    if (!season.genres && item.genres) season.genres = item.genres as string[];
    if (!season.studio && item.studio) season.studio = item.studio;
    if (!season.contentRating && item.contentRating) season.contentRating = item.contentRating;
    if (season.rating == null && item.rating != null) season.rating = item.rating;
    if (!season.ratingImage && item.ratingImage) season.ratingImage = item.ratingImage;
    if (season.audienceRating == null && item.audienceRating != null) season.audienceRating = item.audienceRating;
    if (!season.audienceRatingImage && item.audienceRatingImage) season.audienceRatingImage = item.audienceRatingImage;
    if (season.year == null && item.year != null) season.year = item.year;

    const server = item.library.mediaServer;
    if (server && !season.servers.some((s) => s.serverId === server.id)) {
      season.servers.push({ serverId: server.id, serverName: server.name, serverType: server.type });
    }
  }

  // The show's blurb where an episode has it, else the episode's own — the
  // order the fold read `parentSummary || summary` in.
  const summaries = await loadMissingSummaries(
    [...seasonMap.values()].flatMap((s) => (s.summaryItemId ? [[String(s.seasonNumber), s.summaryItemId] as const] : [])),
    "show",
  );

  const seasons = Array.from(seasonMap.values())
    .map((s) => ({
      seasonNumber: s.seasonNumber,
      episodeCount: s.episodeCount,
      totalSize: s.totalSize.toString(),
      qualityCounts: s.qualityCounts,
      mediaItemId: s.mediaItemId,
      lastPlayed: s.lastPlayed,
      addedAt: s.addedAt,
      totalPlayCount: s.totalPlayCount,
      servers: s.servers,
      summary: summaries.get(String(s.seasonNumber)) ?? null,
      genres: s.genres,
      studio: s.studio,
      contentRating: s.contentRating,
      rating: s.rating,
      ratingImage: s.ratingImage,
      audienceRating: s.audienceRating,
      audienceRatingImage: s.audienceRatingImage,
      year: s.year,
    }))
    .sort((a, b) => a.seasonNumber - b.seasonNumber);

  return jsonResponse(request, { seasons });
}
