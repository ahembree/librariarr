import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { escapeLike } from "@/lib/filters/escape-like";
import { RESOLUTION_DB_VALUES } from "@/lib/conditions/constants";
import { appCache } from "@/lib/cache/memory-cache";
import { jsonResponse } from "@/lib/api/json-response";
import { clampSkip, parsePage } from "@/lib/api/pagination";

/**
 * How deep a descending page may reach before the index walk below costs more
 * than sorting every play: ~20k rows at 150k plays, measured. 10,000 is the
 * first hundred pages of the History table.
 */
const SPLIT_MAX_REACH = 10_000;

/** Upper bound for the cached filter dropdown values (see below). */
const FILTER_VALUES_TTL_MS = 10 * 60_000;

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parsePage(searchParams);
  const rawLimit = parseInt(searchParams.get("limit") ?? "50");
  // Floor at 1 and cap at 200 — a negative/zero limit produced LIMIT 0 or a
  // negative OFFSET (Postgres rejects negative OFFSET → 500). The OFFSET below
  // goes through `clampSkip` for the other end: `page=99999999999999999999`
  // was a 500 (`ValueOutOfRange`) where it should be an empty page.
  const limit = Math.max(1, Math.min(Number.isNaN(rawLimit) ? 50 : rawLimit, 200));
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

  // Cast to "LibraryType" in SQL, so an unknown value would fail the query
  // (500) rather than simply match nothing.
  const typeValues = typeFilter?.split("|").filter(Boolean) ?? [];
  if (typeValues.some((t) => !["MOVIE", "SERIES", "MUSIC"].includes(t))) {
    return NextResponse.json(
      { error: "Invalid type. Must be MOVIE, SERIES, or MUSIC (pipe-separated)" },
      { status: 400 }
    );
  }

  // Build WHERE conditions and params. Conditions that read the `MediaItem`
  // join go in `itemConditions`, so the count below can tell whether it needs
  // that join without sniffing SQL text. Each condition carries its own `$n`,
  // so the two buckets can be joined in any order.
  const conditions: string[] = ['ms."userId" = $1'];
  const itemConditions: string[] = [];
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

  if (typeValues.length === 1) {
    itemConditions.push(`mi."type" = $${paramIdx++}::"LibraryType"`);
    params.push(typeValues[0]);
  } else if (typeValues.length > 1) {
    const placeholders = typeValues.map(() => `$${paramIdx++}::"LibraryType"`).join(",");
    itemConditions.push(`mi."type" IN (${placeholders})`);
    params.push(...typeValues);
  }

  if (search) {
    // `escapeLike`: `search` is spliced into an ILIKE pattern. Live,
    // `?search=%` matched every play and a `%_%_%_…` pattern cost ~10× the
    // CPU of a plain search on this route (see escape-like.ts).
    const pattern = `%${escapeLike(search)}%`;
    itemConditions.push(`(mi."title" ILIKE $${paramIdx++} OR mi."parentTitle" ILIKE $${paramIdx++})`);
    params.push(pattern, pattern);
  }

  if (startsWith) {
    // Both branches key off the same field (titleSort, falling back to title)
    // so the non-alpha "#" bucket and the A-Z buckets stay consistent.
    if (startsWith === "#") {
      itemConditions.push(`COALESCE(mi."titleSort", mi."title") !~ '^[A-Za-z]'`);
    } else {
      itemConditions.push(`UPPER(LEFT(COALESCE(mi."titleSort", mi."title"), 1)) = $${paramIdx++}`);
      params.push(startsWith.toUpperCase());
    }
  }

  if (resolution) {
    const vals = resolution.split("|").filter(Boolean);
    // Expand display labels to all matching DB values
    const dbVals = vals.flatMap((v) => RESOLUTION_DB_VALUES[v] ?? [v]);
    if (dbVals.length === 1) {
      itemConditions.push(`LOWER(mi."resolution") = LOWER($${paramIdx++})`);
      params.push(dbVals[0]);
    } else if (dbVals.length > 1) {
      const placeholders = dbVals.map(() => `LOWER($${paramIdx++})`).join(",");
      itemConditions.push(`LOWER(mi."resolution") IN (${placeholders})`);
      params.push(...dbVals);
    }
  }

  if (dynamicRange) {
    const vals = dynamicRange.split("|").filter(Boolean);
    if (vals.length === 1) {
      itemConditions.push(`mi."dynamicRange" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      itemConditions.push(`mi."dynamicRange" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  if (videoCodec) {
    const vals = videoCodec.split("|").filter(Boolean);
    if (vals.length === 1) {
      itemConditions.push(`mi."videoCodec" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      itemConditions.push(`mi."videoCodec" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  if (audioCodec) {
    const vals = audioCodec.split("|").filter(Boolean);
    if (vals.length === 1) {
      itemConditions.push(`mi."audioCodec" = $${paramIdx++}`);
      params.push(vals[0]);
    } else if (vals.length > 1) {
      const placeholders = vals.map(() => `$${paramIdx++}`).join(",");
      itemConditions.push(`mi."audioCodec" IN (${placeholders})`);
      params.push(...vals);
    }
  }

  const whereClause = [...conditions, ...itemConditions].join(" AND ");

  // Build ORDER BY — always sort server-side for paginated results.
  // This is a strict whitelist: `sortBy` is interpolated into the SQL, so an
  // unknown value must fall back to the default rather than reach the query.
  const SORT_MAP: Record<string, string> = {
    watchedAt: 'wh."watchedAt"',
    serverUsername: 'wh."serverUsername"',
    deviceName: 'wh."deviceName"',
    platform: 'wh."platform"',
    title: 'mi."titleSort"',
    type: 'mi."type"',
    year: 'mi."year"',
    resolution: 'mi."resolution"',
    // The History page's HDR, codec and Server columns. All are sortable
    // headers, and without a key here they silently fell back to `watchedAt`
    // (HDR kept its own sort arrow while doing so), and Server sent
    // `serverUsername` — the User column.
    dynamicRange: 'mi."dynamicRange"',
    videoCodec: 'mi."videoCodec"',
    audioCodec: 'mi."audioCodec"',
    serverName: 'ms."name"',
    duration: 'mi."duration"',
    fileSize: 'mi."fileSize"',
    // Tracearr-sourced play columns. `streamResolution` is deliberately a
    // separate key from `resolution`: the latter is the FILE's resolution on
    // the MediaItem, this one is the resolution actually delivered to the
    // client, and a transcoded 4K file streamed at 1080p differs on the two.
    percentComplete: 'wh."percentComplete"',
    isTranscode: 'wh."isTranscode"',
    player: 'wh."player"',
    streamResolution: 'wh."resolution"',
  };
  // `Object.hasOwn`, not a bare lookup: `SORT_MAP["constructor"]` resolves up
  // the prototype chain to a function, which is truthy, so `?? default` would
  // not catch it and the function's source text would be interpolated into the
  // ORDER BY. Not exploitable (the attacker controls no part of that text, and
  // Postgres just rejects it) but it turns a bogus `sortBy` into a 500 instead
  // of the documented fallback. Now that the map is user-extensible via the new
  // Tracearr columns, pin the lookup to own properties.
  const orderCol = Object.hasOwn(SORT_MAP, sortBy)
    ? SORT_MAP[sortBy]
    : 'wh."watchedAt"';
  const orderDir = sortOrder === "asc" ? "ASC" : "DESC";
  // The sort keys that are columns of the play itself, and the name each has in
  // the select list below.
  const PLAY_SORT_OUTPUT: Record<string, string> = {
    'wh."watchedAt"': '"watchedAt"',
    'wh."serverUsername"': '"serverUsername"',
    'wh."deviceName"': '"deviceName"',
    'wh."platform"': '"platform"',
    'wh."percentComplete"': '"percentComplete"',
    'wh."isTranscode"': '"isTranscode"',
    'wh."player"': '"player"',
    'wh."resolution"': '"wh_resolution"',
  };
  // The ORDER BY below appends wh."id" as a unique tiebreaker so the sort is a
  // total order. Without one Postgres may return tied rows in any order, and a
  // bounded page (top-N heapsort) is planned differently from its neighbour, so
  // the tie block straddling the page boundary permutes between requests — a
  // paged-through list then shows some plays twice and silently drops others.
  // The Tracearr sorts above make that near-certain rather than unlikely:
  // `isTranscode` has two distinct values and `percentComplete`/`player`/
  // `resolution` are NULL on every NATIVE row, so one tie block can cover the
  // whole table.

  // Cached filter dropdown values — only change when watch history syncs, and
  // every write of watch history ends in `invalidateMediaCaches()`, which drops
  // this prefix; the TTL is only an upper bound. At the 60 s default nearly
  // every visit re-read every play for them (~35 ms at 150k plays).
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
  }, FILTER_VALUES_TTL_MS);

  // Count + main query + filter values — all in parallel
  const fromClause = `FROM "WatchHistory" wh
    JOIN "MediaItem" mi ON mi."id" = wh."mediaItemId"
    JOIN "MediaServer" ms ON ms."id" = wh."mediaServerId"
    WHERE ${whereClause}`;

  // The count only needs the MediaItem join when a condition reads `mi.`;
  // the join is one index probe per play, and without it the count is an
  // index-only scan. Measured at 141k plays: 65 ms → 9 ms for the unfiltered
  // page every History visit starts on.
  const needsItemJoin = itemConditions.length > 0;
  const countP = prisma.$queryRawUnsafe<[{ count: bigint }]>(
    `SELECT COUNT(*) AS "count" FROM "WatchHistory" wh
    ${needsItemJoin ? `JOIN "MediaItem" mi ON mi."id" = wh."mediaItemId"` : ""}
    JOIN "MediaServer" ms ON ms."id" = wh."mediaServerId"
    WHERE ${whereClause}`,
    ...params,
  );

  const selectList = `
      wh."id", wh."serverUsername", wh."watchedAt", wh."deviceName", wh."platform",
      wh."source", wh."watched", wh."percentComplete", wh."isTranscode",
      wh."videoDecision", wh."audioDecision", wh."player", wh."product",
      wh."resolution" AS "wh_resolution", wh."bitrate", wh."segmentCount",
      wh."durationMs", wh."totalDurationMs", wh."progressMs",
      mi."id" AS "mi_id", mi."title" AS "mi_title", mi."titleSort" AS "mi_titleSort",
      mi."parentTitle" AS "mi_parentTitle", mi."seasonNumber" AS "mi_seasonNumber",
      mi."episodeNumber" AS "mi_episodeNumber", mi."year" AS "mi_year",
      mi."type" AS "mi_type", mi."resolution" AS "mi_resolution",
      mi."dynamicRange" AS "mi_dynamicRange", mi."videoCodec" AS "mi_videoCodec",
      mi."audioCodec" AS "mi_audioCodec", mi."audioChannels" AS "mi_audioChannels",
      mi."audioProfile" AS "mi_audioProfile",
      mi."fileSize" AS "mi_fileSize", mi."duration" AS "mi_duration",
      mi."summary" AS "mi_summary", mi."contentRating" AS "mi_contentRating",
      mi."rating" AS "mi_rating", mi."ratingImage" AS "mi_ratingImage",
      mi."audienceRating" AS "mi_audienceRating", mi."audienceRatingImage" AS "mi_audienceRatingImage",
      mi."studio" AS "mi_studio", mi."playCount" AS "mi_playCount",
      mi."lastPlayedAt" AS "mi_lastPlayedAt", mi."addedAt" AS "mi_addedAt",
      mi."genres" AS "mi_genres",
      ms."id" AS "ms_id", ms."name" AS "ms_name", ms."type" AS "ms_type"`;

  // Newest first — the order every visit opens on — is a walk of the
  // `watchedAt` index, not a sort of every play. `DESC NULLS LAST` matches no
  // B-tree index (a backward scan yields NULLS FIRST), so the query used to sort
  // every play to return 100 of them: ~45 ms at 150k plays, on every page and
  // every filter change. It is split instead: the non-null rows, which the
  // index serves in order, then the null ones — read only when the page reaches
  // past every non-null row, since walking for them is what the planner gets
  // wrong (on rows whose nulls cluster at the end of the primary key it walked
  // the whole key). Same rows, same order. The same holds for every other
  // descending sort on a column of the play itself; ascending sorts (NULLS
  // LAST is the default there) already match an index. Past `SPLIT_MAX_REACH`
  // rows the walk costs more than the sort, so deep pages keep the plain query.
  const offset = clampSkip((page - 1) * limit);
  const reach = offset + limit + 1;
  const playSortColumn = orderDir === "DESC" && reach <= SPLIT_MAX_REACH
    ? PLAY_SORT_OUTPUT[orderCol]
    : undefined;
  const pageSql = playSortColumn
    ? `WITH ranked AS (
        SELECT ${selectList} ${fromClause} AND ${orderCol} IS NOT NULL
        ORDER BY ${orderCol} DESC, wh."id" ASC LIMIT ${reach}
      )
      SELECT * FROM (
        SELECT * FROM ranked
        UNION ALL
        (SELECT ${selectList} ${fromClause} AND ${orderCol} IS NULL
          AND (SELECT COUNT(*) FROM ranked) < ${reach}
          ORDER BY wh."id" ASC LIMIT ${reach})
      ) candidates
      ORDER BY candidates.${playSortColumn} DESC NULLS LAST, candidates."id" ASC
      LIMIT ${limit + 1} OFFSET ${offset}`
    : `SELECT ${selectList} ${fromClause}
      ORDER BY ${orderCol} ${orderDir} NULLS LAST, wh."id" ASC
      LIMIT ${limit + 1} OFFSET ${offset}`;

  const mainQueryP = prisma.$queryRawUnsafe<Array<{
    id: string;
    serverUsername: string;
    watchedAt: Date | null;
    deviceName: string | null;
    platform: string | null;
    // Provenance + the Tracearr-only playback columns. Every one of these is
    // null on a NATIVE row (the media servers' own history APIs report a play
    // event, not a completion percentage or a transcode decision), so the
    // table renders them as optional, default-hidden columns.
    source: string;
    watched: boolean | null;
    percentComplete: number | null;
    isTranscode: boolean | null;
    videoDecision: string | null;
    audioDecision: string | null;
    player: string | null;
    product: string | null;
    wh_resolution: string | null;
    bitrate: number | null;
    segmentCount: number | null;
    durationMs: number | null;
    totalDurationMs: number | null;
    progressMs: number | null;
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
    mi_ratingImage: string | null;
    mi_audienceRating: number | null;
    mi_audienceRatingImage: string | null;
    mi_studio: string | null;
    mi_playCount: number;
    mi_lastPlayedAt: Date | null;
    mi_addedAt: Date | null;
    mi_genres: unknown;
    ms_id: string;
    ms_name: string;
    ms_type: string;
  }>>(
    pageSql,
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
    source: r.source,
    watched: r.watched,
    percentComplete: r.percentComplete,
    isTranscode: r.isTranscode,
    videoDecision: r.videoDecision,
    audioDecision: r.audioDecision,
    player: r.player,
    product: r.product,
    // The resolution the client was actually served, which differs from
    // mediaItem.resolution (the file) whenever the stream was transcoded down.
    resolution: r.wh_resolution,
    bitrate: r.bitrate,
    segmentCount: r.segmentCount,
    durationMs: r.durationMs,
    totalDurationMs: r.totalDurationMs,
    progressMs: r.progressMs,
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
      ratingImage: r.mi_ratingImage,
      audienceRating: r.mi_audienceRating,
      audienceRatingImage: r.mi_audienceRatingImage,
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

  return jsonResponse(request, {
    items,
    pagination: { page, limit, hasMore, totalCount },
    ...filterValues,
  });
}
