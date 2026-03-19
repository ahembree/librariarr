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
      playCount: true,
      library: {
        select: {
          mediaServer: { select: { id: true } },
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
      totalPlayCount: number;
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
        totalPlayCount: 0,
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
    season.totalPlayCount += item.playCount;

    if (item.seasonThumbUrl) {
      season.mediaItemId = item.id;
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
      totalPlayCount: s.totalPlayCount,
    }))
    .sort((a, b) => a.seasonNumber - b.seasonNumber);

  return NextResponse.json({ seasons });
}
