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
      thumbUrl: true,
      parentThumbUrl: true,
      library: {
        select: {
          mediaServer: { select: { id: true } },
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
      };
      albumMap.set(normalizedKey, albumGroup);
    }

    albumGroup.trackCount++;

    if (item.fileSize) {
      albumGroup.totalSize += item.fileSize;
    }

    const codec = item.audioCodec ? item.audioCodec.toUpperCase() : "Unknown";
    albumGroup.audioCodecCounts[codec] = (albumGroup.audioCodecCounts[codec] || 0) + 1;

    if (item.parentThumbUrl) {
      albumGroup.mediaItemId = item.id;
    }
  }

  const albums = Array.from(albumMap.values())
    .map((a) => ({
      albumTitle: a.albumTitle,
      trackCount: a.trackCount,
      totalSize: a.totalSize.toString(),
      audioCodecCounts: a.audioCodecCounts,
      mediaItemId: a.mediaItemId,
    }))
    .sort((a, b) => a.albumTitle.localeCompare(b.albumTitle));

  return NextResponse.json({ albums });
}
