import { loadArrInstanceData } from "@/lib/arr/family-data";
import { ARR_FAMILY_FOR_TYPE, findArrInstance } from "@/lib/arr/instances";
import { splitProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

type QueryMediaType = "MOVIE" | "SERIES" | "MUSIC";

const ARR_FAMILY: Record<QueryMediaType, { key: "radarr" | "sonarr" | "lidarr"; label: string; typeLabel: string }> = {
  MOVIE: { key: "radarr", label: "Radarr", typeLabel: "Movies" },
  SERIES: { key: "sonarr", label: "Sonarr", typeLabel: "Series" },
  MUSIC: { key: "lidarr", label: "Lidarr", typeLabel: "Music" },
};

/**
 * Which of a query's media types its Arr criteria can be judged for: those
 * with an Arr server selected that still exists and is enabled. A type without
 * one has no Arr data, so a rule like "Found In Arr = false" would match every
 * item of it — the engine leaves such a type out of the results instead, and
 * `unevaluable` says why for each.
 */
export async function resolveQueryArrScope(
  userId: string,
  arrServerIds: { radarr?: string; sonarr?: string; lidarr?: string } | undefined,
  mediaTypes: string[],
): Promise<{ evaluable: QueryMediaType[]; unevaluable: Array<{ type: QueryMediaType; reason: string }> }> {
  const typesInScope = (mediaTypes.length === 0 ? ["MOVIE", "SERIES", "MUSIC"] : mediaTypes) as QueryMediaType[];
  const evaluable: QueryMediaType[] = [];
  const unevaluable: Array<{ type: QueryMediaType; reason: string }> = [];
  for (const type of typesInScope) {
    const family = ARR_FAMILY[type];
    if (!family) continue;
    const id = arrServerIds?.[family.key];
    if (!id) {
      unevaluable.push({ type, reason: `${family.typeLabel} left out: no ${family.label} server is selected for the query's Arr criteria` });
      continue;
    }
    const instance = await findArrInstance(ARR_FAMILY_FOR_TYPE[type], { id, userId }, { name: true, enabled: true });
    if (!instance) {
      unevaluable.push({ type, reason: `${family.typeLabel} left out: the selected ${family.label} server no longer exists` });
    } else if (!instance.enabled) {
      unevaluable.push({ type, reason: `${family.typeLabel} left out: ${family.label} server "${instance.name}" is disabled` });
    } else {
      evaluable.push(type);
    }
  }
  return { evaluable, unevaluable };
}

interface FetchArrDataForQueryOptions {
  /**
   * Read Radarr's custom-format scores — only for a query whose criteria or
   * visible columns include Custom Format Score (see `ArrFamilyLoadOptions`).
   * Defaults to true, the complete answer.
   */
  customFormatScores?: boolean;
}

/**
 * Fetch Arr metadata from specific instances for the query builder.
 * Unlike the lifecycle fetcher (which queries ALL instances), this fetches
 * from the user-selected instance per Arr type.
 *
 * Returns a map keyed by media type: { MOVIE: ArrDataMap, SERIES: ArrDataMap, MUSIC: ArrDataMap }
 *
 * `onProgress` (optional) reports combined 0..1 completion across the per-type
 * fetches, which run concurrently.
 */
export async function fetchArrDataForQuery(
  userId: string,
  arrServerIds: { radarr?: string; sonarr?: string; lidarr?: string },
  mediaTypes: string[],
  onProgress?: FractionReporter,
  options: FetchArrDataForQueryOptions = {},
): Promise<Record<string, ArrDataMap>> {
  const result: Record<string, ArrDataMap> = {};
  const typesInScope = mediaTypes.length === 0
    ? ["MOVIE", "SERIES", "MUSIC"]
    : mediaTypes;

  // Resolve which per-type fetches will run BEFORE creating reporters so the
  // combined progress is averaged over exactly the active fetches.
  const tasks = (["MOVIE", "SERIES", "MUSIC"] as const)
    .filter((type) => arrServerIds[ARR_FAMILY[type].key] && typesInScope.includes(type))
    .map((type) => async (report: FractionReporter) => {
      const data = await fetchInstanceData(userId, type, arrServerIds[ARR_FAMILY[type].key]!, report, options);
      if (data) result[type] = data;
    });

  const reporters = splitProgress(onProgress, tasks.length);
  await Promise.all(tasks.map((task, i) => task(reporters[i])));
  return result;
}

async function fetchInstanceData(
  userId: string,
  type: QueryMediaType,
  instanceId: string,
  onProgress: FractionReporter | undefined,
  options: FetchArrDataForQueryOptions,
): Promise<ArrDataMap | null> {
  // A disabled instance is one the user switched off — its data may be stale
  // or its server gone — so it answers no criteria (resolveQueryArrScope).
  const family = ARR_FAMILY_FOR_TYPE[type];
  const instance = await findArrInstance(family, { id: instanceId, userId, enabled: true });
  if (!instance) return null;
  return loadArrInstanceData(family, instance, {
    customFormatScores: options.customFormatScores ?? true,
    onProgress,
  });
}
