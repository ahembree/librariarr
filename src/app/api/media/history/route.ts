import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { escapeLike } from "@/lib/filters/escape-like";
import { appCache } from "@/lib/cache/memory-cache";
import { jsonResponse } from "@/lib/api/json-response";
import { clampSkip } from "@/lib/api/pagination";
import { historySortSql } from "@/lib/media/history-sort";
import { QUALITY_ORDER, resolutionLabelSql } from "@/lib/resolution";

/**
 * A play the native sync filed against several library copies of one item
 * (Jellyfin/Emby can list an item in two libraries over the same folder) is
 * stored once per copy, every row but the primary's pointing at the primary
 * copy through `fanOutOfItemId`. Each copy has to read as watched to the
 * per-item consumers (rules, play counts), but this route lists PLAYS, so it
 * shows the primary row only. The rows of one play share its server, user,
 * device and time, and their items are the same file, so every filter here
 * keeps or drops them together. Deleting the primary's item cascades its row
 * away and the FK's `SetNull` clears the pointer on EVERY remaining copy: with
 * two copies the survivor is the play's only record and is listed once, but
 * with three or more each survivor becomes a primary and the play is listed
 * (and counted) once per remaining copy until the server's next watch-history
 * sync re-points them — a native full replace rewrites the rows (on
 * Jellyfin/Emby every history sync is one; a set-aside user's rows, which a
 * replace keeps as they are, wait until that user can be read again), and a
 * Tracearr import repairs them before it walks (`repairLibraryCopyRows`).
 * Rare (three libraries over one folder) and self-healing, so it is
 * documented rather than designed around.
 */
const PRIMARY_PLAY = `wh."fanOutOfItemId" IS NULL`;

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
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
    // A label matches every file the page SHOWS under that label: the same
    // `resolutionLabelSql` the Resolution sort ranks by, the SQL twin of the
    // page's `normalizeResolutionLabel`. A hand-kept list of raw values used
    // to stand in for it and missed every non-standard height — `1024p`,
    // `576`, `240` display and sort as 1080P / 480P / SD but matched none of
    // those filters — and could not express `Other` at all. Any other value
    // is a stored resolution, matched as written, ignoring case.
    const labels = new Set<string>();
    const stored: string[] = [];
    for (const value of resolution.split("|").filter(Boolean)) {
      const label = QUALITY_ORDER.find((l) => l.toLowerCase() === value.toLowerCase());
      if (label) labels.add(label);
      else stored.push(value);
    }
    const matches: string[] = [];
    if (labels.size > 0) {
      const placeholders = [...labels].map(() => `$${paramIdx++}`).join(",");
      // A label depends on the stored value alone, so it is computed once per
      // DISTINCT stored resolution — a few dozen — not once per item: per item
      // the regex CASE cost ~120 ms at 48k items, more than the whole query
      // before it. `OFFSET 0` stops the planner pushing the CASE back below the
      // DISTINCT (as it does unfenced). `COALESCE` on both sides lets a NULL
      // resolution — labelled `Other`, like an empty one — match, which `IN`
      // never does on its own.
      matches.push(
        `COALESCE(mi."resolution", '') IN (
          SELECT COALESCE(d."resolution", '') FROM (SELECT DISTINCT "resolution" FROM "MediaItem" OFFSET 0) d
          WHERE (${resolutionLabelSql('d."resolution"')}) IN (${placeholders}))`,
      );
      params.push(...labels);
    }
    if (stored.length > 0) {
      const placeholders = stored.map(() => `LOWER($${paramIdx++})`).join(",");
      matches.push(`LOWER(mi."resolution") IN (${placeholders})`);
      params.push(...stored);
    }
    if (matches.length > 0) itemConditions.push(`(${matches.join(" OR ")})`);
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

  const whereClause = [...conditions, PRIMARY_PLAY, ...itemConditions].join(" AND ");

  // Build ORDER BY — always sort server-side for paginated results. The
  // key → SQL map is a strict whitelist shared with the page
  // (`src/lib/media/history-sort.ts`): `sortBy` is never interpolated itself,
  // and an unknown value falls back to Watched At.
  const orderExprs = historySortSql(sortBy);
  const orderDir = sortOrder === "asc" ? "ASC" : "DESC";
  // The ORDER BY below appends wh."id" as a unique tiebreaker so the sort is a
  // total order. Without one Postgres may return tied rows in any order, and a
  // bounded page (top-N heapsort) is planned differently from its neighbour, so
  // the tie block straddling the page boundary permutes between requests — a
  // paged-through list then shows some plays twice and silently drops others.
  // The Tracearr sorts above make that near-certain rather than unlikely:
  // `isTranscode` has two distinct values and `percentComplete`/`player`/
  // `resolution` are NULL on every NATIVE row, so one tie block can cover the
  // whole table.

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

  // The count only needs the MediaItem join when a condition reads `mi.`;
  // the join is one index probe per play, and without it the count is an
  // index-only scan. Measured at 141k plays: 65 ms → 9 ms for the unfiltered
  // page every History visit starts on.
  //
  // Without that join the fan-out copies are SUBTRACTED rather than filtered
  // out (`PRIMARY_PLAY`): `fanOutOfItemId` is in no index that scan can use,
  // so testing it on every play turned the index-only scan into a read of the
  // whole heap. At 150k plays carrying Tracearr detail, with parallel query
  // off: 41 ms before, 85 ms with the predicate, 43 ms as a subtraction — and
  // a cold cache would read the ~160 MB heap instead of an index. The copies
  // are found through the `fanOutOfItemId` index, so subtracting them costs
  // about a millisecond per few thousand. With the join the heap is read
  // anyway, and there the plain predicate is the cheaper form.
  const needsItemJoin = itemConditions.length > 0;
  const playsFrom = `FROM "WatchHistory" wh
    JOIN "MediaServer" ms ON ms."id" = wh."mediaServerId"
    WHERE ${conditions.join(" AND ")}`;
  const countP = prisma.$queryRawUnsafe<[{ count: bigint }]>(
    needsItemJoin
      ? `SELECT COUNT(*) AS "count" ${fromClause}`
      : `SELECT (SELECT COUNT(*) ${playsFrom})
          - (SELECT COUNT(*) ${playsFrom} AND wh."fanOutOfItemId" IS NOT NULL) AS "count"`,
    ...params,
  );

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
    `SELECT
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
      ms."id" AS "ms_id", ms."name" AS "ms_name", ms."type" AS "ms_type"
    ${fromClause}
    ORDER BY ${orderExprs.map((expr) => `${expr} ${orderDir} NULLS LAST`).join(", ")}, wh."id" ASC
    LIMIT ${limit + 1} OFFSET ${clampSkip((page - 1) * limit)}`,
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
