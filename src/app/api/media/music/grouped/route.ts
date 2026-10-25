import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { withListResponseCache } from "@/lib/api/cached-list-response";
import { jsonResponse } from "@/lib/api/json-response";
import { MAX_GROUPED_LIST_LIMIT, parseListPagination } from "@/lib/api/pagination";
import { prisma } from "@/lib/db";
import { escapeLike } from "@/lib/filters/escape-like";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters, applyStartsWithFilter } from "@/lib/filters/build-where";
import { loadGenreSpellings } from "@/lib/filters/genre-spellings";
import { loadResolutionSpellings } from "@/lib/filters/resolution-spellings";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { getServerPresenceByGroup } from "@/lib/dedup/server-presence";
import { firstNonNullSql } from "@/lib/media/series-sql";
import { loadMissingSummaries } from "@/lib/media/group-summaries";
import { ARTIST_KEY_SQL, audioCodecLabelSql, foldCodecCounts, type CodecCountRow } from "@/lib/media/music-sql";

interface ArtistGroupRow {
  group_key: string;
  parentTitle: string;
  trackCount: number;
  albumCount: number;
  totalSize: string;
  lastPlayed: Date | null;
  addedAt: Date | null;
  genres: unknown;
  studio: string | null;
  contentRating: string | null;
  rating: number | null;
  ratingImage: string | null;
  audienceRating: number | null;
  audienceRatingImage: string | null;
  year: number | null;
  summaryItemId: string | null;
}

interface ArtistRepresentativeRow {
  group_key: string;
  mediaItemId: string;
  parentTitle: string;
  thumbUrl: string | null;
  summary: string | null;
}

