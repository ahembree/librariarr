import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters } from "@/lib/filters/build-where";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { parseListPagination } from "@/lib/api/pagination";
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
  const { page, limit, skip } = parseListPagination(searchParams);
  const search = searchParams.get("search");
  // `seriesKey` (series identity) is preferred; `parentTitle` stays as a
  // backward-compatible fallback (ambiguous across same-titled shows).
  const seriesKey = searchParams.get("seriesKey");
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

  if (seriesKey) where.seriesKey = seriesKey;
  else if (parentTitle) where.parentTitle = parentTitle;
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

  // `total` is part of this route's contract, but the COUNT(*) behind it is a
  // filtered scan of the largest table in the schema. It is only *needed* when a
  // page size is set (to derive `pages`); when the caller asked for everything
  // after `skip`, the total is exactly `skip + items.length`. Deriving it there
  // removes one of the two counts a progressive page load used to pay.
  const items = await prisma.mediaItem.findMany({
    where,
    ...(limit > 0 ? { skip, take: limit + 1 } : { skip }),
    // `id` is the tiebreaker, not decoration: without a total order Postgres is
    // free to return tied rows in any order, and the two passes of a progressive
    // load are planned differently (bounded top-N heapsort vs full quicksort or
    // external merge). The tie block straddling the page boundary then permutes
    // between the passes, so the stitched list shows some rows twice and drops
    // others entirely. Reproduced at 80 duplicated / 80 missing out of 20k rows.
    orderBy: [{ [sortBy]: sortOrder }, { id: "asc" as const }],
    select: selectBase,
  });

  const hasMore = limit > 0 && items.length > limit;
  if (hasMore) items.pop();

  const total = limit > 0 ? await prisma.mediaItem.count({ where }) : skip + items.length;

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
