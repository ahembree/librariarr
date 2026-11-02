import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { withListResponseCache } from "@/lib/api/cached-list-response";
import { jsonResponse } from "@/lib/api/json-response";
import { prisma } from "@/lib/db";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { loadMissingSummaries } from "@/lib/media/group-summaries";
import { escapeLike } from "@/lib/filters/escape-like";
import { applyCommonFilters } from "@/lib/filters/build-where";
import { loadGenreSpellings } from "@/lib/filters/genre-spellings";
import { loadResolutionSpellings } from "@/lib/filters/resolution-spellings";
import { firstNonNullSql, qualityCountsSql, resolutionLabelSql } from "@/lib/media/series-sql";
import type { Prisma } from "@/generated/prisma/client";

interface SeasonRow {
  seriesKey: string;
  parentTitle: string;
  seasonNumber: number;
  episodeCount: number;
  totalSize: string;
  lastPlayed: Date | null;
  addedAt: Date | null;
  totalPlayCount: number;
  qualityCounts: Record<string, number> | null;
  servers: { serverId: string; serverName: string; serverType: string }[];
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

interface SeasonRepresentativeRow {
  seriesKey: string;
  seasonNumber: number;
  mediaItemId: string;
  summary: string | null;
}

/**
 * Whether a season-level date sits inside the bounds `applyCommonFilters` puts
 * on the matching column (`{ gte?, lte? }`), so the season's own figure
 * answers the date filters — see `seasonDates` in GET. Anything else (no
 * bound, or a shape this does not recognise) leaves the season in.
 */
function withinDateBounds(value: Date | null, bound: unknown): boolean {
  if (!bound || typeof bound !== "object") return true;
  const { gte, lte } = bound as { gte?: unknown; lte?: unknown };
  if (!(gte instanceof Date) && !(lte instanceof Date)) return true;
  if (value == null) return false;
  const time = new Date(value).getTime();
  if (gte instanceof Date && time < gte.getTime()) return false;
  if (lte instanceof Date && time > lte.getTime()) return false;
  return true;
}

/** The `applyCommonFilters` date keys answered on the season's own figures. */
const SEASON_LEVEL_FILTER_KEYS = [
  "lastPlayedAtMin", "lastPlayedAtMax", "lastPlayedAtDays",
  "addedAtMin", "addedAtMax", "addedAtDays",
];

/** First non-null value in episode order — show-level metadata is the same on every episode. */
const first = (col: string) => firstNonNullSql(col, `"episodeNumber", id`);

const listGet = withSession(async (session, request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "parentTitle";
  const sortOrder = searchParams.get("sortOrder") || "asc";
  const serverId = searchParams.get("serverId");

  const sf = await resolveServerFilter(session.userId, serverId, "SERIES");
  if (!sf) {
    return NextResponse.json({ seasons: [] });
  }

  // Aggregated in SQL rather than by loading every episode row (with its
  // `summary` text) into Node and folding in JS: measured on a 28k-episode
  // library that path took ~310 ms per request and shipped a paragraph per
  // episode across the wire to keep one per season. Same shape as the series
  // listing: a NARROW aggregate and a DISTINCT ON representative row, run in
  // parallel — see /api/media/series/grouped for why they are not one query.
  const filters: string[] = [];
  const params: unknown[] = [sf.serverIds];
  if (!sf.isSingleServer) filters.push(`AND mi."dedupCanonical" = true`);
  if (search) {
    // A LIKE pattern: a literal `%`, `_` or `\` in the search must not act as
    // a wildcard (Prisma's `contains` does not escape them either — the flat
    // list routes escape explicitly too; see escape-like.ts).
    params.push(escapeLike(search));
    filters.push(`AND mi."parentTitle" ILIKE '%' || $${params.length} || '%'`);
  }

  // The library filters the All Seasons tab sends (resolution, genre, year,
  // codec, …) were ignored entirely: the page forwarded every one and this
  // route read only the search. They are per-episode facts, so — as on the
  // series listing — a season qualifies when ANY of its episodes matches and
  // keeps its whole-season figures. `applyCommonFilters` builds a Prisma where
  // with no SQL form here, so Prisma resolves the qualifying seasons first.
  // The last-played and added-at filters are answered on the season's own
  // figures (below), not ANDed into the episode match, where beside any other
  // filter they demanded ONE episode that is, say, both 4K and played recently.
  const episodeParams = new URLSearchParams(searchParams);
  const seasonParams = new URLSearchParams();
  for (const key of SEASON_LEVEL_FILTER_KEYS) {
    const value = searchParams.get(key);
    if (value != null) seasonParams.set(key, value);
    episodeParams.delete(key);
  }
  const seasonDates: Prisma.MediaItemWhereInput = {};
  applyCommonFilters(seasonDates, seasonParams);
  const narrowing: Prisma.MediaItemWhereInput = {};
  // Every stored spelling of a genre, as the other listings match it, and
  // every stored value of a resolution label ("576" is 480P), as the quality
  // chips and the Series tab count it.
  const [genreSpellings, resolutionSpellings] = await Promise.all([
    loadGenreSpellings(searchParams),
    loadResolutionSpellings(searchParams),
  ]);
  applyCommonFilters(narrowing, episodeParams, genreSpellings, resolutionSpellings, {
    resolutionOtherIncludesNull: true,
  });
  if (Object.keys(narrowing).length > 0) {
    // `groupBy`, not `findMany({ distinct })`: Prisma applies `distinct` in
    // Node, reading one row per matching episode to keep one per season.
    const qualifying = await prisma.mediaItem.groupBy({
      by: ["seriesKey", "seasonNumber"],
      where: {
        AND: [
          narrowing,
          {
            type: "SERIES",
            seriesKey: { not: null },
            parentTitle: { not: null },
            library: { mediaServerId: { in: sf.serverIds } },
            ...(sf.isSingleServer ? {} : { dedupCanonical: true }),
          },
        ],
      },
    });
    params.push(qualifying.map((r) => r.seriesKey));
    const keysParam = params.length;
    params.push(qualifying.map((r) => r.seasonNumber ?? 0));
    filters.push(
      `AND (mi."seriesKey", COALESCE(mi."seasonNumber", 0)) IN (SELECT * FROM unnest($${keysParam}::text[], $${params.length}::int[]))`,
    );
  }

  const scope = `
      FROM "MediaItem" mi
      JOIN "Library" l ON mi."libraryId" = l.id
      JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
      WHERE mi.type = 'SERIES'::"LibraryType"
        AND mi."seriesKey" IS NOT NULL
        AND mi."parentTitle" IS NOT NULL
        AND l."mediaServerId" = ANY($1::text[])
        ${filters.join("\n        ")}`;

  // `ORDER BY "seriesKey", "seasonNumber"`: the list is sorted below with a
  // stable sort, so this orders its ties — two same-titled shows' Season 1,
  // or seasons of equal size — the same way on every request.
  const [rows, representatives] = await Promise.all([
    prisma.$queryRawUnsafe<SeasonRow[]>(
      `SELECT
        "seriesKey",
        MIN("parentTitle") AS "parentTitle",
        "seasonNumber",
        COUNT(*)::int AS "episodeCount",
        COALESCE(SUM("fileSize"), 0)::text AS "totalSize",
        MAX("lastPlayedAt") AS "lastPlayed",
        MAX("addedAt") AS "addedAt",
        COALESCE(SUM("playCount"), 0)::int AS "totalPlayCount",
        ${qualityCountsSql("resolution_label")} AS "qualityCounts",
        jsonb_agg(DISTINCT jsonb_build_object('serverId', "serverId", 'serverName', "serverName", 'serverType', "serverType")) AS servers,
        ${first(`"genres"`)} AS "genres",
        ${first(`"studio"`)} AS "studio",
        ${first(`"contentRating"`)} AS "contentRating",
        ${first(`"rating"`)} AS "rating",
        ${first(`"ratingImage"`)} AS "ratingImage",
        ${first(`"audienceRating"`)} AS "audienceRating",
        ${first(`"audienceRatingImage"`)} AS "audienceRatingImage",
        ${first(`"year"`)} AS "year",
        (array_agg(id ORDER BY "episodeNumber", id) FILTER (WHERE has_summary))[1] AS "summaryItemId"
      FROM (
        SELECT
          mi."seriesKey",
          mi."parentTitle",
          mi.id,
          (NULLIF(mi."summary", '') IS NOT NULL) AS has_summary,
          COALESCE(mi."seasonNumber", 0) AS "seasonNumber",
          mi."episodeNumber",
          mi."fileSize",
          mi."lastPlayedAt",
          mi."addedAt",
          mi."playCount",
          mi."genres",
          mi."studio",
          mi."contentRating",
          mi."rating",
          mi."ratingImage",
          mi."audienceRating",
          mi."audienceRatingImage",
          mi."year",
          ms.id AS "serverId",
          ms.name AS "serverName",
          ms.type::text AS "serverType",
          ${resolutionLabelSql("mi.resolution")} AS resolution_label
        ${scope}
        OFFSET 0
      ) items
      GROUP BY "seriesKey", "seasonNumber"
      ORDER BY "seriesKey", "seasonNumber"`,
      ...params,
    ),
    // One row per season: prefer a row that carries season art (the tile
    // requests ?type=season), then one with a summary, else the first episode.
    prisma.$queryRawUnsafe<SeasonRepresentativeRow[]>(
      `SELECT DISTINCT ON (mi."seriesKey", COALESCE(mi."seasonNumber", 0))
        mi."seriesKey",
        COALESCE(mi."seasonNumber", 0) AS "seasonNumber",
        mi.id AS "mediaItemId",
        NULLIF(mi."summary", '') AS "summary"
      ${scope}
      ORDER BY mi."seriesKey", COALESCE(mi."seasonNumber", 0),
        (mi."seasonThumbUrl" IS NOT NULL) DESC,
        (NULLIF(mi."summary", '') IS NOT NULL) DESC,
        mi."episodeNumber", mi.id`,
      ...params,
    ),
  ]);

  const repByKey = new Map(representatives.map((r) => [`${r.seriesKey}::${r.seasonNumber}`, r]));
  // Season art and a blurb can live on different episodes; fetch the blurb
  // for the few seasons whose art row has none (a PK lookup, usually for none).
  const summaryByKey = await loadMissingSummaries(
    rows
      .filter((s) => !repByKey.get(`${s.seriesKey}::${s.seasonNumber}`)?.summary && s.summaryItemId)
      .map((s) => [`${s.seriesKey}::${s.seasonNumber}`, s.summaryItemId!] as const),
    "episode",
  );

  const seasonsList = rows
    // "Any episode matched" is the wrong question for a date: a season whose
    // first episode was last played in 2022 and its finale yesterday would
    // pass "last played before 2023". The season's own latest play and newest
    // addition answer those filters instead.
    .filter((s) => withinDateBounds(s.lastPlayed, seasonDates.lastPlayedAt) && withinDateBounds(s.addedAt, seasonDates.addedAt))
    .map((s) => {
      // Both statements share `scope` and group on the same key, so every
      // aggregate row has its representative.
      const rep = repByKey.get(`${s.seriesKey}::${s.seasonNumber}`)!;
      return {
      parentTitle: s.parentTitle,
      seriesKey: s.seriesKey,
      seasonNumber: s.seasonNumber,
      mediaItemId: rep.mediaItemId,
      episodeCount: s.episodeCount,
      totalSize: s.totalSize,
      lastPlayed: s.lastPlayed,
      addedAt: s.addedAt,
      totalPlayCount: s.totalPlayCount,
      qualityCounts: (s.qualityCounts ?? {}) as Record<string, number>,
      servers: [...(s.servers ?? [])].sort((a, b) => a.serverName.localeCompare(b.serverName)),
      summary: rep.summary ?? summaryByKey.get(`${s.seriesKey}::${s.seasonNumber}`) ?? null,
      genres: s.genres as string[] | null,
      studio: s.studio,
      contentRating: s.contentRating,
      rating: s.rating,
      ratingImage: s.ratingImage,
      audienceRating: s.audienceRating,
      audienceRatingImage: s.audienceRatingImage,
      year: s.year,
      };
    })
    .sort((a, b) => {
      const dir = sortOrder === "desc" ? -1 : 1;
      switch (sortBy) {
        case "episodeCount":
          return (a.episodeCount - b.episodeCount) * dir;
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
        case "seasonNumber":
          return (a.seasonNumber - b.seasonNumber) * dir || a.parentTitle.localeCompare(b.parentTitle);
        default:
          return a.parentTitle.localeCompare(b.parentTitle) * dir || a.seasonNumber - b.seasonNumber;
      }
    });

  return jsonResponse(request, { seasons: seasonsList });
});

/**
 * Answered from the list response cache when the same listing was asked for
 * in the last minute (`withListResponseCache`).
 */
export const GET = withListResponseCache("media-series-all-seasons", listGet);
