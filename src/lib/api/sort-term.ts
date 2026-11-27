import type { Prisma } from "@/generated/prisma/client";
import { PROVIDER_RATING_FIELDS } from "@/lib/media/external-ratings";

/**
 * Columns a flat listing sorts with their empty values last in BOTH
 * directions. Postgres puts NULLs first under DESC, and Plex's per-provider
 * ratings are empty on most rows of a mixed library (every Jellyfin/Emby item
 * without a Plex copy, every film without a Rotten Tomatoes score), so a
 * high-to-low sort opened on a page of "-" rows.
 */
const NULLS_LAST_SORT_FIELDS: ReadonlySet<string> = new Set(PROVIDER_RATING_FIELDS);

/** The `orderBy` term for a flat listing's user-chosen sort column. */
export function listSortTerm(
  sortBy: string,
  sortOrder: Prisma.SortOrder,
): Prisma.MediaItemOrderByWithRelationInput {
  return NULLS_LAST_SORT_FIELDS.has(sortBy)
    ? { [sortBy]: { sort: sortOrder, nulls: "last" } }
    : { [sortBy]: sortOrder };
}
