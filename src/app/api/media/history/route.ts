import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 200);
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") ?? "watchedAt";
  const sortOrder =
    searchParams.get("sortOrder") === "asc" ? "asc" : "desc";
  const serverId = searchParams.get("serverId");
  const startsWith = searchParams.get("startsWith");
  const typeFilter = searchParams.get("type");
  const usernameFilter = searchParams.get("username");
  const deviceFilter = searchParams.get("deviceName");
  const platformFilter = searchParams.get("platform");
  const resolution = searchParams.get("resolution");
  const dynamicRange = searchParams.get("dynamicRange");
  const videoCodec = searchParams.get("videoCodec");
  const audioCodec = searchParams.get("audioCodec");

  // Build WHERE conditions and params
  const conditions: string[] = ['ms."userId" = $1'];
  const params: unknown[] = [session.userId];
  let paramIdx = 2;

  if (serverId) {
    conditions.push(`wh."mediaServerId" = $${paramIdx++}`);
    params.push(serverId);
  }

  if (usernameFilter) {
    const vals = usernameFilter.split("|").filter(Boolean);
    if (vals.length === 1) {
      conditions.push(`wh."serverUsername" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      conditions.push(`wh."serverUsername" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  if (deviceFilter) {
    const vals = deviceFilter.split("|").filter(Boolean);
    if (vals.length === 1) {
      conditions.push(`wh."deviceName" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      conditions.push(`wh."deviceName" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  if (platformFilter) {
    const vals = platformFilter.split("|").filter(Boolean);
    if (vals.length === 1) {
      conditions.push(`wh."platform" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      conditions.push(`wh."platform" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  if (typeFilter) {
    const vals = typeFilter.split("|").filter(Boolean);
    if (vals.length === 1) {
      conditions.push(`mi."type" = $${paramIdx++}::"LibraryType"`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}::"LibraryType"`).join(",");
      conditions.push(`mi."type" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  if (search) {
    conditions.push(`mi."title" ILIKE $${paramIdx++}`);
    params.push(`%${search}%`);
  }

  if (startsWith) {
    if (startsWith === "#") {
      conditions.push(`mi."title" !~ '^[A-Za-z]'`);
    } else {
      conditions.push(`UPPER(LEFT(mi."titleSort", 1)) = $${paramIdx++}`);
      params.push(startsWith.toUpperCase());
    }
  }

  if (resolution) {
    const vals = resolution.split("|").filter(Boolean);
    if (vals.length === 1) {
      conditions.push(`mi."resolution" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      conditions.push(`mi."resolution" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  if (dynamicRange) {
    const vals = dynamicRange.split("|").filter(Boolean);
    if (vals.length === 1) {
      conditions.push(`mi."dynamicRange" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      conditions.push(`mi."dynamicRange" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  if (videoCodec) {
    const vals = videoCodec.split("|").filter(Boolean);
    if (vals.length === 1) {
      conditions.push(`mi."videoCodec" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      conditions.push(`mi."videoCodec" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  if (audioCodec) {
    const vals = audioCodec.split("|").filter(Boolean);
    if (vals.length === 1) {
      conditions.push(`mi."audioCodec" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      conditions.push(`mi."audioCodec" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  const whereClause = conditions.join(" AND ");

  // Build ORDER BY — always sort server-side for paginated results
  const SORT_MAP: Record<string, string> = {
    watchedAt: 'wh."watchedAt"',
    serverUsername: 'wh."serverUsername"',
    deviceName: 'wh."deviceName"',
    platform: 'wh."platform"',
    title: 'mi."titleSort"',
    type: 'mi."type"',
    year: 'mi."year"',
    resolution: 'mi."resolution"',
    duration: 'mi."duration"',
    fileSize: 'mi."fileSize"',
  };
  const orderCol = SORT_MAP[sortBy] ?? 'wh."watchedAt"';
  const orderDir = sortOrder === "asc" ? "ASC" : "DESC";

  // Cached filter dropdown values — only change when watch history syncs
  const filterCacheKey = `watch-history-filters:${session.userId}`;
  const filterValuesP = appCache.getOrSet(filterCacheKey, async () => {
    const distinctRows = await prisma.$queryRawUnsafe<Array<{
      serverUsername: string;
      deviceName: string | null;
      platform: string | null;
    }>>(
      `SELECT DISTINCT wh."serverUsername", wh."deviceName", wh."platform"
       FROM "WatchHistory" wh
       JOIN "MediaServer" ms ON ms."id" = wh."mediaServerId"
       WHERE ms."userId" = $1`,
      session.userId,
    );
    const usernameSet = new Set<string>();
    const deviceSet = new Set<string>();
    const platformSet = new Set<string>();
    for (const r of distinctRows) {
      usernameSet.add(r.serverUsername);
      if (r.deviceName) deviceSet.add(r.deviceName);
      if (r.platform) platformSet.add(r.platform);
    }
    return {
      usernames: [...usernameSet].sort(),
      deviceNames: [...deviceSet].sort(),
      platforms: [...platformSet].sort(),
    };
  });

  // Count + main query + filter values — all in parallel
  const fromClause = `FROM "WatchHistory" wh
    JOIN "MediaItem" mi ON mi."id" = wh."mediaItemId"
    JOIN "MediaServer" ms ON ms."id" = wh."mediaServerId"
    WHERE ${whereClause}`;

  const countP = prisma.$queryRawUnsafe<[{ count: bigint }]>(
    `SELECT COUNT(*) AS "count" ${fromClause}`,
    ...params,
  );

  const mainQueryP = prisma.$queryRawUnsafe<Array<{
    id: string;
    serverUsername: string;
    watchedAt: Date | null;
    deviceName: string | null;
    platform: string | null;
    mi_id: string;
    mi_title: string;
    mi_titleSort: string | null;
    mi_parentTitle: string | null;
    mi_seasonNumber: number | null;
    mi_episodeNumber: number | null;
    mi_year: number | null;
    mi_type: string;
    mi_resolution: string | null;
    mi_dynamicRange: string | null;
    mi_videoCodec: string | null;
    mi_audioCodec: string | null;
    mi_audioChannels: number | null;
    mi_audioProfile: string | null;
    mi_fileSize: bigint | null;
    mi_duration: number | null;
    mi_summary: string | null;
    mi_contentRating: string | null;
    mi_rating: number | null;
    mi_audienceRating: number | null;
    mi_studio: string | null;
    mi_playCount: number;
    mi_lastPlayedAt: Date | null;
    mi_addedAt: Date | null;
    mi_genres: unknown;
    ms_id: string;
    ms_name: string;
    ms_type: string;
  }>>(
    `SELECT
      wh."id", wh."serverUsername", wh."watchedAt", wh."deviceName", wh."platform",
      mi."id" AS "mi_id", mi."title" AS "mi_title", mi."titleSort" AS "mi_titleSort",
      mi."parentTitle" AS "mi_parentTitle", mi."seasonNumber" AS "mi_seasonNumber",
      mi."episodeNumber" AS "mi_episodeNumber", mi."year" AS "mi_year",
      mi."type" AS "mi_type", mi."resolution" AS "mi_resolution",
      mi."dynamicRange" AS "mi_dynamicRange", mi."videoCodec" AS "mi_videoCodec",
      mi."audioCodec" AS "mi_audioCodec", mi."audioChannels" AS "mi_audioChannels",
      mi."audioProfile" AS "mi_audioProfile",
      mi."fileSize" AS "mi_fileSize", mi."duration" AS "mi_duration",
      mi."summary" AS "mi_summary", mi."contentRating" AS "mi_contentRating",
      mi."rating" AS "mi_rating", mi."audienceRating" AS "mi_audienceRating",
      mi."studio" AS "mi_studio", mi."playCount" AS "mi_playCount",
      mi."lastPlayedAt" AS "mi_lastPlayedAt", mi."addedAt" AS "mi_addedAt",
      mi."genres" AS "mi_genres",
      ms."id" AS "ms_id", ms."name" AS "ms_name", ms."type" AS "ms_type"
    ${fromClause}
    ORDER BY ${orderCol} ${orderDir} NULLS LAST
    LIMIT ${limit + 1} OFFSET ${(page - 1) * limit}`,
    ...params,
  );

  const [rows, countResult, filterValues] = await Promise.all([mainQueryP, countP, filterValuesP]);

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const totalCount = Number(countResult[0].count);

  const items = rows.map((r) => ({
    id: r.id,
    serverUsername: r.serverUsername,
    watchedAt: r.watchedAt?.toISOString() ?? null,
    deviceName: r.deviceName,
    platform: r.platform,
    mediaItem: {
      id: r.mi_id,
      title: r.mi_title,
      titleSort: r.mi_titleSort,
      parentTitle: r.mi_parentTitle,
      seasonNumber: r.mi_seasonNumber,
      episodeNumber: r.mi_episodeNumber,
      year: r.mi_year,
      type: r.mi_type,
      resolution: r.mi_resolution,
      dynamicRange: r.mi_dynamicRange,
      videoCodec: r.mi_videoCodec,
      audioCodec: r.mi_audioCodec,
      audioChannels: r.mi_audioChannels,
      audioProfile: r.mi_audioProfile,
      fileSize: r.mi_fileSize?.toString() ?? null,
      duration: r.mi_duration,
      summary: r.mi_summary,
      contentRating: r.mi_contentRating,
      rating: r.mi_rating,
      audienceRating: r.mi_audienceRating,
      studio: r.mi_studio,
      playCount: r.mi_playCount,
      lastPlayedAt: r.mi_lastPlayedAt?.toISOString() ?? null,
      addedAt: r.mi_addedAt?.toISOString() ?? null,
      genres: Array.isArray(r.mi_genres) ? r.mi_genres as string[] : null,
    },
    server: {
      id: r.ms_id,
      name: r.ms_name,
      type: r.ms_type,
    },
  }));

  return NextResponse.json({
    items,
    pagination: { page, limit, hasMore, totalCount },
    ...filterValues,
  });
}
