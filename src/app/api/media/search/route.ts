import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { escapeLike } from "@/lib/filters/escape-like";
import { resolveSeriesKey } from "@/lib/media/series-key";
import type { Prisma } from "@/generated/prisma/client";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // Trimmed for the empty check; every `contains` below gets `escapeLike(q)`
  // because `contains` is a LIKE pattern Prisma does not escape — a `%` or
  // `_` in `q` is otherwise a wildcard (see escape-like.ts for the live case).
  const q = searchParams.get("q")?.trim();
  const type = searchParams.get("type");
  const seriesScope = searchParams.get("seriesScope") === "true";
  const musicScope = searchParams.get("musicScope") === "true";

  if (!q || q.length === 0) {
    return NextResponse.json({ items: [] });
  }
  if (!type || !["MOVIE", "SERIES", "MUSIC"].includes(type)) {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  const ownershipFilter: Prisma.MediaItemWhereInput = {
    library: { mediaServer: { userId: session.userId } },
    type: type as "MOVIE" | "SERIES" | "MUSIC",
  };

  // Music scope: search by artist (parentTitle) and album (albumTitle), return deduplicated grouped results
  if (musicScope && type === "MUSIC") {
    const items = await prisma.mediaItem.findMany({
      where: {
        ...ownershipFilter,
        OR: [
          { parentTitle: { contains: escapeLike(q), mode: "insensitive" } },
          { albumTitle: { contains: escapeLike(q), mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        title: true,
        parentTitle: true,
        albumTitle: true,
        year: true,
        thumbUrl: true,
        type: true,
        libraryId: true,
      },
      orderBy: { parentTitle: "asc" },
      take: 200,
    });

    const qLower = q.toLowerCase();
    const artists = new Map<
      string,
      { item: (typeof items)[0]; count: number }
    >();
    const albums = new Map<
      string,
      { item: (typeof items)[0]; count: number }
    >();

    for (const item of items) {
      // Bucket into artists by parentTitle match
      if (item.parentTitle?.toLowerCase().includes(qLower)) {
        const key = item.parentTitle;
        const existing = artists.get(key);
        if (existing) {
          existing.count++;
        } else {
          artists.set(key, { item, count: 1 });
        }
      }

      // Bucket into albums by albumTitle match
      if (item.albumTitle?.toLowerCase().includes(qLower)) {
        const key = `${item.parentTitle ?? ""}::${item.albumTitle}`;
        const existing = albums.get(key);
        if (existing) {
          existing.count++;
        } else {
          albums.set(key, { item, count: 1 });
        }
      }
    }

    const results: Record<string, unknown>[] = [];

    for (const [, { item, count }] of artists) {
      results.push({
        id: item.id,
        title: item.parentTitle,
        parentTitle: null,
        albumTitle: null,
        year: item.year,
        thumbUrl: item.thumbUrl,
        type: item.type,
        libraryId: item.libraryId,
        scope: "artist",
        itemCount: count,
      });
    }

    // Skip album results whose artist already appears as an artist result
    // (avoids confusing near-duplicates when artist and album names overlap)
    const artistKeys = new Set(artists.keys());

    for (const [, { item, count }] of albums) {
      if (item.parentTitle && artistKeys.has(item.parentTitle) && item.albumTitle?.toLowerCase() === item.parentTitle.toLowerCase()) {
        continue;
      }
      results.push({
        id: item.id,
        title: item.albumTitle,
        parentTitle: item.parentTitle,
        albumTitle: item.albumTitle,
        year: item.year,
        thumbUrl: item.thumbUrl,
        type: item.type,
        libraryId: item.libraryId,
        scope: "album",
        itemCount: count,
      });
    }

    return NextResponse.json({ items: results.slice(0, 20) });
  }

  const where: Prisma.MediaItemWhereInput = { ...ownershipFilter };

  if (type === "MOVIE") {
    where.title = { contains: escapeLike(q), mode: "insensitive" };
  } else if (seriesScope) {
    // Series/music with scope: only search by parentTitle (series/artist name)
    where.parentTitle = { contains: escapeLike(q), mode: "insensitive" };
  } else {
    // Series/music without scope: search by title and parentTitle
    where.OR = [
      { title: { contains: escapeLike(q), mode: "insensitive" } },
      { parentTitle: { contains: escapeLike(q), mode: "insensitive" } },
    ];
  }

  const items = await prisma.mediaItem.findMany({
    where,
    select: {
      id: true,
      title: true,
      parentTitle: true,
      seriesKey: true,
      // An episode is named by its show and SxxExx, not its own title.
      seasonNumber: true,
      episodeNumber: true,
      year: true,
      thumbUrl: true,
      type: true,
      libraryId: true,
    },
    orderBy: { title: "asc" },
    take: seriesScope && type !== "MOVIE" ? 100 : 10,
  });

  // For series with scope, deduplicate by parentTitle and return grouped results
  if (seriesScope && type !== "MOVIE") {
    const seen = new Map<string, { item: (typeof items)[0]; count: number }>();
    for (const item of items) {
      // Group by series identity so two same-titled shows list separately.
      const key = resolveSeriesKey(item) ?? item.parentTitle ?? item.title;
      const existing = seen.get(key);
      if (existing) {
        existing.count++;
      } else {
        seen.set(key, { item, count: 1 });
      }
    }
    const grouped = [...seen.values()].slice(0, 10).map(({ item, count }) => ({
      id: item.id,
      title: item.parentTitle ?? item.title,
      parentTitle: null,
      year: item.year,
      thumbUrl: item.thumbUrl,
      type: item.type,
      libraryId: item.libraryId,
      scope: "series",
      itemCount: count,
    }));
    return NextResponse.json({ items: grouped });
  }

  // Default: individual items (movies or unscoped series/music)
  const withScope = items.map((item) => ({
    ...item,
    scope: "individual",
  }));

  return NextResponse.json({ items: withScope });
}
