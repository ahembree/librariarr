import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { getServerPresenceByGroup } from "@/lib/dedup/server-presence";

type GroupType = "SERIES" | "MUSIC";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const typeParam = request.nextUrl.searchParams.get("type");
  if (typeParam !== "SERIES" && typeParam !== "MUSIC") {
    return NextResponse.json(
      { error: "type must be SERIES or MUSIC" },
      { status: 400 },
    );
  }
  const type: GroupType = typeParam;

  // Ownership check + resolve grouping key
  const repItem = await prisma.mediaItem.findFirst({
    where: {
      id,
      type,
      library: { mediaServer: { userId: session.userId } },
    },
    select: {
      parentTitle: true,
      grandparentRatingKey: true,
    },
  });

  if (!repItem || !repItem.parentTitle) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sf = await resolveServerFilter(session.userId!, null, type);
  if (!sf) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const cacheKey = `group-summary:${session.userId}:${type}:${repItem.parentTitle.toLowerCase().trim()}`;
  const result = await appCache.getOrSet(
    cacheKey,
    () =>
      computeGroupSummary(
        type,
        repItem.parentTitle!,
        sf.serverIds,
        sf.isSingleServer,
      ),
    60_000,
  );

  return NextResponse.json(result);
}

async function computeGroupSummary(
  type: GroupType,
  parentTitle: string,
  serverIds: string[],
  isSingleServer: boolean,
) {
  // Fetch all sibling items in this group across the user's servers.
  // For multi-server, restrict to canonical copies to avoid double-counting
  // episodes/size/playCount across duplicate items.
  const items = await prisma.mediaItem.findMany({
    where: {
      type,
      parentTitle,
      library: { mediaServerId: { in: serverIds } },
      ...(isSingleServer ? {} : { dedupCanonical: true }),
    },
    select: {
      id: true,
      title: true,
      year: true,
      summary: true,
      parentSummary: true,
      contentRating: true,
      rating: true,
      ratingImage: true,
      audienceRating: true,
      audienceRatingImage: true,
      genres: true,
      studio: true,
      addedAt: true,
      lastPlayedAt: true,
      playCount: true,
      fileSize: true,
      resolution: true,
      audioCodec: true,
      seasonNumber: true,
      albumTitle: true,
      library: {
        select: {
          mediaServerId: true,
        },
      },
    },
  });

  // Server presence — uses normalized parentTitle keying like other grouped routes
  const presenceMap = await getServerPresenceByGroup(type, serverIds);
  const servers =
    presenceMap.get(parentTitle.toLowerCase().trim()) ?? [];

  // Pick first non-null descriptive metadata (parent-level fields tend to repeat across siblings)
  let summary: string | null = null;
  let contentRating: string | null = null;
  let rating: number | null = null;
  let ratingImage: string | null = null;
  let audienceRating: number | null = null;
  let audienceRatingImage: string | null = null;
  let year: number | null = null;
  let studio: string | null = null;
  let genres: string[] | null = null;

  // Aggregates
  let totalSize = BigInt(0);
  let totalPlayCount = 0;
  let lastPlayedAt: Date | null = null;
  let addedAt: Date | null = null;
  const qualityCounts: Record<string, number> = {};
  const audioCodecCounts: Record<string, number> = {};
  const seasonSet = new Set<number>();
  const albumSet = new Set<string>();
  let trackOrEpisodeCount = 0;

  for (const item of items) {
    if (!summary) summary = item.parentSummary ?? item.summary;
    if (!contentRating && item.contentRating) contentRating = item.contentRating;
    if (rating == null && item.rating != null) rating = item.rating;
    if (!ratingImage && item.ratingImage) ratingImage = item.ratingImage;
    if (audienceRating == null && item.audienceRating != null) audienceRating = item.audienceRating;
    if (!audienceRatingImage && item.audienceRatingImage) audienceRatingImage = item.audienceRatingImage;
    if (year == null && item.year != null) year = item.year;
    if (!studio && item.studio) studio = item.studio;
    if (!genres && item.genres) genres = item.genres as string[];

    if (item.fileSize) totalSize += item.fileSize;
    totalPlayCount += item.playCount ?? 0;

    if (item.lastPlayedAt && (!lastPlayedAt || item.lastPlayedAt > lastPlayedAt)) {
      lastPlayedAt = item.lastPlayedAt;
    }
    if (item.addedAt && (!addedAt || item.addedAt > addedAt)) {
      addedAt = item.addedAt;
    }

    trackOrEpisodeCount++;

    if (type === "SERIES") {
      if (item.seasonNumber != null) seasonSet.add(item.seasonNumber);
      const resLabel = normalizeResolutionLabel(item.resolution);
      qualityCounts[resLabel] = (qualityCounts[resLabel] ?? 0) + 1;
    } else {
      if (item.albumTitle) albumSet.add(item.albumTitle);
      const codec = item.audioCodec ? item.audioCodec.toUpperCase() : "Unknown";
      audioCodecCounts[codec] = (audioCodecCounts[codec] ?? 0) + 1;
    }
  }

  const base = {
    title: parentTitle,
    year,
    summary,
    contentRating,
    rating,
    ratingImage,
    audienceRating,
    audienceRatingImage,
    genres,
    studio,
    addedAt: addedAt?.toISOString() ?? null,
    lastPlayedAt: lastPlayedAt?.toISOString() ?? null,
    playCount: totalPlayCount,
    fileSize: totalSize.toString(),
    servers,
  };

  if (type === "SERIES") {
    return {
      ...base,
      seasonCount: seasonSet.size,
      episodeCount: trackOrEpisodeCount,
      qualityCounts,
    };
  }

  return {
    ...base,
    albumCount: albumSet.size,
    trackCount: trackOrEpisodeCount,
    audioCodecCounts,
  };
}
