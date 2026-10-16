import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { escapeLike } from "@/lib/filters/escape-like";
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
    // Grouped and counted in SQL. Grouping the first 200 matching TRACKS in JS
    // (ordered by artist) let one prolific artist fill the window, so a later
    // matching artist or album never came back at all, and every count was the
    // number of tracks that landed in the window. A copy on another server is
    // the same track, so tracks are counted by `dedupKey`.
    const pattern = escapeLike(q);
    const [artistGroups, albumGroups] = await Promise.all([
      prisma.$queryRaw<{ id: string; n: number }[]>`
        SELECT (array_agg(mi.id ORDER BY mi."albumTitle", mi.title, mi.id))[1] AS id,
          COUNT(DISTINCT COALESCE(mi."dedupKey", mi.id))::int AS n
        FROM "MediaItem" mi
        JOIN "Library" l ON l.id = mi."libraryId"
        JOIN "MediaServer" ms ON ms.id = l."mediaServerId"
        WHERE ms."userId" = ${session.userId} AND mi.type = 'MUSIC'::"LibraryType"
          AND mi."parentTitle" ILIKE '%' || ${pattern} || '%'
        GROUP BY mi."parentTitle"
        ORDER BY mi."parentTitle"
        LIMIT 20`,
      prisma.$queryRaw<{ id: string; n: number }[]>`
        SELECT (array_agg(mi.id ORDER BY mi.title, mi.id))[1] AS id,
          COUNT(DISTINCT COALESCE(mi."dedupKey", mi.id))::int AS n
        FROM "MediaItem" mi
        JOIN "Library" l ON l.id = mi."libraryId"
        JOIN "MediaServer" ms ON ms.id = l."mediaServerId"
        WHERE ms."userId" = ${session.userId} AND mi.type = 'MUSIC'::"LibraryType"
          AND mi."albumTitle" ILIKE '%' || ${pattern} || '%'
        GROUP BY mi."parentTitle", mi."albumTitle"
        ORDER BY mi."parentTitle" NULLS FIRST, mi."albumTitle"
        LIMIT 20`,
    ]);

    const reps = await prisma.mediaItem.findMany({
      where: { id: { in: [...artistGroups, ...albumGroups].map((g) => g.id) } },
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
    });
    const repById = new Map(reps.map((r) => [r.id, r]));
    const toGroups = (groups: { id: string; n: number }[]) =>
      groups.flatMap((g) => {
        const item = repById.get(g.id);
        return item ? [{ item, count: g.n }] : [];
      });
    const artists = new Map(toGroups(artistGroups).map((g) => [g.item.parentTitle!, g]));
    const albums = toGroups(albumGroups);

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

    for (const { item, count } of albums) {
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

  // Series (or artist) scope: one row per show, grouped and counted in SQL.
  // This took the first 100 matching EPISODE rows (ordered by the episode's own
  // title) and grouped them in JS, so a long show whose episode titles sort
  // first filled the window and a second matching show was never returned at
  // all — the Exceptions dialog could not find it to protect it — and every
  // "N eps" was the number of rows that landed in the window. Keyed on series
  // identity (`seriesKey`; a legacy row without one keys on its title the way
  // `resolveSeriesKey` would) so two same-titled shows list separately, and a
  // copy on another server is the same episode, so episodes count by `dedupKey`.
  if (seriesScope && type !== "MOVIE") {
    const groups = await prisma.$queryRaw<{ id: string; n: number }[]>`
      SELECT (array_agg(mi.id ORDER BY mi.title, mi.id))[1] AS id,
        COUNT(DISTINCT COALESCE(mi."dedupKey", mi.id))::int AS n
      FROM "MediaItem" mi
      JOIN "Library" l ON l.id = mi."libraryId"
      JOIN "MediaServer" ms ON ms.id = l."mediaServerId"
      WHERE ms."userId" = ${session.userId} AND mi.type = ${type}::"LibraryType"
        AND mi."parentTitle" ILIKE '%' || ${escapeLike(q)} || '%'
      GROUP BY COALESCE(mi."seriesKey", 'title:' || LOWER(TRIM(mi."parentTitle")))
      ORDER BY MIN(LOWER(mi."parentTitle")), COALESCE(mi."seriesKey", 'title:' || LOWER(TRIM(mi."parentTitle")))
      LIMIT 10`;
    const reps = await prisma.mediaItem.findMany({
      where: { id: { in: groups.map((g) => g.id) } },
      select: { id: true, title: true, parentTitle: true, year: true, thumbUrl: true, type: true, libraryId: true },
    });
    const repById = new Map(reps.map((r) => [r.id, r]));
    const grouped = groups.flatMap((g) => {
      const item = repById.get(g.id);
      if (!item) return [];
      return [{
        id: item.id,
        title: item.parentTitle ?? item.title,
        parentTitle: null,
        year: item.year,
        thumbUrl: item.thumbUrl,
        type: item.type,
        libraryId: item.libraryId,
        scope: "series",
        itemCount: g.n,
      }];
    });
    return NextResponse.json({ items: grouped });
  }

  const where: Prisma.MediaItemWhereInput = { ...ownershipFilter };

  if (type === "MOVIE") {
    where.title = { contains: escapeLike(q), mode: "insensitive" };
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
    take: 10,
  });

  // Default: individual items (movies or unscoped series/music)
  const withScope = items.map((item) => ({
    ...item,
    scope: "individual",
  }));

  return NextResponse.json({ items: withScope });
}
