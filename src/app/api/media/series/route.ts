import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters } from "@/lib/filters/build-where";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { getServerPresenceByDedupKey } from "@/lib/dedup/server-presence";

// Valid MediaItem scalar sort columns; anything else falls back to title.
const SORT_COLUMNS = new Set([
  "title",
  "year",
  "parentTitle",
  "seasonNumber",
  "episodeNumber",
  "resolution",
  "videoCodec",
  "audioCodec",
  "fileSize",
  "duration",
  "playCount",
  "lastPlayedAt",
  "addedAt",
  "rating",
  "audienceRating",
  "contentRating",
]);

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
  const rawLimit = parseInt(searchParams.get("limit") ?? "50");
  // 0 = "return all"; otherwise clamp to [1, 100]. A negative value previously
  // produced a Prisma reverse-take and an always-true hasMore.
  const limit = rawLimit === 0 ? 0 : Math.max(1, Math.min(Number.isNaN(rawLimit) ? 50 : rawLimit, 100));
  const search = searchParams.get("search");
  const parentTitle = searchParams.get("parentTitle");
  const seasonNumber = searchParams.get("seasonNumber");
  const rawSortBy = searchParams.get("sortBy") ?? "title";
  const sortBy = SORT_COLUMNS.has(rawSortBy) ? rawSortBy : "title";
  const sortOrder = searchParams.get("sortOrder") === "desc" ? "desc" : "asc";
  const serverId = searchParams.get("serverId");

  const sf = await resolveServerFilter(session.userId!, serverId, "SERIES");
  if (!sf) {
    return NextResponse.json({ items: [], pagination: { page, limit, total: 0, pages: 0, hasMore: false } });
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "SERIES",
  };

  if (parentTitle) where.parentTitle = parentTitle;
  if (seasonNumber) {
    const n = parseInt(seasonNumber);
    if (Number.isNaN(n)) {
      return NextResponse.json({ error: "seasonNumber must be an integer" }, { status: 400 });
    }
    where.seasonNumber = n;
  }
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { parentTitle: { contains: search, mode: "insensitive" } },
    ];
  }

  applyCommonFilters(where, searchParams);

  // Select only fields needed for card/table rendering.
  // Full item data is fetched on demand by the detail panel via /api/media/{id}.
  const selectBase = {
    id: true,
    title: true,
    year: true,
    type: true,
    parentTitle: true,
    seasonNumber: true,
    episodeNumber: true,
    resolution: true,
    dynamicRange: true,
    videoCodec: true,
    videoBitDepth: true,
    videoFrameRate: true,
    videoBitrate: true,
    aspectRatio: true,
    audioCodec: true,
    audioChannels: true,
    audioProfile: true,
    container: true,
    fileSize: true,
    duration: true,
    playCount: true,
    lastPlayedAt: true,
    addedAt: true,
    originallyAvailableAt: true,
    contentRating: true,
    rating: true,
    ratingImage: true,
    audienceRating: true,
    audienceRatingImage: true,
    summary: true,
    genres: true,
    studio: true,
    dedupKey: true,
    dedupCanonical: true,
    library: {
      select: {
        title: true,
        mediaServer: { select: { id: true, name: true, type: true } },
      },
    },
  };

  // For multi-server, filter to canonical items only (pre-computed dedup)
  if (!sf.isSingleServer) {
    where.dedupCanonical = true;
  }

  const [items, total] = await Promise.all([
    prisma.mediaItem.findMany({
      where,
      ...(limit > 0 ? { skip: (page - 1) * limit, take: limit + 1 } : {}),
      orderBy: { [sortBy]: sortOrder },
      select: selectBase,
    }),
    prisma.mediaItem.count({ where }),
  ]);

  const hasMore = limit > 0 && items.length > limit;
  if (hasMore) items.pop();

  // For multi-server, attach server presence from all servers sharing dedupKey
  let serversByKey: Map<string, { serverId: string; serverName: string; serverType: string; mediaItemId: string }[]> | null = null;
  if (!sf.isSingleServer) {
    const dedupKeys = items.map((i) => i.dedupKey).filter((k): k is string => k != null);
    serversByKey = await getServerPresenceByDedupKey(dedupKeys, sf.serverIds);
  }

  const serializedItems = items.map((item) => ({
    ...item,
    fileSize: item.fileSize?.toString() ?? null,
    servers: serversByKey?.get(item.dedupKey!) ?? [
      {
        serverId: item.library.mediaServer!.id,
        serverName: item.library.mediaServer!.name,
        serverType: item.library.mediaServer!.type,
      },
    ],
  }));

  return NextResponse.json({
    items: serializedItems,
    pagination: { page, limit, total, pages: limit > 0 ? Math.ceil(total / limit) : 1, hasMore },
  });
}
