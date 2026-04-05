import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { applyStartsWithFilter } from "@/lib/filters/build-where";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import type { ServerPresence } from "@/lib/dedup/deduplicate";
import { getServerPresenceByGroup } from "@/lib/dedup/server-presence";

function getResolutionLabel(resolution: string | null): string {
  return normalizeResolutionLabel(resolution);
}

interface SeriesGroupRow {
  parentTitle: string;
  mediaItemId: string;
  episodeCount: number;
  seasonCount: number;
  totalSize: string;
  lastPlayed: Date | null;
  addedAt: Date | null;
  thumbUrl: string | null;
  qualityCounts: Record<string, number> | null;
  watchedEpisodeCount: number;
  lastEpisodeAiredAt: Date | null;
  isWatchlisted: boolean;
  summary: string | null;
  genres: unknown;
  studio: string | null;
  contentRating: string | null;
  rating: number | null;
  ratingImage: string | null;
  audienceRating: number | null;
  audienceRatingImage: string | null;
  year: number | null;
}

// SQL resolution normalization matching normalizeResolutionLabel()
const RESOLUTION_CASE = `
  CASE
    WHEN mi.resolution IS NULL THEN 'Other'
    WHEN LOWER(REPLACE(mi.resolution, 'p', '')) IN ('4k', '2160') THEN '4K'
    WHEN LOWER(REPLACE(mi.resolution, 'p', '')) = '1080' THEN '1080P'
    WHEN LOWER(REPLACE(mi.resolution, 'p', '')) = '720' THEN '720P'
    WHEN LOWER(REPLACE(mi.resolution, 'p', '')) = '480' THEN '480P'
    WHEN LOWER(REPLACE(mi.resolution, 'p', '')) IN ('360', 'sd') THEN 'SD'
    WHEN mi.resolution ~ '^[0-9]+p?$' THEN
      CASE
        WHEN CAST(REGEXP_REPLACE(mi.resolution, '[^0-9]', '', 'g') AS INTEGER) >= 2000 THEN '4K'
        WHEN CAST(REGEXP_REPLACE(mi.resolution, '[^0-9]', '', 'g') AS INTEGER) >= 900 THEN '1080P'
        WHEN CAST(REGEXP_REPLACE(mi.resolution, '[^0-9]', '', 'g') AS INTEGER) >= 600 THEN '720P'
        WHEN CAST(REGEXP_REPLACE(mi.resolution, '[^0-9]', '', 'g') AS INTEGER) >= 300 THEN '480P'
        ELSE 'SD'
      END
    ELSE 'Other'
  END`;

function sortSeriesList<
  T extends {
    parentTitle: string;
    episodeCount: number;
    seasonCount: number;
    totalSize: string;
    lastPlayed: Date | null;
    addedAt: Date | null;
    watchedEpisodeCount: number;
    lastEpisodeAiredAt: Date | null;
  },
>(list: T[], sortBy: string, sortOrder: string): T[] {
  const dir = sortOrder === "desc" ? -1 : 1;
  return list.sort((a, b) => {
    switch (sortBy) {
      case "episodeCount":
        return (a.episodeCount - b.episodeCount) * dir;
      case "seasonCount":
        return (a.seasonCount - b.seasonCount) * dir;
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
      case "watchedEpisodeCount":
        return (a.watchedEpisodeCount - b.watchedEpisodeCount) * dir;
      case "lastEpisodeAiredAt": {
        const aTime = a.lastEpisodeAiredAt ? new Date(a.lastEpisodeAiredAt).getTime() : 0;
        const bTime = b.lastEpisodeAiredAt ? new Date(b.lastEpisodeAiredAt).getTime() : 0;
        return (aTime - bTime) * dir;
      }
      default:
        return a.parentTitle.localeCompare(b.parentTitle) * dir;
    }
  });
}

/** Parse comparison conditions like "gte:5|lte:20" into filter functions */
function parseConditions(raw: string | null, logic: string): ((val: number) => boolean) | null {
  if (!raw) return null;
  const parts = raw.split("|").filter(Boolean);
  const fns: ((val: number) => boolean)[] = [];
  for (const part of parts) {
    const idx = part.indexOf(":");
    const op = idx === -1 ? "eq" : part.slice(0, idx);
    const num = parseFloat(idx === -1 ? part : part.slice(idx + 1));
    if (isNaN(num)) continue;
    switch (op) {
      case "gt": fns.push((v) => v > num); break;
      case "lt": fns.push((v) => v < num); break;
      case "gte": fns.push((v) => v >= num); break;
      case "lte": fns.push((v) => v <= num); break;
      case "eq":
      default: fns.push((v) => v === num); break;
    }
  }
  if (fns.length === 0) return null;
  return logic === "or"
    ? (val) => fns.some((fn) => fn(val))
    : (val) => fns.every((fn) => fn(val));
}

