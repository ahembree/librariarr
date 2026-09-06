import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/api/json-response";
import { prisma } from "@/lib/db";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { getServerPresenceByGroup } from "@/lib/dedup/server-presence";
import { escapeLike } from "@/lib/conditions/where-builder";
import { firstNonNullSql, qualityCountsSql, resolutionLabelSql } from "@/lib/media/series-sql";
import { loadMissingSummaries } from "@/lib/media/group-summaries";

interface SeriesGroupRow {
  group_key: string;
  parentTitle: string;
  episodeCount: number;
  seasonCount: number;
  totalSize: string;
  lastPlayed: Date | null;
  addedAt: Date | null;
  qualityCounts: Record<string, number> | null;
  watchedEpisodeCount: number;
  lastEpisodeAiredAt: Date | null;
  isWatchlisted: boolean;
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

interface SeriesRepresentativeRow {
  group_key: string;
  mediaItemId: string;
  thumbUrl: string | null;
  summary: string | null;
}

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
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
  const rawLimit = parseInt(searchParams.get("limit") ?? "50");
  const limit = rawLimit === 0 ? 0 : Math.min(Number.isNaN(rawLimit) ? 50 : rawLimit, 200);
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "parentTitle";
  const sortOrder = searchParams.get("sortOrder") || "asc";
  const serverId = searchParams.get("serverId");
  const startsWith = searchParams.get("startsWith");

  const sf = await resolveServerFilter(session.userId!, serverId, "SERIES");
  if (!sf) {
    return NextResponse.json({ series: [], pagination: { page, limit, hasMore: false } });
  }

  // One SQL GROUP BY for every server count. This was the multi-server path
  // only; a single-server install loaded every episode row into Node — with
  // its `summary` and `parentSummary` prose — and aggregated in JS, then kept
  // one non-null value per show out of hundreds it had transferred. Measured on
  // a 28k-episode library: ~320 ms per request versus ~40 ms for the aggregate
  // below, on the page every series view opens with. The only thing the two
  // server counts differ on is the `dedupCanonical` conjunct.
  const artworkServerId =
    sf.preferredArtworkServerId ?? sf.preferredTitleServerId ?? "";

  const filters: string[] = [];
  // Canonical selection only means something across servers; a single server
  // holds one copy of everything, and its rows may predate `dedupCanonical`.
  if (!sf.isSingleServer) filters.push(`AND mi."dedupCanonical" = true`);
  const params: unknown[] = [sf.serverIds];
  // `escapeLike`: these are LIKE patterns, so a literal `%`, `_` or `\` in
  // the search must not act as a wildcard (Prisma's `contains` escaped them).
  if (search) {
    params.push(escapeLike(search));
    filters.push(`AND mi."parentTitle" ILIKE '%' || $${params.length} || '%'`);
  }
  if (startsWith) {
    if (startsWith === "#") {
      filters.push(`AND mi."parentTitle" !~* '^[A-Za-z]'`);
    } else {
      params.push(escapeLike(startsWith));
      filters.push(`AND mi."parentTitle" ILIKE $${params.length} || '%'`);
    }
  }
  // `parentTitle IS NOT NULL`: a row can carry a TVDB-derived seriesKey with no
  // show title, and MIN("parentTitle") over such a group is NULL, which the
  // title sort below cannot compare.
  const scope = `
      FROM "MediaItem" mi
      JOIN "Library" l ON mi."libraryId" = l.id
      WHERE mi.type = 'SERIES'::"LibraryType"
        AND mi."seriesKey" IS NOT NULL
        AND mi."parentTitle" IS NOT NULL
        AND l."mediaServerId" = ANY($1::text[])
        ${filters.join("\n        ")}`;

  const first = (col: string) => firstNonNullSql(col, `"seasonNumber", "episodeNumber"`);

