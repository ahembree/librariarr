import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { walkSeerrRequests } from "@/lib/seerr/request-walk";
import { SeerrDataMapBuilder } from "@/lib/seerr/seerr-data-map";
import type { FractionReporter } from "@/lib/progress/fraction";
import type { SeerrDataMap } from "@/lib/rules/lifecycle-engine";

/**
 * Fetch Seerr metadata for the query builder from a specific instance.
 * Returns a map keyed by media type: { MOVIE: SeerrDataMap, SERIES: SeerrDataMap }
 *
 * Throws when the instance is missing or disabled: an empty map would make
 * every item read as never requested, so a "Has Request = false" query would
 * return the whole library with nothing to say the answer was invented.
 *
 * `onProgress` (optional) reports 0..1 completion of the request walk.
 */
export async function fetchSeerrDataForQuery(
  userId: string,
  seerrInstanceId: string,
  mediaTypes: string[],
  onProgress?: FractionReporter,
): Promise<Record<string, SeerrDataMap>> {
  const instance = await prisma.seerrInstance.findFirst({
    where: { id: seerrInstanceId, userId, enabled: true },
  });
  if (!instance) {
    throw new Error(
      "The selected Seerr instance is disabled or no longer exists — Seerr criteria cannot be evaluated",
    );
  }

  const typesInScope = (mediaTypes.length === 0
    ? ["MOVIE", "SERIES"]
    : mediaTypes.filter((t) => t === "MOVIE" || t === "SERIES")) as Array<"MOVIE" | "SERIES">;
  if (typesInScope.length === 0) return {};

  const builders = new Map(typesInScope.map((t) => [t, new SeerrDataMapBuilder(t)] as const));
  const client = new SeerrClient(instance.url, instance.apiKey);
  // One walk covers every type in scope: with a single type the server-side
  // filter applies; with both, requests are routed by their own `type`.
  const onlyType = typesInScope.length === 1 ? typesInScope[0] : undefined;
  await walkSeerrRequests(
    client,
    {
      instanceName: instance.name,
      mediaType: onlyType ? (onlyType === "MOVIE" ? "movie" : "tv") : undefined,
      onProgress,
    },
    (req) => {
      const type = req.type === "movie" ? "MOVIE" : req.type === "tv" ? "SERIES" : null;
      if (type) builders.get(type)?.add(req);
    },
  );

  const result: Record<string, SeerrDataMap> = {};
  for (const [type, builder] of builders) result[type] = builder.build();
  return result;
}
