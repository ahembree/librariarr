import { withApiKey, v1Error, parseV1Pagination, v1List } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import type { LibraryType, Prisma } from "@/generated/prisma/client";
import { resolveServerFilter } from "@/lib/dedup/server-filter";

/**
 * Accepted `type` values → the stored `LibraryType`.
 *
 * `EPISODE` and `TRACK` are aliases: an episode is a `SERIES` row and a track a
 * `MUSIC` row, but a caller reading the returned items reasonably reaches for
 * the noun rather than the library's type, so both spellings resolve.
 */
const TYPE_ALIASES: Record<string, LibraryType> = {
  MOVIE: "MOVIE",
  SERIES: "SERIES",
  MUSIC: "MUSIC",
  EPISODE: "SERIES",
  TRACK: "MUSIC",
};

/** Shortest query worth running — one character matches most of a library. */
const MIN_QUERY_LENGTH = 2;

export const GET = withApiKey(async (request, { userId }) => {
  const { searchParams } = new URL(request.url);
  const pagination = parseV1Pagination(searchParams);
  const q = searchParams.get("q")?.trim() ?? "";
  const rawType = searchParams.get("type");
  const serverId = searchParams.get("serverId");

  if (q.length < MIN_QUERY_LENGTH) {
    return v1Error(`q is required and must be at least ${MIN_QUERY_LENGTH} characters`, 400);
  }

  const type = rawType ? TYPE_ALIASES[rawType.toUpperCase()] : undefined;
  if (rawType && !type) {
    return v1Error("type must be one of MOVIE, SERIES, MUSIC, EPISODE, TRACK", 400);
  }

  const sf = await resolveServerFilter(userId, serverId, type);
  if (!sf || sf.serverIds.length === 0) {
    return v1List([], pagination, false);
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    OR: [
      { title: { contains: q, mode: "insensitive" } },
      { parentTitle: { contains: q, mode: "insensitive" } },
      { albumTitle: { contains: q, mode: "insensitive" } },
    ],
  };

  if (type) where.type = type;
  if (!sf.isSingleServer) where.dedupCanonical = true;

  const rows = await prisma.mediaItem.findMany({
    where,
    skip: pagination.skip,
    take: pagination.limit + 1,
    orderBy: [{ title: "asc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      type: true,
      year: true,
      parentTitle: true,
      albumTitle: true,
      seasonNumber: true,
      episodeNumber: true,
      addedAt: true,
      library: {
        select: {
          id: true,
          title: true,
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  const hasMore = rows.length > pagination.limit;
  if (hasMore) rows.pop();

  const items = rows.map(({ library, ...item }) => ({
    ...item,
    library: { id: library.id, title: library.title },
    server: library.mediaServer,
  }));

  return v1List(items, pagination, hasMore);
});
