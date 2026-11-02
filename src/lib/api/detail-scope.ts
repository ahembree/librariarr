import { prisma } from "@/lib/db";

/**
 * The record a detail page shows, read for its child list.
 *
 * A show, season, album or artist page fetched its record and only then the
 * child list (the seasons, the episodes, the tracks, the albums), because the
 * list is scoped by the record's series key, title, season or album. Given
 * the record's id instead (`?itemId=`), the list route reads those fields
 * itself, so the page can send both requests at once.
 *
 * Owned items only — the same guard the record route applies — and only of
 * the type the list holds; `null` otherwise, which the routes answer with 404.
 */
export async function loadDetailScope(
  userId: string,
  itemId: string,
  type: "SERIES" | "MUSIC",
): Promise<DetailScope | null> {
  return prisma.mediaItem.findFirst({
    where: { id: itemId, type, library: { mediaServer: { userId } } },
    select: { title: true, parentTitle: true, seriesKey: true, seasonNumber: true, albumTitle: true },
  });
}

export interface DetailScope {
  title: string;
  parentTitle: string | null;
  seriesKey: string | null;
  seasonNumber: number | null;
  albumTitle: string | null;
}

/**
 * The series a show page names: its identity key, or — for a legacy row with
 * none — its title, as the page built `seriesKey=` / `parentTitle=` itself.
 */
export function seriesOfScope(scope: DetailScope): { seriesKey: string } | { parentTitle: string } {
  return scope.seriesKey ? { seriesKey: scope.seriesKey } : { parentTitle: scope.parentTitle || scope.title };
}
