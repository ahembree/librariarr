import { withApiKey, parseV1Pagination, v1List } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters } from "@/lib/filters/build-where";
import { resolveServerFilter } from "@/lib/dedup/server-filter";

// Sortable columns an external caller may name. Anything else falls back to
// title rather than 400ing, so a typo degrades instead of breaking a script.
const SORT_COLUMNS = new Set([
  "title",
  "year",
  "addedAt",
  "fileSize",
  "duration",
  "rating",
  "playCount",
  "lastPlayedAt",
]);

const MOVIE_SELECT = {
  id: true,
  title: true,
  year: true,
  type: true,
  resolution: true,
  dynamicRange: true,
  videoCodec: true,
  videoBitDepth: true,
  audioCodec: true,
  audioChannels: true,
  audioProfile: true,
  container: true,
  fileSize: true,
  duration: true,
  contentRating: true,
  rating: true,
  audienceRating: true,
  genres: true,
  studio: true,
  addedAt: true,
  originallyAvailableAt: true,
  playCount: true,
  lastPlayedAt: true,
  library: {
    select: {
      id: true,
      title: true,
      mediaServer: { select: { id: true, name: true, type: true } },
    },
  },
} satisfies Prisma.MediaItemSelect;

export const GET = withApiKey(async (request, { userId }) => {
  const { searchParams } = new URL(request.url);
  const pagination = parseV1Pagination(searchParams);
  const search = searchParams.get("search");
  const serverId = searchParams.get("serverId");
  const rawSortBy = searchParams.get("sortBy") ?? "title";
  const sortBy = SORT_COLUMNS.has(rawSortBy) ? rawSortBy : "title";
  const sortOrder = searchParams.get("sortOrder") === "desc" ? "desc" : "asc";
  const year = parseInt(searchParams.get("year") ?? "", 10);

  const sf = await resolveServerFilter(userId, serverId, "MOVIE");
  if (!sf || sf.serverIds.length === 0) {
    return v1List([], pagination, false);
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "MOVIE",
  };

  if (search) where.title = { contains: search, mode: "insensitive" };
  if (!Number.isNaN(year)) where.year = year;
  // `resolution` goes through the shared parser so v1's accepted labels ("4K",
  // "1080P", …) can't drift from the ones the UI sends.
  applyCommonFilters(where, searchParams);

  // Multiple servers: only the canonical copy of a title is listed, so the same
  // movie present on two servers appears once.
  if (!sf.isSingleServer) where.dedupCanonical = true;

  const rows = await prisma.mediaItem.findMany({
    where,
    skip: pagination.skip,
    take: pagination.limit + 1,
    // `id` is the tiebreaker that makes the sort a total order — without it
    // Postgres may permute tied rows between pages, duplicating some and
    // dropping others from a stitched list.
    orderBy:
      sortBy === "title"
        ? [
            { titleSort: { sort: sortOrder, nulls: "last" } },
            { title: sortOrder },
            { id: "asc" as const },
          ]
        : [{ [sortBy]: sortOrder }, { id: "asc" as const }],
    select: MOVIE_SELECT,
  });

  const hasMore = rows.length > pagination.limit;
  if (hasMore) rows.pop();

  const items = rows.map(({ library, ...item }) => ({
    ...item,
    fileSize: item.fileSize?.toString() ?? null,
    library: { id: library.id, title: library.title },
    server: library.mediaServer,
  }));

  return v1List(items, pagination, hasMore);
});
