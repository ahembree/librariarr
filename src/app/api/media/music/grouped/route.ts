import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters, applyStartsWithFilter } from "@/lib/filters/build-where";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import type { ServerPresence } from "@/lib/dedup/deduplicate";
import { getServerPresenceByGroup } from "@/lib/dedup/server-presence";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") ?? "1");
  const rawLimit = parseInt(searchParams.get("limit") ?? "50");
  const limit = rawLimit === 0 ? 0 : Math.min(rawLimit, 200);
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "parentTitle";
  const sortOrder = searchParams.get("sortOrder") || "asc";
  const serverId = searchParams.get("serverId");
  const startsWith = searchParams.get("startsWith");

  const sf = await resolveServerFilter(session.userId!, serverId, "MUSIC");
  if (!sf) {
    return NextResponse.json({ artists: [], pagination: { page, limit, hasMore: false } });
  }

  const whereClause: Prisma.MediaItemWhereInput = {
    type: "MUSIC" as const,
    parentTitle: { not: null },
    library: { mediaServerId: { in: sf.serverIds } },
  };

  if (search) {
    whereClause.parentTitle = {
      contains: search,
      mode: "insensitive",
      not: null,
    };
  }

  if (startsWith) applyStartsWithFilter(whereClause, "parentTitle", startsWith);
  applyCommonFilters(whereClause, searchParams);

  // For multi-server, only fetch canonical items (pre-deduped)
  if (!sf.isSingleServer) {
    whereClause.dedupCanonical = true;
  }

  // Run main query and server presence in parallel
  const [items, groupServerPresence] = await Promise.all([
    prisma.mediaItem.findMany({
      where: whereClause,
      select: {
        id: true,
        title: true,
        parentTitle: true,
        albumTitle: true,
        thumbUrl: true,
        parentThumbUrl: true,
        audioCodec: true,
        fileSize: true,
        lastPlayedAt: true,
        addedAt: true,
        summary: true,
        genres: true,
        studio: true,
        contentRating: true,
        rating: true,
        ratingImage: true,
        audienceRating: true,
        audienceRatingImage: true,
        year: true,
        library: {
          select: {
            mediaServer: { select: { id: true, name: true, type: true } },
          },
        },
      },
    }),
    sf.isSingleServer
      ? Promise.resolve(null)
      : getServerPresenceByGroup("MUSIC", sf.serverIds),
  ] as const);

  // Aggregate by normalized parentTitle (artist name)
  const groupMap = new Map<
    string,
    {
      parentTitle: string;
      mediaItemId: string;
      thumbUrl: string | null;
      trackCount: number;
      albumTitles: Set<string>;
      totalSize: bigint;
      lastPlayed: Date | null;
      addedAt: Date | null;
      audioCodecCounts: Record<string, number>;
      servers: Map<string, ServerPresence>;
      summary: string | null;
      genres: string[] | null;
      studio: string | null;
      contentRating: string | null;
      rating: number | null;
      ratingImage: string | null;
      audienceRating: number | null;
      audienceRatingImage: string | null;
      year: number | null;
    }
  >();

  for (const item of items) {
    const title = item.parentTitle!;
    const normalizedKey = title.toLowerCase().trim();
    let group = groupMap.get(normalizedKey);
    if (!group) {
      group = {
        parentTitle: title,
        mediaItemId: item.id,
        thumbUrl: item.thumbUrl,
        trackCount: 0,
        albumTitles: new Set(),
        totalSize: BigInt(0),
        lastPlayed: null,
        addedAt: null,
        audioCodecCounts: {},
        servers: new Map(),
        summary: null,
        genres: null,
        studio: null,
        contentRating: null,
        rating: null,
        ratingImage: null,
        audienceRating: null,
        audienceRatingImage: null,
        year: null,
      };
      groupMap.set(normalizedKey, group);
    }

    // Track server (for single-server path)
    if (sf.isSingleServer) {
      const ms = item.library.mediaServer!;
      if (!group.servers.has(ms.id)) {
        group.servers.set(ms.id, {
          serverId: ms.id,
          serverName: ms.name,
          serverType: ms.type,
          mediaItemId: item.id,
        });
      }
    }

    // Use preferred server's artwork
    const artworkServerId = sf.preferredArtworkServerId ?? sf.preferredTitleServerId;
    if (artworkServerId && item.library.mediaServer!.id === artworkServerId) {
      const thumb = item.parentThumbUrl ?? item.thumbUrl;
      if (thumb) {
        group.thumbUrl = thumb;
        group.mediaItemId = item.id;
      }
    }

    group.trackCount++;
    if (item.albumTitle) {
      group.albumTitles.add(item.albumTitle);
    }

    if (item.fileSize) {
      group.totalSize += item.fileSize;
    }

    if (
      item.lastPlayedAt &&
      (!group.lastPlayed || item.lastPlayedAt > group.lastPlayed)
    ) {
      group.lastPlayed = item.lastPlayedAt;
    }

    if (item.addedAt && (!group.addedAt || item.addedAt > group.addedAt)) {
      group.addedAt = item.addedAt;
    }

    if (item.parentThumbUrl && !group.thumbUrl) {
      group.thumbUrl = item.parentThumbUrl;
      group.mediaItemId = item.id;
    } else if (!group.thumbUrl && item.thumbUrl) {
      group.thumbUrl = item.thumbUrl;
      group.mediaItemId = item.id;
    }

    // Pick first non-null metadata (artist-level fields are typically the same across tracks)
    if (!group.summary && item.summary) group.summary = item.summary;
    if (!group.genres && item.genres) group.genres = item.genres as string[];
    if (!group.studio && item.studio) group.studio = item.studio;
    if (!group.contentRating && item.contentRating) group.contentRating = item.contentRating;
    if (group.rating == null && item.rating != null) group.rating = item.rating;
    if (!group.ratingImage && item.ratingImage) group.ratingImage = item.ratingImage;
    if (group.audienceRating == null && item.audienceRating != null) group.audienceRating = item.audienceRating;
    if (!group.audienceRatingImage && item.audienceRatingImage) group.audienceRatingImage = item.audienceRatingImage;
    if (group.year == null && item.year != null) group.year = item.year;

    const codec = item.audioCodec ? item.audioCodec.toUpperCase() : "Unknown";
    group.audioCodecCounts[codec] = (group.audioCodecCounts[codec] || 0) + 1;
  }

  const artistList = Array.from(groupMap.values())
    .map((g) => {
      const normalizedKey = g.parentTitle.toLowerCase().trim();
      const servers = groupServerPresence
        ? groupServerPresence.get(normalizedKey) ?? []
        : Array.from(g.servers.values()).sort((a, b) => a.serverName.localeCompare(b.serverName));

      return {
        parentTitle: g.parentTitle,
        mediaItemId: g.mediaItemId,
        albumCount: g.albumTitles.size,
        trackCount: g.trackCount,
        totalSize: g.totalSize.toString(),
        lastPlayed: g.lastPlayed,
        addedAt: g.addedAt,
        audioCodecCounts: g.audioCodecCounts,
        thumbUrl: g.thumbUrl,
        servers,
        summary: g.summary,
        genres: g.genres,
        studio: g.studio,
        contentRating: g.contentRating,
        rating: g.rating,
        ratingImage: g.ratingImage,
        audienceRating: g.audienceRating,
        audienceRatingImage: g.audienceRatingImage,
        year: g.year,
      };
    })
    .sort((a, b) => {
      const dir = sortOrder === "desc" ? -1 : 1;
      switch (sortBy) {
        case "trackCount":
          return (a.trackCount - b.trackCount) * dir;
        case "albumCount":
          return (a.albumCount - b.albumCount) * dir;
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
        default:
          return a.parentTitle.localeCompare(b.parentTitle) * dir;
      }
    });

  if (limit > 0) {
    const offset = (page - 1) * limit;
    const paged = artistList.slice(offset, offset + limit + 1);
    const hasMore = paged.length > limit;
    if (hasMore) paged.pop();
    return NextResponse.json({ artists: paged, pagination: { page, limit, hasMore } });
  }
  return NextResponse.json({ artists: artistList, pagination: { page, limit, hasMore: false } });
}
