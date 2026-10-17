import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/api/json-response";
import { MAX_GROUPED_LIST_LIMIT, parseListPagination } from "@/lib/api/pagination";
import { prisma } from "@/lib/db";
import { escapeLike } from "@/lib/filters/escape-like";
import { applyCommonFilters } from "@/lib/filters/build-where";
import { loadGenreSpellings } from "@/lib/filters/genre-spellings";
import { loadResolutionSpellings } from "@/lib/filters/resolution-spellings";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { firstNonNullSql } from "@/lib/media/series-sql";
import { loadMissingSummaries } from "@/lib/media/group-summaries";
import { audioCodecLabelSql, foldCodecCounts, type CodecCountRow } from "@/lib/media/music-sql";
import type { Prisma } from "@/generated/prisma/client";

const UNKNOWN_ALBUM = "Unknown Album";
const UNKNOWN_ARTIST = "Unknown Artist";

interface AlbumGroupRow {
  group_key: string;
  albumTitle: string;
  artistName: string;
  trackCount: number;
  totalSize: string;
  totalPlayCount: number;
  lastPlayed: Date | null;
  addedAt: Date | null;
  serverIds: string[];
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

interface AlbumRepresentativeRow {
  group_key: string;
  mediaItemId: string;
  albumTitle: string;
  artistName: string;
  summary: string | null;
}

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
  // The shared parser, as on the artist listing beside it: this route read
  // `limit` with a bare parseInt, so `limit=-1` sliced to nothing and answered
  // `hasMore: true` forever, nothing capped a page, and `offset` was ignored.
  const { page, limit, skip } = parseListPagination(searchParams, { maxLimit: MAX_GROUPED_LIST_LIMIT });

  const sf = await resolveServerFilter(session.userId!, serverId, "MUSIC");
  if (!sf) {
    return NextResponse.json({ albums: [], pagination: { page, limit, hasMore: false } });
  }

  // Aggregated in SQL, like the artist and series listings: this loaded every
  // track — 18 columns and its server through a relation — into Node and
  // folded them in JS, ~550 ms on a 40k-track library for a listing that keeps
  // one row per album. The key is the fold's: artist and album, each
  // lower-cased and trimmed, with the same placeholders for a missing title.
  const params: unknown[] = [sf.serverIds];
  const conditions = [`mi.type = 'MUSIC'::"LibraryType"`, `l."mediaServerId" = ANY($1::text[])`];
  if (!sf.isSingleServer) conditions.push(`mi."dedupCanonical" = true`);
  // `escapeLike`: `search` becomes a LIKE pattern, and nothing else escapes
  // `%` / `_` / `\` — live, `?search=1_ Things` matched "10 Things I Hate
  // About You" and `?search=%` matched everything (see escape-like.ts).
  if (search) {
    params.push(escapeLike(search));
    conditions.push(`(mi."albumTitle" ILIKE '%' || $${params.length} || '%' OR mi."parentTitle" ILIKE '%' || $${params.length} || '%')`);
  }
  // The library filters the Albums tab sends (genre, codec, year, …) were
  // ignored entirely: the page forwarded every one and this route read only
  // the search. Applied as the artist listing applies them — the same tab
  // strip, so the two must agree: Prisma resolves the matching tracks
  // (`applyCommonFilters` builds a where with no SQL form here) and every
  // album aggregate runs over those.
  const narrowing: Prisma.MediaItemWhereInput = {};
  // Every stored spelling of a genre, as the other listings match it.
  const [genreSpellings, resolutionSpellings] = await Promise.all([
    loadGenreSpellings(searchParams),
    loadResolutionSpellings(searchParams),
  ]);
  applyCommonFilters(narrowing, searchParams, genreSpellings, resolutionSpellings);
  if (Object.keys(narrowing).length > 0) {
    const matching = await prisma.mediaItem.findMany({
      where: {
        AND: [
          narrowing,
          {
            type: "MUSIC",
            library: { mediaServerId: { in: sf.serverIds } },
            ...(sf.isSingleServer ? {} : { dedupCanonical: true }),
          },
        ],
      },
      select: { id: true },
    });
    params.push(matching.map((r) => r.id));
    conditions.push(`mi.id = ANY($${params.length}::text[])`);
  }
  const scope = `
      FROM "MediaItem" mi
      JOIN "Library" l ON mi."libraryId" = l.id
      WHERE ${conditions.join("\n        AND ")}`;
  const albumKey = `LOWER(TRIM(COALESCE(mi."parentTitle", '${UNKNOWN_ARTIST}'))) || '::' || LOWER(TRIM(COALESCE(mi."albumTitle", '${UNKNOWN_ALBUM}')))`;
  // "First" in track order — album-level fields are the same on every track;
  // the fold took whichever arrived first, from a query with no ORDER BY.
  const trackOrder = `"seasonNumber", "episodeNumber", id`;
  const first = (col: string) => firstNonNullSql(col, trackOrder);

