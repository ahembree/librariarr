import { loadEnabledSeerrInstances, walkSeerrInstances } from "@/lib/lifecycle/fetch-seerr-metadata";
import type { FractionReporter } from "@/lib/progress/fraction";
import type { SeerrDataMap } from "@/lib/rules/lifecycle-engine";

/**
 * Fetch Seerr metadata for the query builder, merged across EVERY enabled
 * instance — the same data lifecycle rules read (`fetchSeerrMetadata`, through
 * the same `walkSeerrInstances`).
 * Returns a map keyed by media type: { MOVIE: SeerrDataMap, SERIES: SeerrDataMap }
 *
 * The query path used to read one instance (whichever was added last), so a
 * title requested only through another instance read as never requested:
 * "Has Request = false" returned it, and a query action deleted it, while the
 * same criteria saved as a lifecycle rule did not match it.
 *
 * Throws when no instance is enabled: an empty map would make every item read
 * as never requested, so a "Has Request = false" query would return the whole
 * library with nothing to say the answer was invented.
 *
 * `onProgress` (optional) reports 0..1 completion across the instances' walks.
 */
export async function fetchSeerrDataForQuery(
  userId: string,
  mediaTypes: string[],
  onProgress?: FractionReporter,
): Promise<Record<string, SeerrDataMap>> {
  const typesInScope = (mediaTypes.length === 0
    ? ["MOVIE", "SERIES"]
    : mediaTypes.filter((t) => t === "MOVIE" || t === "SERIES")) as Array<"MOVIE" | "SERIES">;
  if (typesInScope.length === 0) return {};

  const instances = await loadEnabledSeerrInstances(userId);
  if (instances.length === 0) {
    throw new Error("No enabled Seerr instance — Seerr criteria cannot be evaluated");
  }

  // Someone is waiting on the query page: an unreachable instance should
  // fail the query after one timeout, not after the retry budget.
  const byType = await walkSeerrInstances(instances, typesInScope, { onProgress, failFast: true });
  const result: Record<string, SeerrDataMap> = {};
  for (const type of typesInScope) result[type] = byType[type]!;
  return result;
}
