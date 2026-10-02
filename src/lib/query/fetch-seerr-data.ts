import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { walkSeerrRequests } from "@/lib/seerr/request-walk";
import { SeerrDataMapBuilder } from "@/lib/seerr/seerr-data-map";
import { splitProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { SeerrDataMap } from "@/lib/rules/lifecycle-engine";

/**
 * Fetch Seerr metadata for the query builder, merged across EVERY enabled
 * instance — the same data lifecycle rules read (`fetchSeerrMetadata`).
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

  const instances = await prisma.seerrInstance.findMany({
    where: { userId, enabled: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (instances.length === 0) {
    throw new Error("No enabled Seerr instance — Seerr criteria cannot be evaluated");
  }

  const builders = new Map(typesInScope.map((t) => [t, new SeerrDataMapBuilder(t)] as const));
  // One walk per instance covers every type in scope: with a single type the
  // server-side filter applies; with both, requests are routed by their own `type`.
  const onlyType = typesInScope.length === 1 ? typesInScope[0] : undefined;
  const reporters = splitProgress(onProgress, instances.length);
  for (let idx = 0; idx < instances.length; idx++) {
    const instance = instances[idx];
    await walkSeerrRequests(
      new SeerrClient(instance.url, instance.apiKey),
      {
        instanceName: instance.name,
        mediaType: onlyType ? (onlyType === "MOVIE" ? "movie" : "tv") : undefined,
        onProgress: reporters[idx],
        // Someone is waiting on the query page: an unreachable instance should
        // fail the query after one timeout, not after the retry budget.
        failFast: true,
      },
      (req) => {
        const type = req.type === "movie" ? "MOVIE" : req.type === "tv" ? "SERIES" : null;
        if (type) builders.get(type)?.add(req);
      },
    );
  }

  const result: Record<string, SeerrDataMap> = {};
  for (const [type, builder] of builders) result[type] = builder.build();
  return result;
}
