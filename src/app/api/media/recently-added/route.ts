import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { resolveServerFilter } from "@/lib/dedup/server-filter";

type LibraryTypeName = "MOVIE" | "SERIES" | "MUSIC";

/**
 * How far back from a group's newest member still counts as the same addition.
 *
 * A season pack lands over minutes; a weekly episode lands alone. Without a
 * window, `COUNT(*)` reports the whole season forever after the first episode.
 */
const BATCH_WINDOW_HOURS = 24;
const LIBRARY_TYPES: readonly string[] = ["MOVIE", "SERIES", "MUSIC"];

/**
 * Recently added shelf for the dashboard.
 *
 * Rows are **collapsed into the unit a person actually added**, because one
 * addition is rarely one row: dropping in a season pack, or letting Plex pick up
 * this week's episode, emits one `MediaItem` per episode and used to flood the
 * shelf with identical posters. Grouping is:
 *
 * - **SERIES** → `seriesKey` + `seasonNumber`. Keyed on `seriesKey`, never
 *   `parentTitle`, so two shows sharing a title stay separate (see "Series
 *   identity" in CLAUDE.md); split by season so two seasons of the same show
 *   read as two additions, which is what the shelf is for.
 * - **MUSIC** → artist + album (`parentTitle` + `albumTitle`, lower/trimmed —
 *   the composite key `/api/media/music/albums/all` already uses, since there is
 *   no artist-identity column).
 * - **MOVIE**, and anything missing its grouping key, stays one row per item.
 *
 * Grouping happens in SQL rather than by over-fetching and folding in JS: the
 * shelf wants N *groups*, and a single season pack can be hundreds of rows, so
 * no fixed row budget both fills the shelf and stays bounded. It deliberately
 * does NOT reuse `/api/media/series/grouped`, which aggregates the whole library
 * in memory before slicing — proportionate for a full library page, absurd for
 * 24 tiles.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const serverId = searchParams.get("serverId");
  // Validated, never cast. This value reaches raw SQL, and a bare `as` is a
  // compile-time fiction: an unvalidated string would be both an injection
  // vector and a 500 on any typo. An unrecognized value is treated as "no type
  // filter" rather than an error, matching how the other list routes behave.
  const rawType = searchParams.get("type");
  const type = LIBRARY_TYPES.includes(rawType as LibraryTypeName)
    ? (rawType as LibraryTypeName)
    : null;

  const [sf, settings] = await Promise.all([
    resolveServerFilter(session.userId!, serverId, type ?? undefined),
    prisma.appSettings.findUnique({
      where: { userId: session.userId! },
      select: { dedupStats: true },
    }),
  ]);

  // `resolveServerFilter` returns null for two different situations: an explicit
  // `serverId` that isn't the user's (a 404), and no enabled servers at all (an
  // empty shelf, not an error — this is the pre-setup / no-servers-yet state).
  if (!sf) {
    return serverId
      ? NextResponse.json({ error: "Server not found" }, { status: 404 })
      : NextResponse.json({ items: [], total: 0 });
  }
  if (sf.serverIds.length === 0) {
    return NextResponse.json({ items: [], total: 0 });
  }

  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "10", 10) || 10, 1), 50);
  const dedupEnabled = (settings?.dedupStats ?? true) && !sf.isSingleServer;
  const artworkServerId = sf.preferredArtworkServerId ?? sf.preferredTitleServerId ?? "";

  const params: unknown[] = [sf.serverIds, artworkServerId];
  const conditions = [
    `l."mediaServerId" = ANY($1::text[])`,
    `mi."addedAt" IS NOT NULL`,
    ...(dedupEnabled ? [`mi."dedupCanonical" = true`] : []),
  ];
  if (type) {
    params.push(type);
    conditions.push(`mi."type" = $${params.length}::"LibraryType"`);
  }
  const whereSql = conditions.join(" AND ");

  // Every aggregated column reads from the SAME representative row, so the
  // title, season and poster on a collapsed tile can't come from different
  // episodes. Preference order: the artwork-preferred server, then a row that
  // actually carries the art the tile will request, then the newest, then id for
  // a stable tiebreak. The artwork preference mirrors `resolveArtworkPath`'s own
  // chain for `?type=season` (season/album art → series/artist art → the item's
  // own), so the representative is the member most likely to render a real
  // poster rather than one whose season art happens to be missing.
  const pick = `ORDER BY
    CASE WHEN "mediaServerId" = $2 THEN 0 ELSE 1 END,
    CASE
      WHEN "seasonThumbUrl" IS NOT NULL THEN 0
      WHEN "parentThumbUrl" IS NOT NULL THEN 1
      ELSE 2
    END,
    "addedAt" DESC, id`;
  const agg = (col: string) => `(array_agg(${col} ${pick}))[1]`;

  // Members are windowed to the group's own most recent addition, so a weekly
  // show reads "1 new episode" and not "8 episodes" — `COUNT(*)` over the whole
  // group would relabel the entire season every time one episode lands, suppress
  // its hover card and redirect its click to the season, every week forever.
  const baseCte = `
    WITH items AS (
      SELECT mi.id, mi.title, mi.year, mi."type"::text AS type,
             mi."parentTitle", mi."albumTitle", mi."seasonNumber", mi."episodeNumber",
             mi."addedAt", mi."thumbUrl", mi."parentThumbUrl", mi."seasonThumbUrl", mi."seriesKey",
             l."mediaServerId"
        FROM "MediaItem" mi
        JOIN "Library" l ON mi."libraryId" = l."id"
       WHERE ${whereSql}
    ),
    keyed AS (
      SELECT *,
        CASE
          -- Only collapse when the resulting tile can actually navigate
          -- somewhere correct. A NULL seasonNumber would render "S00" and open
          -- the Specials page (which coerces null → 0), listing different
          -- episodes than the tile stood for; a blank artist would open an album
          -- page that refuses to query without one and renders empty. Both stay
          -- one tile per item instead of promising a destination that lies.
          WHEN type = 'SERIES' AND "seriesKey" IS NOT NULL AND "seasonNumber" IS NOT NULL
            THEN 'series:' || "seriesKey" || '::' || "seasonNumber"::text
          WHEN type = 'MUSIC'
               AND NULLIF(TRIM(COALESCE("albumTitle", '')), '') IS NOT NULL
               AND NULLIF(TRIM(COALESCE("parentTitle", '')), '') IS NOT NULL
            THEN 'album:' || LOWER(TRIM("parentTitle")) || '::' || LOWER(TRIM("albumTitle"))
          ELSE 'item:' || id
        END AS group_key
        FROM items
    ),
    windowed AS (
      SELECT *, MAX("addedAt") OVER (PARTITION BY group_key) AS group_added_at
        FROM keyed
    ),
    recent AS (
      SELECT * FROM windowed
       WHERE "addedAt" >= group_added_at - INTERVAL '${BATCH_WINDOW_HOURS} hours'
    )`;

  interface GroupRow {
    id: string;
    title: string;
    year: number | null;
    type: "MOVIE" | "SERIES" | "MUSIC";
    parentTitle: string | null;
    albumTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    addedAt: Date | null;
    thumbUrl: string | null;
    parentThumbUrl: string | null;
    seasonThumbUrl: string | null;
    memberCount: number;
    groupKey: string;
    groupTotal: number;
  }

  const rows = await prisma.$queryRawUnsafe<GroupRow[]>(
    `${baseCte}
     SELECT group_key AS "groupKey",
            COUNT(*)::int AS "memberCount",
            MAX("addedAt") AS "addedAt",
            ${agg("id")} AS id,
            ${agg("title")} AS title,
            ${agg("year")} AS year,
            ${agg("type")} AS type,
            ${agg(`"parentTitle"`)} AS "parentTitle",
            ${agg(`"albumTitle"`)} AS "albumTitle",
            ${agg(`"seasonNumber"`)} AS "seasonNumber",
            ${agg(`"episodeNumber"`)} AS "episodeNumber",
            ${agg(`"thumbUrl"`)} AS "thumbUrl",
            ${agg(`"parentThumbUrl"`)} AS "parentThumbUrl",
            ${agg(`"seasonThumbUrl"`)} AS "seasonThumbUrl",
            (COUNT(*) OVER ())::int AS "groupTotal"
       FROM recent
      GROUP BY group_key
      -- group_key is the unique tiebreak. A bulk import stamps a whole show
      -- with one addedAt, so without it tied groups permute between the first
      -- load and the sync-driven refetch, reshuffling the shelf and hiding rows.
      ORDER BY MAX("addedAt") DESC, group_key
      LIMIT ${limit}`,
    ...params,
  );

  return NextResponse.json({
    items: rows.map((r) => ({
      ...r,
      addedAt: r.addedAt?.toISOString() ?? null,
    })),
    // Folded into the same scan with COUNT(*) OVER () — a second query would
    // repeat the whole aggregate scan just to render "24 of N".
    total: rows[0]?.groupTotal ?? 0,
  });
}
