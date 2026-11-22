import { prisma } from "@/lib/db";
import { completedPlaySql } from "@/lib/media/watch-completion";

/**
 * The Top Played card's lists over a time window: the ten movies, series and
 * artists with the most plays in `WatchHistory` since `since`, in the shape
 * `computeLibraryStats` gives its all-time lists (`topMovies`, `topSeries`,
 * `topMusic`), so the card renders either.
 *
 * A play is one `WatchHistory` row that counts as a play (`completedPlaySql`),
 * the definition `playCount` follows, so a window as long as the history ranks
 * as the all-time lists do. Plays are counted wherever they happened, as the
 * all-time lists sum every copy: with dedup on, a film's copies (one
 * `dedupKey`) add up and the title is named by its canonical copy. Series
 * group by `seriesKey`, artists by `parentTitle`, as `computeLibraryStats` does.
 */

const TOP_LIMIT = 10;

export interface WindowTopMovie {
  id: string;
  title: string;
  year: number | null;
  playCount: number;
  thumbUrl: string | null;
}

export interface WindowTopGroup {
  parentTitle: string;
  totalPlays: number;
  thumbUrl: string | null;
  mediaItemId: string | null;
}

export interface WindowTopPlayed {
  topMovies: WindowTopMovie[];
  topSeries: WindowTopGroup[];
  topMusic: WindowTopGroup[];
}

export async function computeTopPlayedInWindow(
  serverIds: string[],
  dedupEnabled: boolean,
  since: Date,
): Promise<WindowTopPlayed> {
  if (serverIds.length === 0) return { topMovies: [], topSeries: [], topMusic: [] };
  const [topMovies, topSeries, topMusic] = await Promise.all([
    topMoviesInWindow(serverIds, dedupEnabled, since),
    topGroupsInWindow(serverIds, since, "SERIES"),
    topGroupsInWindow(serverIds, since, "MUSIC"),
  ]);
  return { topMovies, topSeries, topMusic };
}

async function topMoviesInWindow(serverIds: string[], dedupEnabled: boolean, since: Date): Promise<WindowTopMovie[]> {
  // Without dedup each copy is its own title, as in the all-time list.
  const titleKey = dedupEnabled ? `COALESCE(mi."dedupKey", mi.id)` : `mi.id`;
  const top = await prisma.$queryRawUnsafe<{ title_key: string; plays: number }[]>(
    `SELECT ${titleKey} AS title_key, COUNT(*)::int AS plays
     FROM "WatchHistory" wh
     JOIN "MediaItem" mi ON wh."mediaItemId" = mi.id
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1::text[]) AND mi.type = 'MOVIE'::"LibraryType"
       AND wh."watchedAt" >= $2 AND ${completedPlaySql("wh")}
     GROUP BY 1
     ORDER BY plays DESC, title_key
     LIMIT ${TOP_LIMIT}`,
    serverIds, since,
  );
  if (top.length === 0) return [];
  const keys = top.map((t) => t.title_key);
  const reps = await prisma.$queryRawUnsafe<(Omit<WindowTopMovie, "playCount"> & { title_key: string })[]>(
    `SELECT DISTINCT ON (${titleKey}) ${titleKey} AS title_key, mi.id, mi.title, mi.year, mi."thumbUrl"
     FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1::text[]) AND mi.type = 'MOVIE'::"LibraryType"
       AND ${titleKey} = ANY($2::text[])
     ORDER BY ${titleKey}, mi."dedupCanonical" DESC, mi.id`,
    serverIds, keys,
  );
  const repByKey = new Map(reps.map((r) => [r.title_key, r]));
  return top.flatMap((t) => {
    const rep = repByKey.get(t.title_key);
    return rep ? [{ id: rep.id, title: rep.title, year: rep.year, playCount: t.plays, thumbUrl: rep.thumbUrl }] : [];
  });
}

async function topGroupsInWindow(
  serverIds: string[],
  since: Date,
  type: "SERIES" | "MUSIC",
): Promise<WindowTopGroup[]> {
  const groupColumn = type === "SERIES" ? `mi."seriesKey"` : `mi."parentTitle"`;
  const top = await prisma.$queryRawUnsafe<{ group_key: string; plays: number }[]>(
    `SELECT ${groupColumn} AS group_key, COUNT(*)::int AS plays
     FROM "WatchHistory" wh
     JOIN "MediaItem" mi ON wh."mediaItemId" = mi.id
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1::text[]) AND mi.type = $3::"LibraryType"
       AND ${groupColumn} IS NOT NULL
       AND wh."watchedAt" >= $2 AND ${completedPlaySql("wh")}
     GROUP BY 1
     ORDER BY plays DESC, group_key
     LIMIT ${TOP_LIMIT}`,
    serverIds, since, type,
  );
  if (top.length === 0) return [];
  // One representative row per group — a canonical one first, so a show or
  // artist on two servers links its canonical copy.
  const reps = await prisma.$queryRawUnsafe<{ group_key: string; id: string; parentTitle: string | null; parentThumbUrl: string | null }[]>(
    `SELECT DISTINCT ON (${groupColumn}) ${groupColumn} AS group_key, mi.id, mi."parentTitle", mi."parentThumbUrl"
     FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1::text[]) AND mi.type = $3::"LibraryType"
       AND ${groupColumn} = ANY($2::text[])
     ORDER BY ${groupColumn}, mi."dedupCanonical" DESC, mi."playCount" DESC, mi.id`,
    serverIds, top.map((t) => t.group_key), type,
  );
  const repByKey = new Map(reps.map((r) => [r.group_key, r]));
  return top.map((t) => {
    const rep = repByKey.get(t.group_key);
    return {
      parentTitle: rep?.parentTitle ?? (type === "MUSIC" ? t.group_key : ""),
      totalPlays: t.plays,
      thumbUrl: rep?.parentThumbUrl ?? null,
      mediaItemId: rep?.id ?? null,
    };
  });
}
