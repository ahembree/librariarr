import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";

/**
 * Every stored spelling of each genre, keyed by its lower-cased form — what
 * `applyCommonFilters` needs to match a genre filter case-insensitively.
 *
 * The filter dropdown (`/api/media/distinct-values`) offers ONE entry per genre
 * whatever its case, but Prisma's `array_contains` is case-sensitive and has no
 * insensitive form, so with two servers tagging "Sci-Fi" and "sci-fi" the
 * items carrying the spelling the dropdown did not offer could never be
 * selected. The rule engine already treats genres case-insensitively.
 *
 * Kept out of build-where.ts so that module stays free of the database client.
 * Cached under the `distinct-values` prefix, so `invalidateMediaCaches()` drops
 * it with the dropdown it mirrors.
 */
const GENRES_CACHE_KEY = "distinct-values:genres";
const GENRES_TTL_MS = 5 * 60_000;

/** `undefined` when the request has no genre filter (no lookup is made). */
export async function loadGenreSpellings(
  params: URLSearchParams,
): Promise<Map<string, string[]> | undefined> {
  if (!params.get("genre")) return undefined;
  const genres = await appCache.getOrSet(
    GENRES_CACHE_KEY,
    async () =>
      (
        await prisma.$queryRaw<{ genre: string }[]>`
          SELECT DISTINCT g.genre AS "genre"
          FROM "MediaItem" mi
          CROSS JOIN LATERAL jsonb_array_elements_text(mi.genres) AS g(genre)
          WHERE mi.genres IS NOT NULL AND jsonb_typeof(mi.genres) = 'array'
        `
      ).map((r) => r.genre),
    GENRES_TTL_MS,
  );
  const byLower = new Map<string, string[]>();
  for (const genre of genres) {
    const key = genre.toLowerCase();
    const spellings = byLower.get(key);
    if (spellings) spellings.push(genre);
    else byLower.set(key, [genre]);
  }
  return byLower;
}
