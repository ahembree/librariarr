import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters, applyStartsWithFilter } from "@/lib/filters/build-where";
import { applyStreamCountFilters } from "@/lib/filters/stream-count";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { getServerPresenceByDedupKey } from "@/lib/dedup/server-presence";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") ?? "1");
  const rawLimit = parseInt(searchParams.get("limit") ?? "50");
  const limit = rawLimit === 0 ? 0 : Math.min(rawLimit, 100);
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") ?? "title";
  const sortOrder = searchParams.get("sortOrder") === "desc" ? "desc" : "asc";
  const serverId = searchParams.get("serverId");
  const startsWith = searchParams.get("startsWith");

  const sf = await resolveServerFilter(session.userId!, serverId, "MOVIE");
  if (!sf) {
    return NextResponse.json({ items: [], pagination: { page, limit, hasMore: false } });
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "MOVIE",
  };

  if (search) where.title = { contains: search, mode: "insensitive" };
  if (startsWith) applyStartsWithFilter(where, "title", startsWith);
  applyCommonFilters(where, searchParams);

  // Stream count filters (audio track count, subtitle count)
  await applyStreamCountFilters(where, searchParams, prisma);

  // Select only fields needed for card/table rendering.
  // Full item data is fetched on demand by the detail panel via /api/media/{id}.
  const selectBase = {
    id: true,
    title: true,
    titleSort: true,
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

  const items = await prisma.mediaItem.findMany({
    where,
    ...(limit > 0 ? { skip: (page - 1) * limit, take: limit + 1 } : {}),
    orderBy:
      sortBy === "title"
        ? [{ titleSort: { sort: sortOrder, nulls: "last" } }, { title: sortOrder }]
        : { [sortBy]: sortOrder },
    select: selectBase,
  });

  const hasMore = limit > 0 && items.length > limit;
  if (hasMore) items.pop();

  // For multi-server, attach server presence from all servers sharing dedupKey
  let serversByKey: Map<string, { serverId: string; serverName: string; serverType: string; mediaItemId: string }[]> | null = null;
  if (!sf.isSingleServer) {
    const dedupKeys = items.map((i) => i.dedupKey).filter((k): k is string => k != null);
    serversByKey = await getServerPresenceByDedupKey(dedupKeys);
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
    pagination: { page, limit, hasMore },
  });
}
