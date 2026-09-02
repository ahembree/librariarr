import { withApiKey, parseV1Pagination, v1List } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { resolveServerFilter } from "@/lib/dedup/server-filter";

/**
 * One row per series.
 *
 * Episodes are stored as individual `MediaItem` rows (`type: SERIES`,
 * `parentTitle` = the show), so a series only exists as an aggregate. The
 * grouping is done by the database — grouping on `[parentTitle, seasonNumber]`
 * yields per-season counts and sizes in a single query, and folding those
 * season rows into shows in memory gives `seasonCount` (a COUNT DISTINCT that
 * `groupBy` can't express) without ever loading an episode row.
 *
 * Like the other grouped views in the app, the whole aggregate is built before
 * slicing: there is no page-shaped subset of it to fetch.
 */
export const GET = withApiKey(async (request, { userId }) => {
  const { searchParams } = new URL(request.url);
  const pagination = parseV1Pagination(searchParams);
  const search = searchParams.get("search");
  const serverId = searchParams.get("serverId");

  const sf = await resolveServerFilter(userId, serverId, "SERIES");
  if (!sf || sf.serverIds.length === 0) {
    return v1List([], pagination, false);
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "SERIES",
    parentTitle: { not: null },
  };

  if (search) {
    where.parentTitle = { contains: search, mode: "insensitive", not: null };
  }

  if (!sf.isSingleServer) where.dedupCanonical = true;

  const groups = await prisma.mediaItem.groupBy({
    by: ["parentTitle", "seasonNumber"],
    where,
    _count: { _all: true },
    _sum: { fileSize: true },
    _min: { year: true },
  });

  interface SeriesAccumulator {
    /** The normalized fold key. Unique per show, so it breaks collation ties. */
    key: string;
    title: string;
    episodeCount: number;
    seasons: Set<number>;
    totalSize: bigint;
    year: number | null;
  }

  // Keyed on the lower-cased title so two servers spelling a show differently
  // still collapse into one row, matching the grouped library views.
  const byTitle = new Map<string, SeriesAccumulator>();

  for (const group of groups) {
    const title = group.parentTitle;
    if (!title) continue;

    const key = title.toLowerCase().trim();
    let series = byTitle.get(key);
    if (!series) {
      series = { key, title, episodeCount: 0, seasons: new Set(), totalSize: BigInt(0), year: null };
      byTitle.set(key, series);
    }

    series.episodeCount += group._count._all;
    if (group.seasonNumber !== null) series.seasons.add(group.seasonNumber);
    if (group._sum.fileSize) series.totalSize += group._sum.fileSize;

    const year = group._min.year;
    if (year !== null && (series.year === null || year < series.year)) {
      series.year = year;
    }
  }

  const sorted = Array.from(byTitle.values())
    // `localeCompare` returns 0 for titles that are distinct rows but collate
    // equal (case, accents, punctuation), and Array.prototype.sort gives no
    // guarantee about how it breaks such ties between calls. Two requests for
    // adjacent pages could then order the tied block differently and the
    // stitched list would repeat one show while dropping another — the same
    // hazard the DB-backed routes avoid with an `id` tiebreaker. The fold key
    // is unique per show, so comparing it second makes the order total.
    .sort((a, b) => a.title.localeCompare(b.title) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(pagination.skip, pagination.skip + pagination.limit + 1);

  const hasMore = sorted.length > pagination.limit;
  if (hasMore) sorted.pop();

  const items = sorted.map((series) => ({
    title: series.title,
    episodeCount: series.episodeCount,
    seasonCount: series.seasons.size,
    totalSize: series.totalSize.toString(),
    year: series.year,
  }));

  return v1List(items, pagination, hasMore);
});
