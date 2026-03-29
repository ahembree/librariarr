import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { resolveServerFilter } from "@/lib/dedup/server-filter";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId");
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "albumTitle";
  const sortOrder = searchParams.get("sortOrder") || "asc";
  const limitParam = searchParams.get("limit");
  const pageParam = searchParams.get("page");

  const sf = await resolveServerFilter(session.userId!, serverId, "MUSIC");
  if (!sf) {
    return NextResponse.json({ albums: [], pagination: { page: 1, limit: 50, hasMore: false } });
  }

  const where: Prisma.MediaItemWhereInput = {
    type: "MUSIC",
    library: { mediaServerId: { in: sf.serverIds } },
    ...(!sf.isSingleServer && { dedupCanonical: true }),
  };

  if (search) {
    where.OR = [
      { albumTitle: { contains: search, mode: "insensitive" } },
      { parentTitle: { contains: search, mode: "insensitive" } },
    ];
  }

  const items = await prisma.mediaItem.findMany({
    where,
    select: {
      id: true,
      albumTitle: true,
      parentTitle: true,
      audioCodec: true,
      fileSize: true,
      parentThumbUrl: true,
      library: {
        select: {
          mediaServer: { select: { id: true } },
        },
      },
    },
  });

  // Group by composite key: artistName + albumTitle
  const albumMap = new Map<
    string,
    {
      albumTitle: string;
      artistName: string;
      trackCount: number;
      totalSize: bigint;
      audioCodecCounts: Record<string, number>;
      mediaItemId: string;
    }
  >();

  for (const item of items) {
    const album = item.albumTitle ?? "Unknown Album";
    const artist = item.parentTitle ?? "Unknown Artist";
    const compositeKey = `${artist.toLowerCase().trim()}::${album.toLowerCase().trim()}`;
    let albumGroup = albumMap.get(compositeKey);
    if (!albumGroup) {
      albumGroup = {
        albumTitle: album,
        artistName: artist,
        trackCount: 0,
        totalSize: BigInt(0),
        audioCodecCounts: {},
        mediaItemId: item.id,
      };
      albumMap.set(compositeKey, albumGroup);
    }

    albumGroup.trackCount++;

    if (item.fileSize) {
      albumGroup.totalSize += item.fileSize;
    }

    const codec = item.audioCodec ? item.audioCodec.toUpperCase() : "Unknown";
    albumGroup.audioCodecCounts[codec] =
      (albumGroup.audioCodecCounts[codec] || 0) + 1;

    // Prefer items with parent thumb for the representative mediaItemId
    if (item.parentThumbUrl) {
      albumGroup.mediaItemId = item.id;
    }
  }

  const albums = Array.from(albumMap.values()).map((a) => ({
    albumTitle: a.albumTitle,
    artistName: a.artistName,
    trackCount: a.trackCount,
    totalSize: a.totalSize.toString(),
    audioCodecCounts: a.audioCodecCounts,
    mediaItemId: a.mediaItemId,
  }));

  // Sort
  const dir = sortOrder === "desc" ? -1 : 1;
  albums.sort((a, b) => {
    switch (sortBy) {
      case "artistName":
        return dir * a.artistName.localeCompare(b.artistName);
      case "trackCount":
        return dir * (a.trackCount - b.trackCount);
      case "totalSize":
        return dir * (Number(BigInt(a.totalSize) - BigInt(b.totalSize)));
      case "albumTitle":
      default:
        return dir * a.albumTitle.localeCompare(b.albumTitle);
    }
  });

  // Pagination
  const limit = limitParam !== null ? parseInt(limitParam, 10) : 50;
  const page = pageParam !== null ? Math.max(1, parseInt(pageParam, 10)) : 1;

  if (limit === 0) {
    return NextResponse.json({
      albums,
      pagination: { page: 1, limit: 0, hasMore: false },
    });
  }

  const start = (page - 1) * limit;
  const fetched = albums.slice(start, start + limit + 1);
  const hasMore = fetched.length > limit;
  if (hasMore) fetched.pop();

  return NextResponse.json({
    albums: fetched,
    pagination: { page, limit, hasMore },
  });
}
