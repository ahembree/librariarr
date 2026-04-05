import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { resolveServerFilter } from "@/lib/dedup/server-filter";

function getResolutionLabel(resolution: string | null): string {
  return normalizeResolutionLabel(resolution);
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parentTitle = searchParams.get("parentTitle");
  const serverId = searchParams.get("serverId");

  if (!parentTitle) {
    return NextResponse.json({ error: "parentTitle is required" }, { status: 400 });
  }

  const sf = await resolveServerFilter(session.userId!, serverId, "SERIES");
  if (!sf) {
    return NextResponse.json({ seasons: [] });
  }

  const items = await prisma.mediaItem.findMany({
    where: {
      type: "SERIES",
      parentTitle,
      library: { mediaServerId: { in: sf.serverIds } },
      ...(!sf.isSingleServer && { dedupCanonical: true }),
    },
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
      summary: true,
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
  });

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
      summary: string | null;
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
        summary: null,
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

    if (!season.summary && item.summary) season.summary = item.summary;
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
      summary: s.summary,
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

  return NextResponse.json({ seasons });
}