  // `ORDER BY group_key`: the sort below is stable, so this orders ties and
  // keeps page boundaries in the same place on every request.
  const [groups, representatives, codecRows] = await Promise.all([
    prisma.$queryRawUnsafe<AlbumGroupRow[]>(
      `SELECT
        group_key,
        MIN("albumTitle") as "albumTitle",
        MIN("artistName") as "artistName",
        COUNT(*)::int as "trackCount",
        COALESCE(SUM("fileSize"), 0)::text as "totalSize",
        COALESCE(SUM("playCount"), 0)::int as "totalPlayCount",
        MAX("lastPlayedAt") as "lastPlayed",
        MAX("addedAt") as "addedAt",
        array_agg(DISTINCT "mediaServerId") as "serverIds",
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
        SELECT ${albumKey} as group_key, mi.id,
          COALESCE(mi."albumTitle", '${UNKNOWN_ALBUM}') as "albumTitle",
          COALESCE(mi."parentTitle", '${UNKNOWN_ARTIST}') as "artistName",
          mi."seasonNumber", mi."episodeNumber", mi."fileSize", mi."playCount", mi."lastPlayedAt",
          mi."addedAt", l."mediaServerId", mi."summary", mi."genres", mi."studio", mi."contentRating",
          mi."rating", mi."ratingImage", mi."audienceRating", mi."audienceRatingImage", mi."year"
        ${scope}
      ) tracks
      GROUP BY group_key
      ORDER BY group_key`,
      ...params,
    ),
    // One row per album: a track with album art (the page asks for it with
    // `?type=parent`), else the first track.
    prisma.$queryRawUnsafe<AlbumRepresentativeRow[]>(
      `SELECT DISTINCT ON (${albumKey})
        ${albumKey} as group_key,
        mi.id as "mediaItemId",
        COALESCE(mi."albumTitle", '${UNKNOWN_ALBUM}') as "albumTitle",
        COALESCE(mi."parentTitle", '${UNKNOWN_ARTIST}') as "artistName",
        NULLIF(mi."summary", '') as "summary"
      ${scope}
      ORDER BY ${albumKey}, (mi."parentThumbUrl" IS NOT NULL) DESC, mi."seasonNumber", mi."episodeNumber", mi.id`,
      ...params,
    ),
    prisma.$queryRawUnsafe<CodecCountRow[]>(
      `SELECT ${albumKey} as group_key, ${audioCodecLabelSql(`mi."audioCodec"`)} as codec, COUNT(*)::int as n
      ${scope}
      GROUP BY 1, 2`,
      ...params,
    ),
  ]);

  const repByKey = new Map(representatives.map((r) => [r.group_key, r]));
  const codecsByKey = foldCodecCounts(codecRows);
  const summaryByKey = await loadMissingSummaries(
    groups
      .filter((g) => !repByKey.get(g.group_key)?.summary && g.summaryItemId)
      .map((g) => [g.group_key, g.summaryItemId!] as const),
    "episode",
  );

  const albums = groups.map((g) => {
    const rep = repByKey.get(g.group_key);
    return {
      // The spellings of the track the album links to, as the fold showed its
      // first track's; MIN would pick " Name" over "Name".
      albumTitle: rep?.albumTitle ?? g.albumTitle,
      artistName: rep?.artistName ?? g.artistName,
      trackCount: g.trackCount,
      totalSize: g.totalSize,
      audioCodecCounts: codecsByKey.get(g.group_key) ?? {},
      mediaItemId: rep?.mediaItemId ?? "",
      totalPlayCount: g.totalPlayCount,
      lastPlayed: g.lastPlayed,
      addedAt: g.addedAt,
      servers: g.serverIds.flatMap((id) => {
        const server = sf.serverMap.get(id);
        return server ? [{ serverId: id, serverName: server.name, serverType: server.type }] : [];
      }),
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
  });

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

  if (limit > 0) {
    const fetched = albums.slice(skip, skip + limit + 1);
    const hasMore = fetched.length > limit;
    if (hasMore) fetched.pop();
    return jsonResponse(request, { albums: fetched, pagination: { page, limit, hasMore } });
  }
  // `limit=0` is everything — after an explicit `offset`, as on the flat lists.
  return jsonResponse(request, { albums: albums.slice(skip), pagination: { page, limit, hasMore: false } });
}
