import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters } from "@/lib/filters/build-where";
import { resolveServerFilter } from "@/lib/dedup/server-filter";

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

  const sf = await resolveServerFilter(session.userId!, serverId, "MUSIC");
  if (!sf) {
    return NextResponse.json({ albums: [] });
  }

  const where: Prisma.MediaItemWhereInput = {
    type: "MUSIC",
    parentTitle,
    library: { mediaServerId: { in: sf.serverIds } },
    ...(!sf.isSingleServer && { dedupCanonical: true }),
  };

  applyCommonFilters(where, searchParams);

  const items = await prisma.mediaItem.findMany({
    where,
    select: {
      id: true,
      title: true,
      albumTitle: true,
      audioCodec: true,
      fileSize: true,
      playCount: true,
      lastPlayedAt: true,
      addedAt: true,
      thumbUrl: true,
      parentThumbUrl: true,
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

  // Group by album title (canonical items are already deduped)
  const albumMap = new Map<
    string,
    {
      albumTitle: string;
      trackCount: number;
      totalSize: bigint;
      audioCodecCounts: Record<string, number>;
      mediaItemId: string;
      totalPlayCount: number;
      lastPlayed: Date | null;
      addedAt: Date | null;
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
    const album = item.albumTitle ?? "Unknown Album";
    const normalizedKey = album.toLowerCase().trim();
    let albumGroup = albumMap.get(normalizedKey);
    if (!albumGroup) {
      albumGroup = {
        albumTitle: album,
        trackCount: 0,
        totalSize: BigInt(0),
        audioCodecCounts: {},
        mediaItemId: item.id,
        totalPlayCount: 0,
        lastPlayed: null,
        addedAt: null,
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
      albumMap.set(normalizedKey, albumGroup);
    }

    albumGroup.trackCount++;

    if (item.fileSize) {
      albumGroup.totalSize += item.fileSize;
    }

    albumGroup.totalPlayCount += item.playCount;
    if (item.lastPlayedAt && (!albumGroup.lastPlayed || item.lastPlayedAt > albumGroup.lastPlayed)) {
      albumGroup.lastPlayed = item.lastPlayedAt;
    }
    if (item.addedAt && (!albumGroup.addedAt || item.addedAt > albumGroup.addedAt)) {
      albumGroup.addedAt = item.addedAt;
    }

    const codec = item.audioCodec ? item.audioCodec.toUpperCase() : "Unknown";
    albumGroup.audioCodecCounts[codec] = (albumGroup.audioCodecCounts[codec] || 0) + 1;

    if (item.parentThumbUrl) {
      albumGroup.mediaItemId = item.id;
    }

    if (!albumGroup.summary && item.summary) albumGroup.summary = item.summary;
    if (!albumGroup.genres && item.genres) albumGroup.genres = item.genres as string[];
    if (!albumGroup.studio && item.studio) albumGroup.studio = item.studio;
    if (!albumGroup.contentRating && item.contentRating) albumGroup.contentRating = item.contentRating;
    if (albumGroup.rating == null && item.rating != null) albumGroup.rating = item.rating;
    if (!albumGroup.ratingImage && item.ratingImage) albumGroup.ratingImage = item.ratingImage;
    if (albumGroup.audienceRating == null && item.audienceRating != null) albumGroup.audienceRating = item.audienceRating;
    if (!albumGroup.audienceRatingImage && item.audienceRatingImage) albumGroup.audienceRatingImage = item.audienceRatingImage;
    if (albumGroup.year == null && item.year != null) albumGroup.year = item.year;

    const server = item.library.mediaServer;
    if (server && !albumGroup.servers.some((s) => s.serverId === server.id)) {
      albumGroup.servers.push({ serverId: server.id, serverName: server.name, serverType: server.type });
    }
  }

  const albums = Array.from(albumMap.values())
    .map((a) => ({
      albumTitle: a.albumTitle,
      trackCount: a.trackCount,
      totalSize: a.totalSize.toString(),
      audioCodecCounts: a.audioCodecCounts,
      mediaItemId: a.mediaItemId,
      totalPlayCount: a.totalPlayCount,
      lastPlayed: a.lastPlayed,
      addedAt: a.addedAt,
      servers: a.servers,
      summary: a.summary,
      genres: a.genres,
      studio: a.studio,
      contentRating: a.contentRating,
      rating: a.rating,
      ratingImage: a.ratingImage,
      audienceRating: a.audienceRating,
      audienceRatingImage: a.audienceRatingImage,
      year: a.year,
    }))
    .sort((a, b) => a.albumTitle.localeCompare(b.albumTitle));

  return NextResponse.json({ albums });
}