async function listGet(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // The shared parser, so `offset` (documented for every paged listing, and
  // what an offset-based client pages with) is honoured here too: these routes
  // used to read only `page`, and `?limit=50&offset=50` answered page 1 again
  // with `hasMore: true` — a client paging by offset looped forever. "All" is
  // `isFullListingLimit` inside it, so the API-key guard's charge for a full
  // listing cannot drift from this route.
  const { page, limit, skip } = parseListPagination(searchParams, { maxLimit: MAX_GROUPED_LIST_LIMIT });
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "parentTitle";
  const sortOrder = searchParams.get("sortOrder") || "asc";
  const serverId = searchParams.get("serverId");
  const startsWith = searchParams.get("startsWith");

  const sf = await resolveServerFilter(session.userId!, serverId, "MUSIC");
  if (!sf) {
    return NextResponse.json({ artists: [], pagination: { page, limit, hasMore: false } });
  }

  const whereClause: Prisma.MediaItemWhereInput = {
    type: "MUSIC" as const,
    parentTitle: { not: null },
    library: { mediaServerId: { in: sf.serverIds } },
  };

  // `escapeLike`: `search` becomes a LIKE pattern, and nothing else escapes
  // `%` / `_` / `\` — live, `?search=1_ Things` matched "10 Things I Hate
  // About You" and `?search=%` matched everything (see escape-like.ts).
  if (search) {
    whereClause.parentTitle = {
      contains: escapeLike(search),
      mode: "insensitive",
      not: null,
    };
  }

  if (startsWith) applyStartsWithFilter(whereClause, "parentTitle", startsWith);
  const [genreSpellings, resolutionSpellings] = await Promise.all([
    loadGenreSpellings(searchParams),
    loadResolutionSpellings(searchParams),
  ]);
  applyCommonFilters(whereClause, searchParams, genreSpellings, resolutionSpellings);

  // For multi-server, only fetch canonical items (pre-deduped)
  if (!sf.isSingleServer) {
    whereClause.dedupCanonical = true;
  }

  // Aggregated in SQL, like the series listings. This route used to load
  // every track — 20 columns and its server through a relation — into Node and
  // fold them in JS: measured at 550–800 ms on a 40k-track library, nearly all
  // of it Prisma materialising rows the fold then threw away, against ~60 ms
  // for the GROUP BY. The filters stay Prisma's: `applyCommonFilters` builds a
  // Prisma where that has no SQL form here, so when one narrows the listing
  // Prisma resolves just the matching ids (~40 ms for 40k) and the aggregate
  // runs over those. Without a filter the base predicate below is the whole
  // where, and the id round trip is skipped.
  const narrowing: Prisma.MediaItemWhereInput = {};
  applyCommonFilters(narrowing, searchParams, genreSpellings, resolutionSpellings);
  const filtered = !!search || !!startsWith || Object.keys(narrowing).length > 0;
  const matchingIds = filtered
    ? (await prisma.mediaItem.findMany({ where: whereClause, select: { id: true } })).map((r) => r.id)
    : null;

  const artworkServerId = sf.preferredArtworkServerId ?? sf.preferredTitleServerId ?? "";
  const params: unknown[] = [sf.serverIds];
  const conditions = [
    `mi.type = 'MUSIC'::"LibraryType"`,
    `mi."parentTitle" IS NOT NULL`,
    `l."mediaServerId" = ANY($1::text[])`,
  ];
  if (!sf.isSingleServer) conditions.push(`mi."dedupCanonical" = true`);
  if (matchingIds) {
    params.push(matchingIds);
    conditions.push(`mi.id = ANY($${params.length}::text[])`);
  }
  const scope = `
      FROM "MediaItem" mi
      JOIN "Library" l ON mi."libraryId" = l.id
      WHERE ${conditions.join("\n        AND ")}`;

  // "First" in track order. The fold took the first non-null value in whatever
  // order the rows arrived (the query had no ORDER BY); artist-level fields
  // are the same on every track, so this keeps that answer and makes it stable.
  const trackOrder = `"albumTitle", "seasonNumber", "episodeNumber", id`;
  const first = (col: string) => firstNonNullSql(col, trackOrder);

  // `ORDER BY group_key`: the list is sorted below with a stable sort, so
  // this is the order of ties — artists with equal track counts — and a page
  // boundary falls in the same place on every request.
  const [groups, representatives, codecRows, groupServerPresence] = await Promise.all([
    prisma.$queryRawUnsafe<ArtistGroupRow[]>(
      `SELECT
        group_key,
        MIN("parentTitle") as "parentTitle",
        COUNT(*)::int as "trackCount",
        COUNT(DISTINCT NULLIF("albumTitle", ''))::int as "albumCount",
        COALESCE(SUM("fileSize"), 0)::text as "totalSize",
        MAX("lastPlayedAt") as "lastPlayed",
        MAX("addedAt") as "addedAt",
        ${first(`"genres"`)} as "genres",
        ${first(`NULLIF("studio", '')`)} as "studio",
        ${first(`NULLIF("contentRating", '')`)} as "contentRating",
        ${first(`"rating"`)} as "rating",
        ${first(`NULLIF("ratingImage", '')`)} as "ratingImage",
        ${first(`"audienceRating"`)} as "audienceRating",
        ${first(`NULLIF("audienceRatingImage", '')`)} as "audienceRatingImage",
        ${first(`"year"`)} as "year",
        (array_agg(id ORDER BY ${trackOrder}) FILTER (WHERE NULLIF("summary", '') IS NOT NULL))[1] as "summaryItemId"
      FROM (
        SELECT ${ARTIST_KEY_SQL} as group_key, mi.id, mi."parentTitle", mi."albumTitle",
          mi."seasonNumber", mi."episodeNumber", mi."fileSize", mi."lastPlayedAt", mi."addedAt",
          mi."summary", mi."genres", mi."studio", mi."contentRating", mi."rating", mi."ratingImage",
          mi."audienceRating", mi."audienceRatingImage", mi."year"
        ${scope}
      ) tracks
      GROUP BY group_key
      ORDER BY group_key`,
      ...params,
    ),
    // One row per artist for its artwork (the page asks for it with
    // `?type=parent`): a track on the artwork-preferred server that has art,
    // then any track with album art, then any with a thumb — the fold's
    // order — then the first track.
    prisma.$queryRawUnsafe<ArtistRepresentativeRow[]>(
      `SELECT DISTINCT ON (${ARTIST_KEY_SQL})
        ${ARTIST_KEY_SQL} as group_key,
        mi.id as "mediaItemId",
        mi."parentTitle",
        COALESCE(mi."parentThumbUrl", mi."thumbUrl") as "thumbUrl",
        NULLIF(mi."summary", '') as "summary"
      ${scope}
      ORDER BY ${ARTIST_KEY_SQL},
        (l."mediaServerId" = $${params.length + 1} AND COALESCE(mi."parentThumbUrl", mi."thumbUrl") IS NOT NULL) DESC,
        (mi."parentThumbUrl" IS NOT NULL) DESC,
        (mi."thumbUrl" IS NOT NULL) DESC,
        mi."albumTitle", mi."seasonNumber", mi."episodeNumber", mi.id`,
      ...params,
      artworkServerId,
    ),
    prisma.$queryRawUnsafe<CodecCountRow[]>(
      `SELECT ${ARTIST_KEY_SQL} as group_key, ${audioCodecLabelSql(`mi."audioCodec"`)} as codec, COUNT(*)::int as n
      ${scope}
      GROUP BY 1, 2`,
      ...params,
    ),
    sf.isSingleServer ? null : getServerPresenceByGroup("MUSIC", sf.serverIds),
  ]);

  const repByKey = new Map(representatives.map((r) => [r.group_key, r]));
  const codecsByKey = foldCodecCounts(codecRows);
  // The art row is picked for artwork, so an artist whose blurb sits on
  // another track loses it; fetch those few by primary key.
  const summaryByKey = await loadMissingSummaries(
    groups
      .filter((g) => !repByKey.get(g.group_key)?.summary && g.summaryItemId)
      .map((g) => [g.group_key, g.summaryItemId!] as const),
    "episode",
  );
  const singleServer = sf.isSingleServer
    ? { serverId: sf.serverIds[0], ...sf.serverMap.get(sf.serverIds[0])! }
    : null;

  const artistList = groups
    .map((g) => {
      const rep = repByKey.get(g.group_key);
      const mediaItemId = rep?.mediaItemId ?? "";
      return {
        // The spelling of the track the group links to, as the fold showed
        // its first track's; MIN would pick " Name" over "Name".
        parentTitle: rep?.parentTitle ?? g.parentTitle,
        mediaItemId,
        albumCount: g.albumCount,
        trackCount: g.trackCount,
        totalSize: g.totalSize,
        lastPlayed: g.lastPlayed,
        addedAt: g.addedAt,
        audioCodecCounts: codecsByKey.get(g.group_key) ?? {},
        thumbUrl: rep?.thumbUrl ?? null,
        servers: singleServer
          ? [{ serverId: singleServer.serverId, serverName: singleServer.name, serverType: singleServer.type, mediaItemId }]
          : groupServerPresence?.get(g.group_key) ?? [],
        summary: rep?.summary ?? summaryByKey.get(g.group_key) ?? null,
        genres: g.genres as string[] | null,
        studio: g.studio,
        contentRating: g.contentRating,
        rating: g.rating,
        ratingImage: g.ratingImage,
        audienceRating: g.audienceRating,
        audienceRatingImage: g.audienceRatingImage,
        year: g.year,
      };
    })
    .sort((a, b) => {
      const dir = sortOrder === "desc" ? -1 : 1;
      switch (sortBy) {
        case "trackCount":
          return (a.trackCount - b.trackCount) * dir;
        case "albumCount":
          return (a.albumCount - b.albumCount) * dir;
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
        default:
          return a.parentTitle.localeCompare(b.parentTitle) * dir;
      }
    });

  if (limit > 0) {
    const paged = artistList.slice(skip, skip + limit + 1);
    const hasMore = paged.length > limit;
    if (hasMore) paged.pop();
    return jsonResponse(request, { artists: paged, pagination: { page, limit, hasMore } });
  }
  // `limit=0` is everything — after an explicit `offset`, as on the flat lists.
  return jsonResponse(request, { artists: artistList.slice(skip), pagination: { page, limit, hasMore: false } });
}

/**
 * Answered from the list response cache when the same listing was asked for
 * in the last minute (`withListResponseCache`).
 */
export const GET = withListResponseCache("media-music-grouped", listGet);