/** Parse a date filter (min/max range or "last N days") into a predicate */
function parseDateFilter(
  params: URLSearchParams,
  minKey: string,
  maxKey: string,
  daysKey: string,
): ((val: Date | null) => boolean) | null {
  const daysStr = params.get(daysKey);
  if (daysStr) {
    const days = parseInt(daysStr);
    if (isNaN(days) || days <= 0) return null;
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);
    return (val) => val != null && val >= since;
  }
  const minStr = params.get(minKey);
  const maxStr = params.get(maxKey);
  if (!minStr && !maxStr) return null;
  const minDate = minStr ? new Date(minStr) : null;
  const maxDate = maxStr ? new Date(maxStr) : null;
  if (maxDate) maxDate.setHours(23, 59, 59, 999);
  return (val) => {
    if (val == null) return false;
    if (minDate && val < minDate) return false;
    if (maxDate && val > maxDate) return false;
    return true;
  };
}

interface SeriesItem {
  episodeCount: number;
  watchedEpisodeCount: number;
  watchedEpisodePercentage: number;
  lastPlayed: Date | null;
  addedAt: Date | null;
  lastEpisodeAiredAt: Date | null;
  isWatchlisted: boolean;
}

/** Apply post-aggregation filters on series-level fields */
function applySeriesFilters<T extends SeriesItem>(list: T[], params: URLSearchParams): T[] {
  let result = list;

  const episodeCountFilter = parseConditions(params.get("episodeCountConditions"), params.get("episodeCountLogic") ?? "and");
  if (episodeCountFilter) result = result.filter((s) => episodeCountFilter(s.episodeCount));

  const watchedCountFilter = parseConditions(params.get("watchedEpisodeCountConditions"), params.get("watchedEpisodeCountLogic") ?? "and");
  if (watchedCountFilter) result = result.filter((s) => watchedCountFilter(s.watchedEpisodeCount));

  const watchedPctFilter = parseConditions(params.get("watchedEpisodePercentageConditions"), params.get("watchedEpisodePercentageLogic") ?? "and");
  if (watchedPctFilter) result = result.filter((s) => watchedPctFilter(s.watchedEpisodePercentage));

  const lastPlayedFilter = parseDateFilter(params, "lastPlayedAtMin", "lastPlayedAtMax", "lastPlayedAtDays");
  if (lastPlayedFilter) result = result.filter((s) => lastPlayedFilter(s.lastPlayed));

  const addedAtFilter = parseDateFilter(params, "addedAtMin", "addedAtMax", "addedAtDays");
  if (addedAtFilter) result = result.filter((s) => addedAtFilter(s.addedAt));

  const lastAiredFilter = parseDateFilter(params, "lastEpisodeAiredAtMin", "lastEpisodeAiredAtMax", "lastEpisodeAiredAtDays");
  if (lastAiredFilter) result = result.filter((s) => lastAiredFilter(s.lastEpisodeAiredAt));

  const isWatchlisted = params.get("isWatchlisted");
  if (isWatchlisted === "true") result = result.filter((s) => s.isWatchlisted);
  else if (isWatchlisted === "false") result = result.filter((s) => !s.isWatchlisted);

  return result;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") ?? "1");
  const rawLimit = parseInt(searchParams.get("limit") ?? "50");
  const limit = rawLimit === 0 ? 0 : Math.min(rawLimit, 200);
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "parentTitle";
  const sortOrder = searchParams.get("sortOrder") || "asc";
  const serverId = searchParams.get("serverId");
  const startsWith = searchParams.get("startsWith");

  const sf = await resolveServerFilter(session.userId!, serverId, "SERIES");
  if (!sf) {
    return NextResponse.json({ series: [], pagination: { page, limit, hasMore: false } });
  }

  // Multi-server: SQL GROUP BY aggregation (~200 grouped rows vs ~3,500 individual items)
  if (!sf.isSingleServer) {
    const artworkServerId =
      sf.preferredArtworkServerId ?? sf.preferredTitleServerId ?? "";

    const filters: string[] = [];
    const params: unknown[] = [sf.serverIds, artworkServerId];
    let paramIdx = 3;
    if (search) {
      filters.push(`AND mi."parentTitle" ILIKE '%' || $${paramIdx} || '%'`);
      params.push(search);
      paramIdx++;
    }
    if (startsWith) {
      if (startsWith === "#") {
        filters.push(`AND mi."parentTitle" !~* '^[A-Za-z]'`);
      } else {
        filters.push(`AND mi."parentTitle" ILIKE $${paramIdx} || '%'`);
        params.push(startsWith);
        paramIdx++;
      }
    }
    const extraFilters = filters.join("\n            ");

    const [groups, groupServerPresence] = await Promise.all([
      prisma.$queryRawUnsafe<SeriesGroupRow[]>(
        `WITH items AS (
          SELECT
            LOWER(TRIM(mi."parentTitle")) as group_key,
            mi."parentTitle",
            mi.id,
            mi."thumbUrl",
            mi."parentThumbUrl",
            mi."seasonNumber",
            mi."episodeNumber",
            mi."fileSize",
            mi."lastPlayedAt",
            mi."addedAt",
            mi."playCount",
            mi."originallyAvailableAt",
            mi."isWatchlisted",
            mi."summary",
            mi."genres",
            mi."studio",
            mi."contentRating",
            mi."rating",
            mi."ratingImage",
            mi."audienceRating",
            mi."audienceRatingImage",
            mi."year",
            l."mediaServerId",
            ${RESOLUTION_CASE} as resolution_label
          FROM "MediaItem" mi
          JOIN "Library" l ON mi."libraryId" = l.id
          WHERE mi.type = 'SERIES'::"LibraryType"
            AND mi."parentTitle" IS NOT NULL
            AND mi."dedupCanonical" = true
            AND l."mediaServerId" = ANY($1::text[])
            ${extraFilters}
        )
        SELECT
          group_key,
          MIN("parentTitle") as "parentTitle",
          COUNT(*)::int as "episodeCount",
          COUNT(DISTINCT "seasonNumber")::int as "seasonCount",
          COALESCE(SUM("fileSize"), 0)::text as "totalSize",
          MAX("lastPlayedAt") as "lastPlayed",
          MAX("addedAt") as "addedAt",
          COUNT(*) FILTER (WHERE "playCount" > 0)::int as "watchedEpisodeCount",
          MAX("originallyAvailableAt") as "lastEpisodeAiredAt",
          BOOL_OR("isWatchlisted") as "isWatchlisted",
          COALESCE(
            (array_agg("parentThumbUrl" ORDER BY
              CASE WHEN "mediaServerId" = $2 THEN 0 ELSE 1 END
            ) FILTER (WHERE "parentThumbUrl" IS NOT NULL))[1],
            (array_agg("thumbUrl" ORDER BY
              CASE WHEN "mediaServerId" = $2 THEN 0 ELSE 1 END
            ) FILTER (WHERE "thumbUrl" IS NOT NULL))[1]
          ) as "thumbUrl",
          COALESCE(
            (array_agg(id ORDER BY
              CASE WHEN "mediaServerId" = $2 THEN 0 ELSE 1 END
            ) FILTER (WHERE "parentThumbUrl" IS NOT NULL))[1],
            (array_agg(id ORDER BY
              CASE WHEN "mediaServerId" = $2 THEN 0 ELSE 1 END
            ) FILTER (WHERE "thumbUrl" IS NOT NULL))[1],
            (array_agg(id))[1]
          ) as "mediaItemId",
          jsonb_strip_nulls(jsonb_build_object(
            '4K', NULLIF(COUNT(*) FILTER (WHERE resolution_label = '4K'), 0),
            '1080P', NULLIF(COUNT(*) FILTER (WHERE resolution_label = '1080P'), 0),
            '720P', NULLIF(COUNT(*) FILTER (WHERE resolution_label = '720P'), 0),
            '480P', NULLIF(COUNT(*) FILTER (WHERE resolution_label = '480P'), 0),
            'SD', NULLIF(COUNT(*) FILTER (WHERE resolution_label = 'SD'), 0),
            'Other', NULLIF(COUNT(*) FILTER (WHERE resolution_label = 'Other'), 0)
          )) as "qualityCounts",
          (array_agg("summary" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "summary" IS NOT NULL))[1] as "summary",
          (array_agg("genres" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "genres" IS NOT NULL))[1] as "genres",
          (array_agg("studio" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "studio" IS NOT NULL))[1] as "studio",
          (array_agg("contentRating" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "contentRating" IS NOT NULL))[1] as "contentRating",
          (array_agg("rating" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "rating" IS NOT NULL))[1] as "rating",
          (array_agg("ratingImage" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "ratingImage" IS NOT NULL))[1] as "ratingImage",
          (array_agg("audienceRating" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "audienceRating" IS NOT NULL))[1] as "audienceRating",
          (array_agg("audienceRatingImage" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "audienceRatingImage" IS NOT NULL))[1] as "audienceRatingImage",
          (array_agg("year" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "year" IS NOT NULL))[1] as "year"
        FROM items
        GROUP BY group_key`,
        ...params,
      ),
      getServerPresenceByGroup("SERIES", sf.serverIds),
    ]);

    let seriesList = groups.map((g) => ({
      parentTitle: g.parentTitle,
      mediaItemId: g.mediaItemId,
      episodeCount: g.episodeCount,
      seasonCount: g.seasonCount,
      totalSize: g.totalSize,
      lastPlayed: g.lastPlayed,
      addedAt: g.addedAt,
      watchedEpisodeCount: g.watchedEpisodeCount,
      watchedEpisodePercentage: g.episodeCount > 0 ? Math.round((g.watchedEpisodeCount / g.episodeCount) * 100) : 0,
      lastEpisodeAiredAt: g.lastEpisodeAiredAt,
      isWatchlisted: g.isWatchlisted,
      qualityCounts: (g.qualityCounts ?? {}) as Record<string, number>,
      thumbUrl: g.thumbUrl,
      servers: groupServerPresence.get(g.parentTitle.toLowerCase().trim()) ?? [],
      summary: g.summary,
      genres: g.genres as string[] | null,
      studio: g.studio,
      contentRating: g.contentRating,
      rating: g.rating,
      ratingImage: g.ratingImage,
      audienceRating: g.audienceRating,
      audienceRatingImage: g.audienceRatingImage,
      year: g.year,
    }));

    // Post-aggregation filters on series-level computed fields
    seriesList = applySeriesFilters(seriesList, searchParams);

    const sorted = sortSeriesList(seriesList, sortBy, sortOrder);
    if (limit > 0) {
      const offset = (page - 1) * limit;
      const paged = sorted.slice(offset, offset + limit + 1);
      const hasMore = paged.length > limit;
      if (hasMore) paged.pop();
      return NextResponse.json({ series: paged, pagination: { page, limit, hasMore } });
    }
    return NextResponse.json({ series: sorted, pagination: { page, limit, hasMore: false } });
  }

  // Single-server: Prisma findMany + JS aggregation (already efficient)
  const whereClause: Record<string, unknown> = {
    type: "SERIES" as const,
    parentTitle: { not: null },
    library: { mediaServerId: { in: sf.serverIds } },
  };

  if (search) {
    whereClause.parentTitle = {
      contains: search,
      mode: "insensitive",
      not: null,
    };
  }

  if (startsWith) applyStartsWithFilter(whereClause, "parentTitle", startsWith);

  const items = await prisma.mediaItem.findMany({
    where: whereClause,
    select: {
      id: true,
      parentTitle: true,
      thumbUrl: true,
      parentThumbUrl: true,
      seasonNumber: true,
      episodeNumber: true,
      resolution: true,
      fileSize: true,
      lastPlayedAt: true,
      addedAt: true,
      playCount: true,
      originallyAvailableAt: true,
      isWatchlisted: true,
      summary: true,
      genres: true,
      studio: true,
      contentRating: true,
      rating: true,
      ratingImage: true,
      audienceRating: true,
      audienceRatingImage: true,
      year: true,
      library: {
        select: {
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  const groupMap = new Map<
    string,
    {
      parentTitle: string;
      mediaItemId: string;
      thumbUrl: string | null;
      episodeCount: number;
      seasonNumbers: Set<number>;
      totalSize: bigint;
      lastPlayed: Date | null;
      addedAt: Date | null;
      watchedEpisodeCount: number;
      lastEpisodeAiredAt: Date | null;
      isWatchlisted: boolean;
      qualityCounts: Record<string, number>;
      servers: Map<string, ServerPresence>;
      summary: string | null;
      genres: string[] | null;
      studio: string | null;
      contentRating: string | null;
      rating: number | null;
      ratingImage: string | null;
      audienceRating: number | null;
      audienceRatingImage: string | null;
      year: number | null;
    }
  >();

  for (const item of items) {
    const title = item.parentTitle!;
    const normalizedKey = title.toLowerCase().trim();
    let group = groupMap.get(normalizedKey);
    if (!group) {
      group = {
        parentTitle: title,
        mediaItemId: item.id,
        thumbUrl: item.thumbUrl,
        episodeCount: 0,
        seasonNumbers: new Set(),
        totalSize: BigInt(0),
        lastPlayed: null,
        addedAt: null,
        watchedEpisodeCount: 0,
        lastEpisodeAiredAt: null,
        isWatchlisted: false,
        qualityCounts: {},
        servers: new Map(),
        summary: null,
        genres: null,
        studio: null,
        contentRating: null,
        rating: null,
        ratingImage: null,
        audienceRating: null,
        audienceRatingImage: null,
        year: null,
      };
      groupMap.set(normalizedKey, group);
    }

    const ms = item.library.mediaServer!;
    if (!group.servers.has(ms.id)) {
      group.servers.set(ms.id, {
        serverId: ms.id,
        serverName: ms.name,
        serverType: ms.type,
        mediaItemId: item.id,
      });
    }

    group.episodeCount++;
    if (item.playCount > 0) group.watchedEpisodeCount++;
    if (item.isWatchlisted) group.isWatchlisted = true;
    if (item.seasonNumber != null) {
      group.seasonNumbers.add(item.seasonNumber);
    }
    if (item.fileSize) {
      group.totalSize += item.fileSize;
    }
    if (
      item.lastPlayedAt &&
      (!group.lastPlayed || item.lastPlayedAt > group.lastPlayed)
    ) {
      group.lastPlayed = item.lastPlayedAt;
    }
    if (item.addedAt && (!group.addedAt || item.addedAt > group.addedAt)) {
      group.addedAt = item.addedAt;
    }
    if (item.originallyAvailableAt && (!group.lastEpisodeAiredAt || item.originallyAvailableAt > group.lastEpisodeAiredAt)) {
      group.lastEpisodeAiredAt = item.originallyAvailableAt;
    }
    if (item.parentThumbUrl && !group.thumbUrl) {
      group.thumbUrl = item.parentThumbUrl;
      group.mediaItemId = item.id;
    } else if (!group.thumbUrl && item.thumbUrl) {
      group.thumbUrl = item.thumbUrl;
      group.mediaItemId = item.id;
    }
    const label = getResolutionLabel(item.resolution);
    group.qualityCounts[label] = (group.qualityCounts[label] || 0) + 1;

    // Pick first non-null metadata (show-level fields are typically the same across episodes)
    if (!group.summary && item.summary) group.summary = item.summary;
    if (!group.genres && item.genres) group.genres = item.genres as string[];
    if (!group.studio && item.studio) group.studio = item.studio;
    if (!group.contentRating && item.contentRating) group.contentRating = item.contentRating;
    if (group.rating == null && item.rating != null) group.rating = item.rating;
    if (!group.ratingImage && item.ratingImage) group.ratingImage = item.ratingImage;
    if (group.audienceRating == null && item.audienceRating != null) group.audienceRating = item.audienceRating;
    if (!group.audienceRatingImage && item.audienceRatingImage) group.audienceRatingImage = item.audienceRatingImage;
    if (group.year == null && item.year != null) group.year = item.year;
  }

  let seriesList = Array.from(groupMap.values()).map((g) => ({
    parentTitle: g.parentTitle,
    mediaItemId: g.mediaItemId,
    episodeCount: g.episodeCount,
    seasonCount: g.seasonNumbers.size,
    totalSize: g.totalSize.toString(),
    lastPlayed: g.lastPlayed,
    addedAt: g.addedAt,
    watchedEpisodeCount: g.watchedEpisodeCount,
    watchedEpisodePercentage: g.episodeCount > 0 ? Math.round((g.watchedEpisodeCount / g.episodeCount) * 100) : 0,
    lastEpisodeAiredAt: g.lastEpisodeAiredAt,
    isWatchlisted: g.isWatchlisted,
    qualityCounts: g.qualityCounts,
    thumbUrl: g.thumbUrl,
    servers: Array.from(g.servers.values()).sort((a, b) =>
      a.serverName.localeCompare(b.serverName),
    ),
    summary: g.summary,
    genres: g.genres,
    studio: g.studio,
    contentRating: g.contentRating,
    rating: g.rating,
    ratingImage: g.ratingImage,
    audienceRating: g.audienceRating,
    audienceRatingImage: g.audienceRatingImage,
    year: g.year,
  }));

  // Post-aggregation filters on series-level computed fields
  seriesList = applySeriesFilters(seriesList, searchParams);

  const sorted = sortSeriesList(seriesList, sortBy, sortOrder);
  if (limit > 0) {
    const offset = (page - 1) * limit;
    const paged = sorted.slice(offset, offset + limit + 1);
    const hasMore = paged.length > limit;
    if (hasMore) paged.pop();
    return NextResponse.json({ series: paged, pagination: { page, limit, hasMore } });
  }
  return NextResponse.json({ series: sorted, pagination: { page, limit, hasMore: false } });
}