  // Two queries in parallel rather than one, on purpose. The aggregate below
  // is NARROW — counts, sums, maxes and a handful of scalar firsts — and the
  // representative row (artwork, summary, genres) is picked by a separate
  // DISTINCT ON. Folding the wide text columns into the aggregate as ordered
  // `array_agg`s made the GroupAggregate carry 800-byte rows through a dozen
  // per-group sorts: measured on 28k episodes, 150 ms for the single statement
  // versus ~70 ms wall for the pair. The resolution label is computed once per
  // row in a subquery pinned with `OFFSET 0`; inlined, the planner substitutes
  // the regex CASE into each of the six FILTER clauses and evaluates it six
  // times per row.
  const [groups, representatives, groupServerPresence] = await Promise.all([
    prisma.$queryRawUnsafe<SeriesGroupRow[]>(
      `SELECT
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
        ${qualityCountsSql("resolution_label")} as "qualityCounts",
        ${first(`"genres"`)} as "genres",
        ${first(`"studio"`)} as "studio",
        ${first(`"contentRating"`)} as "contentRating",
        ${first(`"rating"`)} as "rating",
        ${first(`"ratingImage"`)} as "ratingImage",
        ${first(`"audienceRating"`)} as "audienceRating",
        ${first(`"audienceRatingImage"`)} as "audienceRatingImage",
        ${first(`"year"`)} as "year",
        (array_agg(id ORDER BY "seasonNumber", "episodeNumber", id) FILTER (WHERE has_summary))[1] as "summaryItemId"
      FROM (
        SELECT
          mi."seriesKey" as group_key,
          mi.id,
          (COALESCE(NULLIF(mi."parentSummary", ''), NULLIF(mi."summary", '')) IS NOT NULL) as has_summary,
          mi."parentTitle",
          mi."seasonNumber",
          mi."episodeNumber",
          mi."fileSize",
          mi."lastPlayedAt",
          mi."addedAt",
          mi."playCount",
          mi."originallyAvailableAt",
          mi."isWatchlisted",
          mi."genres",
          mi."studio",
          mi."contentRating",
          mi."rating",
          mi."ratingImage",
          mi."audienceRating",
          mi."audienceRatingImage",
          mi."year",
          ${resolutionLabelSql("mi.resolution")} as resolution_label
        ${scope}
        OFFSET 0
      ) items
      GROUP BY group_key`,
      ...params,
    ),
    // One row per show: show art wins over any server preference (a poster on
    // a non-preferred server beats an episode still on the preferred one —
    // the order the multi-server aggregate always used), the artwork-preferred
    // server breaks ties, then a row with a summary, then the first episode.
    prisma.$queryRawUnsafe<SeriesRepresentativeRow[]>(
      `SELECT DISTINCT ON (mi."seriesKey")
        mi."seriesKey" as group_key,
        mi.id as "mediaItemId",
        COALESCE(mi."parentThumbUrl", mi."thumbUrl") as "thumbUrl",
        COALESCE(NULLIF(mi."parentSummary", ''), NULLIF(mi."summary", '')) as "summary"
      ${scope}
      ORDER BY mi."seriesKey",
        (mi."parentThumbUrl" IS NOT NULL) DESC,
        (mi."thumbUrl" IS NOT NULL) DESC,
        (l."mediaServerId" = $${params.length + 1}) DESC,
        (COALESCE(NULLIF(mi."parentSummary", ''), NULLIF(mi."summary", '')) IS NOT NULL) DESC,
        mi."seasonNumber", mi."episodeNumber", mi.id`,
      ...params,
      artworkServerId,
    ),
    // On one server every show is on that server: the presence scan (a
    // DISTINCT ON over every episode) would only ever say so.
    sf.isSingleServer ? null : getServerPresenceByGroup("SERIES", sf.serverIds),
  ]);

  const repByKey = new Map(representatives.map((r) => [r.group_key, r]));
  const singleServer = sf.isSingleServer
    ? { serverId: sf.serverIds[0], ...sf.serverMap.get(sf.serverIds[0])! }
    : null;
  // The representative is chosen for artwork first, so a show whose art row
  // has no blurb but a sibling episode does would lose it; fetch those few
  // from the episode the aggregate flagged (a PK lookup, usually for none).
  const summaryByKey = await loadMissingSummaries(
    groups
      .filter((g) => !repByKey.get(g.group_key)?.summary && g.summaryItemId)
      .map((g) => [g.group_key, g.summaryItemId!] as const),
    "show",
  );

  let seriesList = groups.map((g) => {
    const rep = repByKey.get(g.group_key);
    return {
      parentTitle: g.parentTitle,
      seriesKey: g.group_key,
      mediaItemId: rep?.mediaItemId ?? "",
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
      thumbUrl: rep?.thumbUrl ?? null,
      servers: singleServer
        ? [{ serverId: singleServer.serverId, serverName: singleServer.name, serverType: singleServer.type, mediaItemId: rep?.mediaItemId ?? "" }]
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
  });

  // Post-aggregation filters on series-level computed fields
  seriesList = applySeriesFilters(seriesList, searchParams);

  const sorted = sortSeriesList(seriesList, sortBy, sortOrder);
  if (limit > 0) {
    const offset = (page - 1) * limit;
    const paged = sorted.slice(offset, offset + limit + 1);
    const hasMore = paged.length > limit;
    if (hasMore) paged.pop();
    return jsonResponse(request, { series: paged, pagination: { page, limit, hasMore } });
  }
  return jsonResponse(request, { series: sorted, pagination: { page, limit, hasMore: false } });
}
