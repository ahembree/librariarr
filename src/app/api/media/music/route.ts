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
import { wantsListIndex } from "@/lib/media/list-index";
import { ARTIST_KEY_SQL, UNKNOWN_ARTIST, albumArtistKeySql, albumTitleKeySql } from "@/lib/media/music-sql";

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
  const withIndex = wantsListIndex(searchParams);
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
  let album: { artist: string | null; album: string | null } | null = null;
  if (itemId) {
    const scope = await loadDetailScope(session.userId, itemId, "MUSIC");
    if (!scope) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    album = { artist: scope.parentTitle, album: scope.albumTitle };
    parentTitle = null;
    albumTitle = null;
  }

  const sf = await resolveServerFilter(session.userId, serverId, "MUSIC");
  if (!sf) {
    return NextResponse.json({
      items: [],
      pagination: { page, limit, hasMore: false },
      ...(withIndex && { index: { total: 0 } }),
    });
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "MUSIC",
  };

  if (parentTitle) where.parentTitle = parentTitle;
  if (albumTitle) where.albumTitle = albumTitle;
  if (album) {
    // The album as the card that opens this page groups it (`artist::album`,
    // each lower-cased and trimmed, a missing title in its placeholder group —
    // see `albumTitleKeySql`), resolved to the stored spellings so the where
    // stays exact. Matching the record's own spellings listed fewer tracks than
    // a card merged from "Abbey Road" and "abbey road ", and nothing at all for
    // the "Unknown Album" card of tracks with no album. The artist is matched
    // as `ARTIST_KEY_SQL` (plus the NULL artist for "Unknown Artist") — the same
    // test as `albumArtistKeySql` on both sides, in the form the expression
    // index on `LOWER(TRIM("parentTitle"))` serves.
    const spellings = await prisma.$queryRawUnsafe<{ parentTitle: string | null; albumTitle: string | null }[]>(
      `SELECT DISTINCT mi."parentTitle", mi."albumTitle"
       FROM "MediaItem" mi
       JOIN "Library" l ON mi."libraryId" = l.id
       WHERE mi.type = 'MUSIC'::"LibraryType"
         AND l."mediaServerId" = ANY($1::text[])
         AND (${ARTIST_KEY_SQL} = ${albumArtistKeySql(`$2::text`)}
           OR (mi."parentTitle" IS NULL AND ${albumArtistKeySql(`$2::text`)} = '${UNKNOWN_ARTIST.toLowerCase()}'))
         AND ${albumTitleKeySql(`mi."albumTitle"`)} = ${albumTitleKeySql(`$3::text`)}`,
      sf.serverIds,
      album.artist,
      album.album,
    );
    where.AND = [{ OR: spellings.map((s) => ({ parentTitle: s.parentTitle, albumTitle: s.albumTitle })) }];
  }
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

  // The index (`?index=1`, the All Tracks tab's first page): the count it
  // sizes its list with, beside the page.
  const [items, total] = await Promise.all([
    prisma.mediaItem.findMany({
      where,
      ...(limit > 0 ? { skip, take: limit + 1 } : { skip }),
      // `id` is the tiebreaker, not decoration: without a total order Postgres is
      // free to return tied rows in any order, and the pages of a listing are
      // planned differently (bounded top-N heapsort vs full quicksort or external
      // merge). The tie block straddling a page boundary then permutes between
      // the requests, so the paged list shows some rows twice and drops others
      // entirely. Reproduced at 80 duplicated / 80 missing out of 20k rows.
      orderBy: [{ [sortBy]: sortOrder }, { id: "asc" as const }],
      select: selectBase,
    }),
    withIndex ? prisma.mediaItem.count({ where }) : null,
  ]);

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
    ...(total !== null && { index: { total } }),
  });
});

/**
 * Answered from the list response cache when the same listing was asked for
 * in the last minute (`withListResponseCache`).
 */
export const GET = withListResponseCache("media-music", listGet);
