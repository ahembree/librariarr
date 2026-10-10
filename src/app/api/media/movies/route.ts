import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/api/json-response";
import { prisma } from "@/lib/db";
import { escapeLike } from "@/lib/filters/escape-like";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters, applyStartsWithFilter } from "@/lib/filters/build-where";
import { filterIdsByStreamCounts, parseStreamCountFilters } from "@/lib/filters/stream-count";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { parseListPagination } from "@/lib/api/pagination";
import { getServerPresenceByDedupKey } from "@/lib/dedup/server-presence";

// Valid MediaItem scalar sort columns; anything else falls back to title.
const SORT_COLUMNS = new Set([
  "title",
  "year",
  "resolution",
  "videoCodec",
  "audioCodec",
  "fileSize",
  "duration",
  "playCount",
  "lastPlayedAt",
  "addedAt",
  "rating",
  "audienceRating",
  "contentRating",
]);

/** How many ids one `findInOrder` query names, well under the bind-parameter limit. */
const ID_CHUNK = 5000;

/** The rows for `ids`, in the order given, a chunk of ids per query. */
async function findInOrder<T extends { id: string }>(
  ids: string[],
  fetchChunk: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const byId = new Map<string, T>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    for (const row of await fetchChunk(ids.slice(i, i + ID_CHUNK))) byId.set(row.id, row);
  }
  return ids.map((id) => byId.get(id)).filter((row): row is T => row !== undefined);
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const { page, limit, skip } = parseListPagination(searchParams);
  const search = searchParams.get("search");
  const rawSortBy = searchParams.get("sortBy") ?? "title";
  const sortBy = SORT_COLUMNS.has(rawSortBy) ? rawSortBy : "title";
  const sortOrder = searchParams.get("sortOrder") === "desc" ? "desc" : "asc";
  const serverId = searchParams.get("serverId");
  const startsWith = searchParams.get("startsWith");

  const sf = await resolveServerFilter(session.userId!, serverId, "MOVIE");
  if (!sf) {
    return NextResponse.json({ items: [], pagination: { page, limit, hasMore: false } });
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "MOVIE",
  };

  // `escapeLike`: `search` becomes a LIKE pattern, and nothing else escapes
  // `%` / `_` / `\` — live, `?search=1_ Things` matched "10 Things I Hate
  // About You" and `?search=%` matched everything (see escape-like.ts).
  if (search) where.title = { contains: escapeLike(search), mode: "insensitive" };
  if (startsWith) applyStartsWithFilter(where, "title", startsWith);
  applyCommonFilters(where, searchParams);

  // Stream count filters (audio track count, subtitle count), applied below.
  const streamCounts = parseStreamCountFilters(searchParams);

  // Select only fields needed for card/table rendering.
  // Full item data is fetched on demand by the detail panel via /api/media/{id}.
  const selectBase = {
    id: true,
    title: true,
    titleSort: true,
    year: true,
    type: true,
    parentTitle: true,
    seasonNumber: true,
    episodeNumber: true,
    resolution: true,
    dynamicRange: true,
    videoCodec: true,
    videoBitDepth: true,
    videoFrameRate: true,
    videoBitrate: true,
    aspectRatio: true,
    audioCodec: true,
    audioChannels: true,
    audioProfile: true,
    container: true,
    fileSize: true,
    duration: true,
    playCount: true,
    lastPlayedAt: true,
    addedAt: true,
    originallyAvailableAt: true,
    contentRating: true,
    rating: true,
    ratingImage: true,
    audienceRating: true,
    audienceRatingImage: true,
    genres: true,
    studio: true,
    dedupKey: true,
    dedupCanonical: true,
    library: {
      select: {
        title: true,
        mediaServer: { select: { id: true, name: true, type: true } },
      },
    },
  };

  // For multi-server, filter to canonical items only (pre-computed dedup)
  if (!sf.isSingleServer) {
    where.dedupCanonical = true;
  }

  // `id` is the tiebreaker, not decoration: without a total order Postgres is
  // free to return tied rows in any order, and the two passes of a progressive
  // load are planned differently (bounded top-N heapsort vs full quicksort or
  // external merge). The tie block straddling the page boundary then permutes
  // between the passes, so the stitched list shows some rows twice and drops
  // others entirely. Reproduced at 80 duplicated / 80 missing out of 20k rows.
  const orderBy: Prisma.MediaItemOrderByWithRelationInput[] =
    sortBy === "title"
      ? [{ titleSort: { sort: sortOrder, nulls: "last" } }, { title: sortOrder }, { id: "asc" }]
      : [{ [sortBy]: sortOrder }, { id: "asc" }];

  let items;
  if (streamCounts) {
    // A track count is not something a Prisma filter can express, so the
    // candidates are listed in order, the counts checked in one SQL statement
    // over them, and the page cut from what is left — never as an `id IN (…)`
    // over every match, which runs out of bind parameters on a large library.
    const candidates = await prisma.mediaItem.findMany({ where, orderBy, select: { id: true } });
    const matching = await filterIdsByStreamCounts(
      prisma,
      candidates.map((c) => c.id),
      streamCounts,
    );
    const ordered = candidates.map((c) => c.id).filter((id) => matching.has(id));
    const pageIds = limit > 0 ? ordered.slice(skip, skip + limit + 1) : ordered.slice(skip);
    items = await findInOrder(pageIds, (chunk) =>
      prisma.mediaItem.findMany({ where: { id: { in: chunk } }, select: selectBase }),
    );
  } else {
    items = await prisma.mediaItem.findMany({
      where,
      ...(limit > 0 ? { skip, take: limit + 1 } : { skip }),
      orderBy,
      select: selectBase,
    });
  }

  const hasMore = limit > 0 && items.length > limit;
  if (hasMore) items.pop();

  // For multi-server, attach server presence from all servers sharing dedupKey
  let serversByKey: Map<string, { serverId: string; serverName: string; serverType: string; mediaItemId: string }[]> | null = null;
  if (!sf.isSingleServer) {
    const dedupKeys = items.map((i) => i.dedupKey).filter((k): k is string => k != null);
    serversByKey = await getServerPresenceByDedupKey(dedupKeys, sf.serverIds);
  }

  const serializedItems = items.map((item) => ({
    ...item,
    fileSize: item.fileSize?.toString() ?? null,
    servers: serversByKey?.get(item.dedupKey!) ?? [
      {
        serverId: item.library.mediaServer!.id,
        serverName: item.library.mediaServer!.name,
        serverType: item.library.mediaServer!.type,
      },
    ],
  }));

  return jsonResponse(request, {
    items: serializedItems,
    pagination: { page, limit, hasMore },
  });
}
