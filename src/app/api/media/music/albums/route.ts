import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { jsonResponse } from "@/lib/api/json-response";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters } from "@/lib/filters/build-where";
import { loadGenreSpellings } from "@/lib/filters/genre-spellings";
import { loadResolutionSpellings } from "@/lib/filters/resolution-spellings";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { loadDetailScope } from "@/lib/api/detail-scope";
import { loadMissingSummaries } from "@/lib/media/group-summaries";

export const GET = withSession(async (session, request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  // `itemId` names the artist page's record instead of its artist: the artist
  // is read here (`loadDetailScope`), so the page need not wait for the record.
  const itemId = searchParams.get("itemId");
  let parentTitle = searchParams.get("parentTitle");
  const serverId = searchParams.get("serverId");

  if (itemId) {
    const scope = await loadDetailScope(session.userId, itemId, "MUSIC");
    if (!scope) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // The artist the page names: the track's artist, else its own title.
    parentTitle = scope.parentTitle || scope.title;
  }

  if (!parentTitle) {
    return NextResponse.json({ error: "parentTitle is required" }, { status: 400 });
  }

  const sf = await resolveServerFilter(session.userId, serverId, "MUSIC");
  if (!sf) {
    return NextResponse.json({ albums: [] });
  }

  // The artist as the artist listing groups it — `LOWER(TRIM(parentTitle))`,
  // the key `getServerPresenceByGroup` uses too — not the exact spelling: an
  // artist merged from "Air" and "air " listed one album set, and opening it
  // here matched only the spelling passed in and dropped the other's tracks.
  // Resolved to the stored spellings so the where stays an exact `in`.
  const spellings = await prisma.$queryRaw<{ parentTitle: string }[]>`
    SELECT DISTINCT mi."parentTitle"
    FROM "MediaItem" mi
    JOIN "Library" l ON mi."libraryId" = l.id
    WHERE mi.type = 'MUSIC'::"LibraryType"
      AND l."mediaServerId" = ANY(${sf.serverIds}::text[])
      AND LOWER(TRIM(mi."parentTitle")) = LOWER(TRIM(${parentTitle}))
  `;

  const where: Prisma.MediaItemWhereInput = {
    type: "MUSIC",
    parentTitle: { in: spellings.map((r) => r.parentTitle) },
    library: { mediaServerId: { in: sf.serverIds } },
    ...(!sf.isSingleServer && { dedupCanonical: true }),
  };

  const [genreSpellings, resolutionSpellings] = await Promise.all([
    loadGenreSpellings(searchParams),
    loadResolutionSpellings(searchParams),
  ]);
  applyCommonFilters(where, searchParams, genreSpellings, resolutionSpellings);

  // The tracks without their blurbs, beside the ids of the ones that have one:
  // an album keeps the first track's summary of all its tracks', and every
  // track of an artist carries the same artist bio, so reading the prose of
  // each was most of what this route transferred. The few kept are read by id
  // afterwards (`loadMissingSummaries`).
  const [items, summarised] = await Promise.all([
    prisma.mediaItem.findMany({
      where,
      select: {
        id: true,
        title: true,
        albumTitle: true,
        audioCodec: true,
        fileSize: true,
        playCount: true,
        lastPlayedAt: true,
        addedAt: true,
        thumbUrl: true,
        parentThumbUrl: true,
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
      // The fold below keeps the FIRST track carrying each field (summary, year,
      // rating, the linked item), so the rows need a fixed order: unordered,
      // Postgres returned them in heap order and an UPDATE could change which
      // track's values an album showed. Track order as the album listing reads
      // it: disc (seasonNumber), then track number (episodeNumber), then id.
      orderBy: [
        { seasonNumber: { sort: "asc", nulls: "last" } },
        { episodeNumber: { sort: "asc", nulls: "last" } },
        { id: "asc" },
      ],
    }),
    // Blank text counts as none, as the fold's truthiness check read it.
    prisma.mediaItem.findMany({
      where: { AND: [where, { summary: { not: null } }, { NOT: { summary: "" } }] },
      select: { id: true },
    }),
  ]);
  const hasSummary = new Set(summarised.map((row) => row.id));

  // Group by album title (canonical items are already deduped)
  const albumMap = new Map<
    string,
    {
      albumTitle: string;
      trackCount: number;
      totalSize: bigint;
      audioCodecCounts: Record<string, number>;
      mediaItemId: string;
      /** Whether `mediaItemId` is a track with album art. */
      hasArt: boolean;
      totalPlayCount: number;
      lastPlayed: Date | null;
      addedAt: Date | null;
      servers: { serverId: string; serverName: string; serverType: string }[];
      /** The first track, in track order, that has a summary. */
      summaryItemId: string | null;
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
    const album = item.albumTitle ?? "Unknown Album";
    const normalizedKey = album.toLowerCase().trim();
    let albumGroup = albumMap.get(normalizedKey);
    if (!albumGroup) {
      albumGroup = {
        albumTitle: album,
        trackCount: 0,
        totalSize: BigInt(0),
        audioCodecCounts: {},
        mediaItemId: item.id,
        hasArt: false,
        totalPlayCount: 0,
        lastPlayed: null,
        addedAt: null,
        servers: [],
        summaryItemId: null,
        genres: null,
        studio: null,
        contentRating: null,
        rating: null,
        ratingImage: null,
        audienceRating: null,
        audienceRatingImage: null,
        year: null,
      };
      albumMap.set(normalizedKey, albumGroup);
    }

    albumGroup.trackCount++;

    if (item.fileSize) {
      albumGroup.totalSize += item.fileSize;
    }

    albumGroup.totalPlayCount += item.playCount;
    if (item.lastPlayedAt && (!albumGroup.lastPlayed || item.lastPlayedAt > albumGroup.lastPlayed)) {
      albumGroup.lastPlayed = item.lastPlayedAt;
    }
    if (item.addedAt && (!albumGroup.addedAt || item.addedAt > albumGroup.addedAt)) {
      albumGroup.addedAt = item.addedAt;
    }

    const codec = item.audioCodec ? item.audioCodec.toUpperCase() : "Unknown";
    albumGroup.audioCodecCounts[codec] = (albumGroup.audioCodecCounts[codec] || 0) + 1;

    // The first track with album art (the page asks for it with
    // `?type=parent`), else the first track — as the album listing picks it.
    // Reassigning on every track with art linked the LAST one instead.
    if (item.parentThumbUrl && !albumGroup.hasArt) {
      albumGroup.mediaItemId = item.id;
      albumGroup.hasArt = true;
    }

    if (!albumGroup.summaryItemId && hasSummary.has(item.id)) albumGroup.summaryItemId = item.id;
    if (!albumGroup.genres && item.genres) albumGroup.genres = item.genres as string[];
    if (!albumGroup.studio && item.studio) albumGroup.studio = item.studio;
    if (!albumGroup.contentRating && item.contentRating) albumGroup.contentRating = item.contentRating;
    if (albumGroup.rating == null && item.rating != null) albumGroup.rating = item.rating;
    if (!albumGroup.ratingImage && item.ratingImage) albumGroup.ratingImage = item.ratingImage;
    if (albumGroup.audienceRating == null && item.audienceRating != null) albumGroup.audienceRating = item.audienceRating;
    if (!albumGroup.audienceRatingImage && item.audienceRatingImage) albumGroup.audienceRatingImage = item.audienceRatingImage;
    if (albumGroup.year == null && item.year != null) albumGroup.year = item.year;

    const server = item.library.mediaServer;
    if (server && !albumGroup.servers.some((s) => s.serverId === server.id)) {
      albumGroup.servers.push({ serverId: server.id, serverName: server.name, serverType: server.type });
    }
  }

  // Each album's blurb, read for the one track it is taken from.
  const summaries = await loadMissingSummaries(
    [...albumMap].flatMap(([key, a]) => (a.summaryItemId ? [[key, a.summaryItemId] as const] : [])),
    "episode",
  );

  const albums = Array.from(albumMap)
    .map(([key, a]) => ({
      albumTitle: a.albumTitle,
      trackCount: a.trackCount,
      totalSize: a.totalSize.toString(),
      audioCodecCounts: a.audioCodecCounts,
      mediaItemId: a.mediaItemId,
      totalPlayCount: a.totalPlayCount,
      lastPlayed: a.lastPlayed,
      addedAt: a.addedAt,
      servers: a.servers,
      summary: summaries.get(key) ?? null,
      genres: a.genres,
      studio: a.studio,
      contentRating: a.contentRating,
      rating: a.rating,
      ratingImage: a.ratingImage,
      audienceRating: a.audienceRating,
      audienceRatingImage: a.audienceRatingImage,
      year: a.year,
    }))
    .sort((a, b) => a.albumTitle.localeCompare(b.albumTitle));

  return jsonResponse(request, { albums });
});
