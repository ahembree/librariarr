import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

/**
 * Compute the dashboard library statistics payload for a set of servers.
 *
 * Shared by `GET /api/media/stats` and the AI analysis `get_library_overview`
 * tool so the two can't drift. Returns counts, per-type size & duration,
 * resolution/codec/genre/etc. breakdowns, and the top-played movies/series/music
 * (cumulative play count). `dedupEnabled` restricts breakdowns and counts to the
 * canonical copy across servers.
 */
export async function computeLibraryStats(serverIds: string[], dedupEnabled: boolean) {
  const serverFilter = { library: { mediaServerId: { in: serverIds } } };
  const breakdownFilter = dedupEnabled
    ? { ...serverFilter, dedupCanonical: true }
    : serverFilter;

  const [
    movieCount,
    episodeCount,
    musicCount,
    qualityBreakdown,
    totalSizeResult,
    topMovies,
    topSeriesAgg,
    topMusicAgg,
    videoCodecBreakdown,
    audioCodecBreakdown,
    contentRatingBreakdown,
    dynamicRangeBreakdown,
    audioChannelsBreakdown,
    genreBreakdown,
    groupedCounts,
  ] = await Promise.all([
    prisma.mediaItem.count({
      where: { ...serverFilter, type: "MOVIE" },
    }),
    prisma.mediaItem.count({
      where: { ...serverFilter, type: "SERIES" },
    }),
    prisma.mediaItem.count({
      where: { ...serverFilter, type: "MUSIC" },
    }),
    prisma.mediaItem.groupBy({
      by: ["resolution", "type"],
      where: breakdownFilter,
      _count: true,
    }),
    prisma.mediaItem.aggregate({
      where: serverFilter,
      _sum: { fileSize: true },
    }),
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
      by: ["parentTitle"],
      where: {
        ...serverFilter,
        type: "SERIES",
        parentTitle: { not: null },
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
    prisma.mediaItem.groupBy({
      by: ["videoCodec", "type"],
      where: breakdownFilter,
      _count: true,
    }),
    prisma.mediaItem.groupBy({
      by: ["audioCodec", "type"],
      where: breakdownFilter,
      _count: true,
    }),
    prisma.mediaItem.groupBy({
      by: ["contentRating", "type"],
      where: breakdownFilter,
      _count: true,
    }),
    prisma.mediaItem.groupBy({
      by: ["dynamicRange", "type"],
      where: breakdownFilter,
      _count: true,
    }),
    prisma.mediaItem.groupBy({
      by: ["audioChannels", "type"],
      where: breakdownFilter,
      _count: true,
    }),
    prisma.$queryRaw<
      { value: string; type: string; _count: number }[]
    >`
      SELECT g.genre AS "value", mi.type::text AS "type",
        COUNT(DISTINCT COALESCE(mi."parentTitle", mi.id))::int AS "_count"
      FROM "MediaItem" mi
      JOIN "Library" l ON mi."libraryId" = l.id
      CROSS JOIN LATERAL jsonb_array_elements_text(mi.genres) AS g(genre)
      WHERE l."mediaServerId" IN (${Prisma.join(serverIds)})
        AND mi.genres IS NOT NULL AND jsonb_typeof(mi.genres) = 'array'
        ${dedupEnabled ? Prisma.sql`AND mi."dedupCanonical" = true` : Prisma.empty}
      GROUP BY g.genre, mi.type
      ORDER BY "_count" DESC
    `,
    prisma.$queryRaw<
      [{
        seriesCount: number; seasonCount: number; artistCount: number; albumCount: number;
        movieSize: bigint; seriesSize: bigint; musicSize: bigint;
        movieDuration: bigint; seriesDuration: bigint; musicDuration: bigint;
      }]
    >`
      SELECT
        COUNT(DISTINCT CASE WHEN mi.type = 'SERIES'
          THEN COALESCE(mi."grandparentRatingKey", mi."parentTitle") END)::int AS "seriesCount",
        COUNT(DISTINCT CASE WHEN mi.type = 'SERIES' AND mi."seasonNumber" IS NOT NULL
          THEN COALESCE(mi."parentRatingKey", mi."parentTitle" || ':' || mi."seasonNumber") END)::int AS "seasonCount",
        COUNT(DISTINCT CASE WHEN mi.type = 'MUSIC'
          THEN COALESCE(mi."grandparentRatingKey", mi."parentTitle") END)::int AS "artistCount",
        COUNT(DISTINCT CASE WHEN mi.type = 'MUSIC'
          THEN COALESCE(mi."parentRatingKey", mi."parentTitle" || ':' || mi."albumTitle") END)::int AS "albumCount",
        COALESCE(SUM(CASE WHEN mi.type = 'MOVIE' THEN mi."fileSize" END), 0) AS "movieSize",
        COALESCE(SUM(CASE WHEN mi.type = 'SERIES' THEN mi."fileSize" END), 0) AS "seriesSize",
        COALESCE(SUM(CASE WHEN mi.type = 'MUSIC' THEN mi."fileSize" END), 0) AS "musicSize",
        COALESCE(SUM(CASE WHEN mi.type = 'MOVIE' THEN mi.duration END), 0)::bigint AS "movieDuration",
        COALESCE(SUM(CASE WHEN mi.type = 'SERIES' THEN mi.duration END), 0)::bigint AS "seriesDuration",
        COALESCE(SUM(CASE WHEN mi.type = 'MUSIC' THEN mi.duration END), 0)::bigint AS "musicDuration"
      FROM "MediaItem" mi
      JOIN "Library" l ON mi."libraryId" = l.id
      WHERE l."mediaServerId" IN (${Prisma.join(serverIds)})
        ${dedupEnabled ? Prisma.sql`AND mi."dedupCanonical" = true` : Prisma.empty}
    `,
  ]);

  const {
    seriesCount, seasonCount, artistCount, albumCount,
    movieSize, seriesSize, musicSize,
    movieDuration, seriesDuration, musicDuration,
  } = groupedCounts[0];

  // Cross-server dedup counts using pre-computed dedupCanonical flags
  let dedupMovieCount = movieCount;
  let dedupEpisodeCount = episodeCount;
  let dedupMusicCount = musicCount;
  let dedupTotalSize: bigint | null = null;

  if (dedupEnabled) {
    const dedupFilter = { ...serverFilter, dedupCanonical: true };
    const [movieDedup, episodeDedup, musicDedup, sizeDedup] = await Promise.all([
      prisma.mediaItem.count({ where: { ...dedupFilter, type: "MOVIE" } }),
      prisma.mediaItem.count({ where: { ...dedupFilter, type: "SERIES" } }),
      prisma.mediaItem.count({ where: { ...dedupFilter, type: "MUSIC" } }),
      prisma.mediaItem.aggregate({
        where: dedupFilter,
        _sum: { fileSize: true },
      }),
    ]);

    dedupMovieCount = movieDedup;
    dedupEpisodeCount = episodeDedup;
    dedupMusicCount = musicDedup;
    dedupTotalSize = sizeDedup._sum.fileSize;
  }

  // Batch fetch thumb URLs for top series and music in parallel (avoids N+1)
  const topSeriesTitles = topSeriesAgg
    .map((s) => s.parentTitle)
    .filter((t): t is string => t != null);
  const topMusicArtists = topMusicAgg
    .map((s) => s.parentTitle)
    .filter((t): t is string => t != null);

  const [seriesThumbs, musicDetails] = await Promise.all([
    topSeriesTitles.length > 0
      ? prisma.mediaItem.findMany({
          where: { ...serverFilter, type: "SERIES", parentTitle: { in: topSeriesTitles } },
          select: { id: true, parentTitle: true, parentThumbUrl: true, playCount: true },
          orderBy: { playCount: "desc" },
          distinct: ["parentTitle"],
        })
      : [],
    topMusicArtists.length > 0
      ? prisma.mediaItem.findMany({
          where: { ...serverFilter, type: "MUSIC", parentTitle: { in: topMusicArtists } },
          select: { id: true, parentTitle: true, parentThumbUrl: true, playCount: true },
          orderBy: { playCount: "desc" },
          distinct: ["parentTitle"],
        })
      : [],
  ]);

  const thumbMap = new Map(
    seriesThumbs.map((s) => [s.parentTitle, s.parentThumbUrl])
  );
  const seriesIdMap = new Map(
    seriesThumbs.map((s) => [s.parentTitle, s.id])
  );

  const topSeriesWithThumbs = topSeriesAgg.map((s) => ({
    parentTitle: s.parentTitle!,
    totalPlays: s._sum?.playCount ?? 0,
    thumbUrl: thumbMap.get(s.parentTitle!) ?? null,
    mediaItemId: seriesIdMap.get(s.parentTitle!) ?? null,
  }));

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
    movieCount: dedupEnabled ? dedupMovieCount : movieCount,
    seriesCount,
    seasonCount,
    musicCount: dedupEnabled ? dedupMusicCount : musicCount,
    artistCount,
    albumCount,
    episodeCount: dedupEnabled ? dedupEpisodeCount : episodeCount,
    totalSize: (dedupEnabled && dedupTotalSize !== null ? dedupTotalSize : totalSizeResult._sum.fileSize ?? BigInt(0)).toString(),
    movieSize: movieSize.toString(),
    seriesSize: seriesSize.toString(),
    musicSize: musicSize.toString(),
    movieDuration: Number(movieDuration),
    seriesDuration: Number(seriesDuration),
    musicDuration: Number(musicDuration),
    qualityBreakdown,
    topMovies,
    topSeries: topSeriesWithThumbs,
    topMusic: topMusicWithDetails,
    videoCodecBreakdown,
    audioCodecBreakdown,
    contentRatingBreakdown,
    dynamicRangeBreakdown,
    audioChannelsBreakdown,
    genreBreakdown,
  };
}
