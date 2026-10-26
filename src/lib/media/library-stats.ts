import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

function compareNullsLast(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * Compute the dashboard library statistics payload for a set of servers.
 *
 * Shared by `GET /api/media/stats` and the AI analysis `get_library_overview`
 * tool so the two can't drift. Returns counts, per-type size & duration,
 * resolution/codec/genre/etc. breakdowns, and the top-played movies/series/music
 * (cumulative play count). `dedupEnabled` restricts breakdowns and counts to the
 * canonical copy across servers.
 */
/** The breakdown dimensions, each counted per media type. */
type BreakdownColumn =
  | "resolution"
  | "videoCodec"
  | "audioCodec"
  | "contentRating"
  | "dynamicRange"
  | "audioChannels";

/** One `GROUPING SETS` row: the type, every dimension's value, and which one it counts. */
type BreakdownRow = { type: string; _count: number } & {
  [C in BreakdownColumn]: C extends "audioChannels" ? number | null : string | null;
} & { [C in BreakdownColumn as `g_${C}`]: number };

/** `{ [column]: value, type, _count }`, the shape the stats payload has always had. */
type BreakdownEntry<C extends BreakdownColumn> = { _count: number; type: string } & {
  [K in C]: BreakdownRow[K];
};

/**
 * Compute the dashboard library statistics payload for a set of servers.
 *
 * Shared by `GET /api/media/stats` and the AI analysis `get_library_overview`
 * tool so the two can't drift. Returns counts, per-type size & duration,
 * resolution/codec/genre/etc. breakdowns, and the top-played movies/series/music
 * (cumulative play count). `dedupEnabled` restricts breakdowns and counts to the
 * canonical copy across servers.
 *
 * Every count, size and breakdown comes from two scans of the library — one
 * for the totals, one `GROUPING SETS` pass for the six breakdowns — plus the
 * genre count and the top-played lists. It used to issue fifteen queries (nineteen
 * with dedup), each scanning every item; run together on a small machine they
 * slowed one another to ~1 s for a 167k-item library.
 */
export async function computeLibraryStats(serverIds: string[], dedupEnabled: boolean) {
  const serverFilter = { library: { mediaServerId: { in: serverIds } } };
  const inServers = Prisma.sql`l."mediaServerId" IN (${Prisma.join(serverIds)})`;
  // Which rows the breakdowns, distinct counts, sizes and runtimes read: the
  // canonical copy of each item when dedup is on.
  const counted = dedupEnabled ? Prisma.sql`mi."dedupCanonical" = true` : Prisma.sql`true`;

  const [
    [totals],
    breakdownRows,
    topMovies,
    topSeriesAgg,
    topMusicAgg,
    genreBreakdown,
  ] = await Promise.all([
    // Artists and albums are keyed by normalized title, as the music library
    // groups them: rating keys are per server, so with dedup on an artist
    // whose albums are canonical on two servers counted as two artists.
    // Each distinct count takes its rows through FILTER rather than a CASE
    // inside the DISTINCT, so it sorts only its own type's rows.
    prisma.$queryRaw<[{
      movieCount: number; episodeCount: number; musicCount: number; totalSize: string | null;
      canonicalMovieCount: number; canonicalEpisodeCount: number; canonicalMusicCount: number;
      canonicalTotalSize: string | null;
      seriesCount: number; seasonCount: number; artistCount: number; albumCount: number;
      movieSize: string; seriesSize: string; musicSize: string;
      movieDuration: bigint; seriesDuration: bigint; musicDuration: bigint;
    }]>`
      SELECT
        COUNT(*) FILTER (WHERE mi.type = 'MOVIE')::int AS "movieCount",
        COUNT(*) FILTER (WHERE mi.type = 'SERIES')::int AS "episodeCount",
        COUNT(*) FILTER (WHERE mi.type = 'MUSIC')::int AS "musicCount",
        SUM(mi."fileSize")::text AS "totalSize",
        COUNT(*) FILTER (WHERE mi.type = 'MOVIE' AND mi."dedupCanonical" = true)::int AS "canonicalMovieCount",
        COUNT(*) FILTER (WHERE mi.type = 'SERIES' AND mi."dedupCanonical" = true)::int AS "canonicalEpisodeCount",
        COUNT(*) FILTER (WHERE mi.type = 'MUSIC' AND mi."dedupCanonical" = true)::int AS "canonicalMusicCount",
        SUM(mi."fileSize") FILTER (WHERE mi."dedupCanonical" = true)::text AS "canonicalTotalSize",
        COUNT(DISTINCT COALESCE(mi."seriesKey", mi."grandparentRatingKey", mi."parentTitle"))
          FILTER (WHERE mi.type = 'SERIES' AND ${counted})::int AS "seriesCount",
        COUNT(DISTINCT COALESCE(mi."seriesKey" || ':' || mi."seasonNumber", mi."parentRatingKey", mi."parentTitle" || ':' || mi."seasonNumber"))
          FILTER (WHERE mi.type = 'SERIES' AND mi."seasonNumber" IS NOT NULL AND ${counted})::int AS "seasonCount",
        COUNT(DISTINCT COALESCE(LOWER(TRIM(mi."parentTitle")), mi."grandparentRatingKey"))
          FILTER (WHERE mi.type = 'MUSIC' AND ${counted})::int AS "artistCount",
        COUNT(DISTINCT COALESCE(LOWER(TRIM(mi."parentTitle")) || ':' || LOWER(TRIM(mi."albumTitle")), mi."parentRatingKey"))
          FILTER (WHERE mi.type = 'MUSIC' AND ${counted})::int AS "albumCount",
        COALESCE(SUM(mi."fileSize") FILTER (WHERE mi.type = 'MOVIE' AND ${counted}), 0)::text AS "movieSize",
        COALESCE(SUM(mi."fileSize") FILTER (WHERE mi.type = 'SERIES' AND ${counted}), 0)::text AS "seriesSize",
        COALESCE(SUM(mi."fileSize") FILTER (WHERE mi.type = 'MUSIC' AND ${counted}), 0)::text AS "musicSize",
        COALESCE(SUM(mi.duration) FILTER (WHERE mi.type = 'MOVIE' AND ${counted}), 0)::bigint AS "movieDuration",
        COALESCE(SUM(mi.duration) FILTER (WHERE mi.type = 'SERIES' AND ${counted}), 0)::bigint AS "seriesDuration",
        COALESCE(SUM(mi.duration) FILTER (WHERE mi.type = 'MUSIC' AND ${counted}), 0)::bigint AS "musicDuration"
      FROM "MediaItem" mi
      JOIN "Library" l ON mi."libraryId" = l.id
      WHERE ${inServers}
    `,
    prisma.$queryRaw<BreakdownRow[]>`
      SELECT mi.type::text AS "type",
        mi.resolution, mi."videoCodec", mi."audioCodec", mi."contentRating", mi."dynamicRange", mi."audioChannels",
        GROUPING(mi.resolution)::int AS "g_resolution",
        GROUPING(mi."videoCodec")::int AS "g_videoCodec",
        GROUPING(mi."audioCodec")::int AS "g_audioCodec",
        GROUPING(mi."contentRating")::int AS "g_contentRating",
        GROUPING(mi."dynamicRange")::int AS "g_dynamicRange",
        GROUPING(mi."audioChannels")::int AS "g_audioChannels",
        COUNT(*)::int AS "_count"
      FROM "MediaItem" mi
      JOIN "Library" l ON mi."libraryId" = l.id
      WHERE ${inServers} AND ${counted}
      GROUP BY GROUPING SETS (
        (mi.type, mi.resolution), (mi.type, mi."videoCodec"), (mi.type, mi."audioCodec"),
        (mi.type, mi."contentRating"), (mi.type, mi."dynamicRange"), (mi.type, mi."audioChannels")
      )
    `,
    prisma.mediaItem.findMany({
      where: { ...serverFilter, type: "MOVIE", playCount: { gt: 0 }, ...(dedupEnabled ? { dedupCanonical: true } : {}) },
      orderBy: { playCount: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        year: true,
        playCount: true,
        thumbUrl: true,
      },
    }),
    prisma.mediaItem.groupBy({
      // Top series by cumulative plays, keyed on series identity (seriesKey) so
      // two same-titled shows don't pool their plays into one row.
      by: ["seriesKey"],
      where: {
        ...serverFilter,
        type: "SERIES",
        seriesKey: { not: null },
        playCount: { gt: 0 },
        ...(dedupEnabled ? { dedupCanonical: true } : {}),
      },
      _sum: { playCount: true },
      orderBy: { _sum: { playCount: "desc" } },
      take: 10,
    }),
    prisma.mediaItem.groupBy({
      by: ["parentTitle"],
      where: {
        ...serverFilter,
        type: "MUSIC",
        parentTitle: { not: null },
        playCount: { gt: 0 },
        ...(dedupEnabled ? { dedupCanonical: true } : {}),
      },
      _sum: { playCount: true },
      orderBy: { _sum: { playCount: "desc" } },
      take: 10,
    }),
    // Distinct (genre, type, title) triples first, then counted per genre. A
    // `COUNT(DISTINCT …)` per genre sorted every (item, genre) pair in one
    // single-process external sort, where the de-duplication runs in
    // parallel. Same counts.
    prisma.$queryRaw<
      { value: string; type: string; _count: number }[]
    >`
      SELECT d.genre AS "value", d.type::text AS "type", COUNT(*)::int AS "_count"
      FROM (
        SELECT DISTINCT g.genre, mi.type,
          COALESCE(CASE WHEN mi.type = 'SERIES' THEN mi."seriesKey" END, mi."parentTitle", mi.id) AS title_key
        FROM "MediaItem" mi
        JOIN "Library" l ON mi."libraryId" = l.id
        CROSS JOIN LATERAL jsonb_array_elements_text(mi.genres) AS g(genre)
        WHERE ${inServers}
          AND mi.genres IS NOT NULL AND jsonb_typeof(mi.genres) = 'array'
          AND ${counted}
      ) d
      GROUP BY d.genre, d.type
      ORDER BY "_count" DESC
    `,
  ]);

  // One dimension's rows, ordered by value (nulls last) then type, as the
  // per-dimension group-bys these replaced returned them.
  const breakdown = <C extends BreakdownColumn>(column: C): BreakdownEntry<C>[] =>
    breakdownRows
      .filter((row) => row[`g_${column}`] === 0)
      .sort((a, b) => compareNullsLast(a[column], b[column]) || compareNullsLast(a.type, b.type))
      .map((row) => ({ _count: row._count, [column]: row[column], type: row.type }) as BreakdownEntry<C>);

  const {
    seriesCount, seasonCount, artistCount, albumCount,
    movieSize, seriesSize, musicSize,
    movieDuration, seriesDuration, musicDuration,
  } = totals;

  // With dedup on, the headline counts and total read the canonical copies.
  // A total over no canonical rows falls back to every copy's, as it always has.
  const totalSize = dedupEnabled && totals.canonicalTotalSize !== null
    ? totals.canonicalTotalSize
    : totals.totalSize ?? "0";

  // Batch fetch a representative row (title/thumb/id) per top series/music,
  // avoiding N+1. Series are keyed by seriesKey (identity); music by artist name.
  const topSeriesKeys = topSeriesAgg
    .map((s) => s.seriesKey)
    .filter((k): k is string => k != null);
  const topMusicArtists = topMusicAgg
    .map((s) => s.parentTitle)
    .filter((t): t is string => t != null);

  // The most-played episode/track of each, by `DISTINCT ON` in SQL. Prisma's
  // `distinct` is applied in Node: it read every episode of the ten shows
  // (every track of the ten artists) to keep one each. `id` breaks a tie in
  // play count, which the unordered pick left to the heap order.
  const [seriesReps, musicDetails] = await Promise.all([
    topSeriesKeys.length > 0
      ? prisma.$queryRaw<{ id: string; seriesKey: string; parentTitle: string | null; parentThumbUrl: string | null }[]>`
          SELECT DISTINCT ON (mi."seriesKey") mi.id, mi."seriesKey", mi."parentTitle", mi."parentThumbUrl"
          FROM "MediaItem" mi
          JOIN "Library" l ON mi."libraryId" = l.id
          WHERE ${inServers} AND mi.type = 'SERIES'::"LibraryType"
            AND mi."seriesKey" = ANY(${topSeriesKeys}::text[])
          ORDER BY mi."seriesKey", mi."playCount" DESC, mi.id`
      : [],
    topMusicArtists.length > 0
      ? prisma.$queryRaw<{ id: string; parentTitle: string; parentThumbUrl: string | null }[]>`
          SELECT DISTINCT ON (mi."parentTitle") mi.id, mi."parentTitle", mi."parentThumbUrl"
          FROM "MediaItem" mi
          JOIN "Library" l ON mi."libraryId" = l.id
          WHERE ${inServers} AND mi.type = 'MUSIC'::"LibraryType"
            AND mi."parentTitle" = ANY(${topMusicArtists}::text[])
          ORDER BY mi."parentTitle", mi."playCount" DESC, mi.id`
      : [],
  ]);

  const seriesRepMap = new Map(
    seriesReps.map((s) => [s.seriesKey, { parentTitle: s.parentTitle, thumbUrl: s.parentThumbUrl, id: s.id }])
  );

  const topSeriesWithThumbs = topSeriesAgg.map((s) => {
    const rep = seriesRepMap.get(s.seriesKey);
    return {
      // Display name of the representative episode's show (may repeat across two
      // same-titled shows, which are distinct rows keyed by seriesKey).
      parentTitle: rep?.parentTitle ?? "",
      totalPlays: s._sum?.playCount ?? 0,
      thumbUrl: rep?.thumbUrl ?? null,
      mediaItemId: rep?.id ?? null,
    };
  });

  const musicDetailMap = new Map(
    musicDetails.map((s) => [s.parentTitle, { thumbUrl: s.parentThumbUrl, id: s.id }])
  );

  const topMusicWithDetails = topMusicAgg.map((s) => ({
    parentTitle: s.parentTitle!,
    totalPlays: s._sum?.playCount ?? 0,
    mediaItemId: musicDetailMap.get(s.parentTitle!)?.id ?? null,
    thumbUrl: musicDetailMap.get(s.parentTitle!)?.thumbUrl ?? null,
  }));

  return {
    movieCount: dedupEnabled ? totals.canonicalMovieCount : totals.movieCount,
    seriesCount,
    seasonCount,
    musicCount: dedupEnabled ? totals.canonicalMusicCount : totals.musicCount,
    artistCount,
    albumCount,
    episodeCount: dedupEnabled ? totals.canonicalEpisodeCount : totals.episodeCount,
    totalSize,
    movieSize,
    seriesSize,
    musicSize,
    movieDuration: Number(movieDuration),
    seriesDuration: Number(seriesDuration),
    musicDuration: Number(musicDuration),
    qualityBreakdown: breakdown("resolution"),
    topMovies,
    topSeries: topSeriesWithThumbs,
    topMusic: topMusicWithDetails,
    videoCodecBreakdown: breakdown("videoCodec"),
    audioCodecBreakdown: breakdown("audioCodec"),
    contentRatingBreakdown: breakdown("contentRating"),
    dynamicRangeBreakdown: breakdown("dynamicRange"),
    audioChannelsBreakdown: breakdown("audioChannels"),
    genreBreakdown,
  };
}
