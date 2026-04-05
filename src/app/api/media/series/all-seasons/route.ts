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
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "parentTitle";
  const sortOrder = searchParams.get("sortOrder") || "asc";
  const serverId = searchParams.get("serverId");

  const sf = await resolveServerFilter(session.userId!, serverId, "SERIES");
  if (!sf) {
    return NextResponse.json({ seasons: [] });
  }

  const whereClause: Record<string, unknown> = {
    type: "SERIES" as const,
    parentTitle: { not: null },
    library: { mediaServerId: { in: sf.serverIds } },
  };

  if (search) {
    whereClause.OR = [
      { parentTitle: { contains: search, mode: "insensitive", not: null } },
    ];
  }

  // For multi-server, only fetch canonical items (pre-deduped)
  if (!sf.isSingleServer) {
    whereClause.dedupCanonical = true;
  }

  const items = await prisma.mediaItem.findMany({
    where: whereClause,
    select: {
      id: true,
      parentTitle: true,
      seasonNumber: true,
      episodeNumber: true,
      resolution: true,
      fileSize: true,
      lastPlayedAt: true,
      addedAt: true,
      playCount: true,
      thumbUrl: true,
      seasonThumbUrl: true,
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

  // Group by parentTitle + seasonNumber (canonical items are already deduped)
  const seasonMap = new Map<
    string,
    {
      parentTitle: string;
      seasonNumber: number;
      mediaItemId: string;
      episodeCount: number;
      totalSize: bigint;
      lastPlayed: Date | null;
      addedAt: Date | null;
      totalPlayCount: number;
      qualityCounts: Record<string, number>;
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
    const title = item.parentTitle!;
    const sn = item.seasonNumber ?? 0;
    const key = `${title.toLowerCase().trim()}::${sn}`;
    let season = seasonMap.get(key);
    if (!season) {
      season = {
        parentTitle: title,
        seasonNumber: sn,
        mediaItemId: item.id,
        episodeCount: 0,
        totalSize: BigInt(0),
        lastPlayed: null,
        addedAt: null,
        totalPlayCount: 0,
        qualityCounts: {},
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
      seasonMap.set(key, season);
    }

    season.episodeCount++;

    if (item.fileSize) {
      season.totalSize += item.fileSize;
    }

    if (item.lastPlayedAt && (!season.lastPlayed || item.lastPlayedAt > season.lastPlayed)) {
      season.lastPlayed = item.lastPlayedAt;
    }

    if (item.addedAt && (!season.addedAt || item.addedAt > season.addedAt)) {
      season.addedAt = item.addedAt;
    }

    season.totalPlayCount += item.playCount;

    if (item.seasonThumbUrl) {
      season.mediaItemId = item.id;
    }

    const label = getResolutionLabel(item.resolution);
    season.qualityCounts[label] = (season.qualityCounts[label] || 0) + 1;

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

  const seasonsList = Array.from(seasonMap.values())
    .map((s) => ({
      parentTitle: s.parentTitle,
      seasonNumber: s.seasonNumber,
      mediaItemId: s.mediaItemId,
      episodeCount: s.episodeCount,
      totalSize: s.totalSize.toString(),
      lastPlayed: s.lastPlayed,
      addedAt: s.addedAt,
      totalPlayCount: s.totalPlayCount,
      qualityCounts: s.qualityCounts,
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
    .sort((a, b) => {
      const dir = sortOrder === "desc" ? -1 : 1;
      switch (sortBy) {
        case "episodeCount":
          return (a.episodeCount - b.episodeCount) * dir;
        case "totalSize":
          return (Number(a.totalSize) - Number(b.totalSize)) * dir;
        case "lastPlayed": {
          const aTime = a.lastPlayed ? new Date(a.lastPlayed).getTime() : 0;
          const bTime = b.lastPlayed ? new Date(b.lastPlayed).getTime() : 0;
          return (aTime - bTime) * dir;
        }
        case "addedAt": {
          const aTime = a.addedAt ? new Date(a.addedAt).getTime() : 0;
          const bTime = b.addedAt ? new Date(b.addedAt).getTime() : 0;
          return (aTime - bTime) * dir;
        }
        case "seasonNumber":
          return (a.seasonNumber - b.seasonNumber) * dir || a.parentTitle.localeCompare(b.parentTitle);
        default:
          return a.parentTitle.localeCompare(b.parentTitle) * dir || a.seasonNumber - b.seasonNumber;
      }
    });

  return NextResponse.json({ seasons: seasonsList });
}
