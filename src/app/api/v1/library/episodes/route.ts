import { withApiKey, v1Error, parseV1Pagination, v1List } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { resolveServerFilter } from "@/lib/dedup/server-filter";

const EPISODE_SELECT = {
  id: true,
  title: true,
  year: true,
  type: true,
  parentTitle: true,
  seasonNumber: true,
  episodeNumber: true,
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

/** Flat episode list — every episode row, optionally narrowed to one show/season. */
export const GET = withApiKey(async (request, { userId }) => {
  const { searchParams } = new URL(request.url);
  const pagination = parseV1Pagination(searchParams);
  const search = searchParams.get("search");
  const serverId = searchParams.get("serverId");
  const series = searchParams.get("series");
  const rawSeason = searchParams.get("season");

  let season: number | undefined;
  if (rawSeason !== null && rawSeason !== "") {
    const parsed = parseInt(rawSeason, 10);
    // A malformed season silently matching everything would be worse than an
    // error: the caller would page through the whole library thinking it is
    // reading one season.
    if (Number.isNaN(parsed)) return v1Error("season must be an integer", 400);
    season = parsed;
  }

  const sf = await resolveServerFilter(userId, serverId, "SERIES");
  if (!sf || sf.serverIds.length === 0) {
    return v1List([], pagination, false);
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "SERIES",
  };

  if (series) {
    // `/library/series` folds shows on a normalized (lower-cased, trimmed)
    // title, so the `title` it returns is whichever raw spelling was seen first
    // among rows that may spell the name differently across servers. Matching
    // that string exactly here would return only the subset sharing its
    // casing — precisely the rows the fold exists to merge — so feeding a
    // series title from that endpoint straight back into this one would
    // silently under-report, and its `episodeCount` would not match the number
    // of episodes returned. Resolve the requested name back to every stored
    // spelling in the same equivalence class instead.
    const key = series.toLowerCase().trim();
    const storedTitles = await prisma.mediaItem.findMany({
      where: {
        library: { mediaServerId: { in: sf.serverIds } },
        type: "SERIES",
        parentTitle: { not: null },
      },
      select: { parentTitle: true },
      distinct: ["parentTitle"],
    });
    // An empty list yields `{ in: [] }`, which matches nothing — the right
    // answer for an unknown show, and never an accidentally unfiltered list.
    where.parentTitle = {
      in: storedTitles
        .map((row) => row.parentTitle)
        .filter((title): title is string => title !== null && title.toLowerCase().trim() === key),
    };
  }
  if (season !== undefined) where.seasonNumber = season;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { parentTitle: { contains: search, mode: "insensitive" } },
    ];
  }

  if (!sf.isSingleServer) where.dedupCanonical = true;

  const rows = await prisma.mediaItem.findMany({
    where,
    skip: pagination.skip,
    take: pagination.limit + 1,
    // Show → season → episode is the only ordering that reads sensibly here;
    // `id` closes it into a total order so pages can't overlap.
    orderBy: [
      { parentTitle: "asc" },
      { seasonNumber: "asc" },
      { episodeNumber: "asc" },
      { id: "asc" },
    ],
    select: EPISODE_SELECT,
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
