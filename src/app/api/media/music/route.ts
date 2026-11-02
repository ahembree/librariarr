import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { withListResponseCache } from "@/lib/api/cached-list-response";
import { jsonResponse, mapInSlices } from "@/lib/api/json-response";
import { prisma } from "@/lib/db";
import { escapeLike } from "@/lib/filters/escape-like";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters } from "@/lib/filters/build-where";
import { loadGenreSpellings } from "@/lib/filters/genre-spellings";
import { loadResolutionSpellings } from "@/lib/filters/resolution-spellings";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { parseListPagination } from "@/lib/api/pagination";
import { loadDetailScope } from "@/lib/api/detail-scope";
import { getServerPresenceByDedupKey } from "@/lib/dedup/server-presence";

// Valid MediaItem scalar sort columns; anything else falls back to title.
const SORT_COLUMNS = new Set([
  "title",
  "year",
  "parentTitle",
  "albumTitle",
  "audioCodec",
  "fileSize",
  "duration",
  "playCount",
  "lastPlayedAt",
  "addedAt",
  "rating",
  "audienceRating",
  "contentRating",
  // Every column the library table (src/components/media-table.tsx) offers a
  // sort header for. A field missing here silently sorted by title while the
  // header showed the clicked column's arrow — Dynamic Range is visible by
  // default. All are plain MediaItem columns; `{ id: "asc" }` keeps the order
  // total as with the rest.
  "resolution",
  "videoCodec",
  "dynamicRange",
  "audioProfile",
  "audioChannels",
  "container",
  "studio",
  "videoBitDepth",
  "videoFrameRate",
  "videoBitrate",
  "aspectRatio",
  "originallyAvailableAt",
]);

const listGet = withSession(async (session, request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const { page, limit, skip } = parseListPagination(searchParams);
  let parentTitle = searchParams.get("parentTitle");
  let albumTitle = searchParams.get("albumTitle");
  const search = searchParams.get("search");
  const rawSortBy = searchParams.get("sortBy") ?? "title";
  const sortBy = SORT_COLUMNS.has(rawSortBy) ? rawSortBy : "title";
  const sortOrder = searchParams.get("sortOrder") === "desc" ? "desc" : "asc";
  const serverId = searchParams.get("serverId");

  // `itemId` names an album page's record: the list is that album of its
  // artist, read here (`loadDetailScope`) so the page need not wait for the
  // record. It replaces `parentTitle` and `albumTitle`.
  const itemId = searchParams.get("itemId");
  if (itemId) {
    const scope = await loadDetailScope(session.userId, itemId, "MUSIC");
    if (!scope) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // A track with no artist or no album belongs to no album list (the page
    // listed nothing for one).
    if (!scope.parentTitle || !scope.albumTitle) {
      return NextResponse.json({ items: [], pagination: { page, limit, hasMore: false } });
    }
    parentTitle = scope.parentTitle;
    albumTitle = scope.albumTitle;
  }

  const sf = await resolveServerFilter(session.userId, serverId, "MUSIC");
  if (!sf) {
    return NextResponse.json({ items: [], pagination: { page, limit, hasMore: false } });
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "MUSIC",
  };

  if (parentTitle) where.parentTitle = parentTitle;
  if (albumTitle) where.albumTitle = albumTitle;
  // `escapeLike`: `search` becomes a LIKE pattern, and nothing else escapes
  // `%` / `_` / `\` — live, `?search=1_ Things` matched "10 Things I Hate
  // About You" and `?search=%` matched everything (see escape-like.ts).
  if (search) {
    where.OR = [
      { title: { contains: escapeLike(search), mode: "insensitive" } },
      { parentTitle: { contains: escapeLike(search), mode: "insensitive" } },
      { albumTitle: { contains: escapeLike(search), mode: "insensitive" } },
    ];
  }

  const [genreSpellings, resolutionSpellings] = await Promise.all([
    loadGenreSpellings(searchParams),
    loadResolutionSpellings(searchParams),
  ]);
  applyCommonFilters(where, searchParams, genreSpellings, resolutionSpellings);

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
    albumTitle: true,
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

  // For multi-server, attach server presence from all servers sharing dedupKey
  let serversByKey: Map<string, { serverId: string; serverName: string; serverType: string; mediaItemId: string }[]> | null = null;
  if (!sf.isSingleServer) {
    const dedupKeys = items.map((i) => i.dedupKey).filter((k): k is string => k != null);
    serversByKey = await getServerPresenceByDedupKey(dedupKeys, sf.serverIds);
  }

  const serializedItems = await mapInSlices(items, (item) => ({
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

  return jsonResponse(request, {
    items: serializedItems,
    pagination: { page, limit, hasMore },
  });
});

/**
 * Answered from the list response cache when the same listing was asked for
 * in the last minute (`withListResponseCache`).
 */
export const GET = withListResponseCache("media-music", listGet);
