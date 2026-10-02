import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { walkSeerrRequests } from "@/lib/seerr/request-walk";
import { SeerrDataMapBuilder } from "@/lib/seerr/seerr-data-map";
import { splitProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { SeerrDataMap } from "@/lib/rules/lifecycle-engine";

/**
 * Whether at least one ENABLED Seerr instance exists. Rule sets that reference
 * Seerr fields must be skipped when this is false: `fetchSeerrMetadata` would
 * return an empty map, and the Phase 2 evaluator substitutes a default
 * "never requested" record for missing entries — making rules like
 * `seerrRequested equals false` vacuously true for the ENTIRE library.
 * "No instance" must read as "Seerr data unavailable", never as "nothing was
 * ever requested".
 */
export async function hasEnabledSeerrInstances(userId: string): Promise<boolean> {
  return (await prisma.seerrInstance.count({ where: { userId, enabled: true } })) > 0;
}

export async function fetchSeerrMetadata(
  userId: string,
  type: "MOVIE" | "SERIES",
  onProgress?: FractionReporter,
): Promise<SeerrDataMap> {
  const instances = await prisma.seerrInstance.findMany({
    where: { userId, enabled: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const builder = new SeerrDataMapBuilder(type);
  const reporters = splitProgress(onProgress, instances.length);
  for (let idx = 0; idx < instances.length; idx++) {
    const inst = instances[idx];
    const client = new SeerrClient(inst.url, inst.apiKey);
    await walkSeerrRequests(
      client,
      {
        instanceName: inst.name,
        mediaType: type === "MOVIE" ? "movie" : "tv",
        onProgress: reporters[idx],
      },
      (req) => builder.add(req),
    );
  }

  return builder.build();
}
