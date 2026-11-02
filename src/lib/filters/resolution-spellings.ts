import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";
import { normalizeResolutionLabel } from "@/lib/resolution";

/**
 * Every stored resolution value, grouped by the label `normalizeResolutionLabel`
 * gives it ("576" → "480P", "1024" → "1080P") — what `applyCommonFilters` needs
 * to match a Resolution filter by the same label the quality chips and the
 * filter dropdown show.
 *
 * Without it a label matches only its fixed spellings (`RESOLUTION_DB_VALUES`),
 * so a PAL show stored as "576" sat under a "480P" chip, was left out by the
 * 480P filter and came back under "Other". The Series page used to filter by
 * its chips' labels on the client, so moving that filter to the server lost
 * those shows.
 *
 * Kept out of build-where.ts so that module stays free of the database client.
 * Cached under the `distinct-values` prefix, so `invalidateMediaCaches()` drops
 * it with the dropdown it mirrors.
 */
const RESOLUTIONS_CACHE_KEY = "distinct-values:resolutions";
const RESOLUTIONS_TTL_MS = 5 * 60_000;

/** `undefined` when the request has no resolution filter (no lookup is made). */
export async function loadResolutionSpellings(
  params: URLSearchParams,
): Promise<Map<string, string[]> | undefined> {
  if (!params.get("resolution")) return undefined;
  const resolutions = await appCache.getOrSet(
    RESOLUTIONS_CACHE_KEY,
    async () =>
      (
        await prisma.$queryRaw<{ resolution: string }[]>`
          SELECT DISTINCT mi.resolution AS "resolution"
          FROM "MediaItem" mi
          WHERE mi.resolution IS NOT NULL
        `
      ).map((r) => r.resolution),
    RESOLUTIONS_TTL_MS,
  );
  const byLabel = new Map<string, string[]>();
  for (const resolution of resolutions) {
    const label = normalizeResolutionLabel(resolution);
    const spellings = byLabel.get(label);
    if (spellings) spellings.push(resolution);
    else byLabel.set(label, [resolution]);
  }
  return byLabel;
}
