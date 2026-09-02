import { withApiKey, parseV1Pagination, v1List } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { resolveServerFilter } from "@/lib/dedup/server-filter";

const TRACK_SELECT = {
  id: true,
  title: true,
  year: true,
  type: true,
  parentTitle: true,
  albumTitle: true,
  // The sync stores a track's index in `episodeNumber` (the column is shared
  // across library types); it is surfaced as `trackNumber` here.
  episodeNumber: true,
  audioCodec: true,
  audioChannels: true,
  audioProfile: true,
  container: true,
  fileSize: true,
  duration: true,
  genres: true,
  studio: true,
  rating: true,
  addedAt: true,
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

/** Flat track list. `parentTitle` is the artist, `albumTitle` the album. */
export const GET = withApiKey(async (request, { userId }) => {
  const { searchParams } = new URL(request.url);
  const pagination = parseV1Pagination(searchParams);
  const search = searchParams.get("search");
  const serverId = searchParams.get("serverId");
  const artist = searchParams.get("artist");
  const album = searchParams.get("album");

  const sf = await resolveServerFilter(userId, serverId, "MUSIC");
  if (!sf || sf.serverIds.length === 0) {
    return v1List([], pagination, false);
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "MUSIC",
  };

  if (artist) where.parentTitle = artist;
  if (album) where.albumTitle = album;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { parentTitle: { contains: search, mode: "insensitive" } },
      { albumTitle: { contains: search, mode: "insensitive" } },
    ];
  }

  if (!sf.isSingleServer) where.dedupCanonical = true;

  const rows = await prisma.mediaItem.findMany({
    where,
    skip: pagination.skip,
    take: pagination.limit + 1,
    // Artist → album → track order, closed into a total order by `id`.
    orderBy: [
      { parentTitle: "asc" },
      { albumTitle: "asc" },
      { episodeNumber: "asc" },
      { id: "asc" },
    ],
    select: TRACK_SELECT,
  });

  const hasMore = rows.length > pagination.limit;
  if (hasMore) rows.pop();

  const items = rows.map(({ library, episodeNumber, ...item }) => ({
    ...item,
    trackNumber: episodeNumber,
    fileSize: item.fileSize?.toString() ?? null,
    library: { id: library.id, title: library.title },
    server: library.mediaServer,
  }));

  return v1List(items, pagination, hasMore);
});
