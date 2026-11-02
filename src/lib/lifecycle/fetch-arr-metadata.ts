import { appCache } from "@/lib/cache/memory-cache";
import { loadArrFamilyData, loadArrRecord } from "@/lib/arr/family-data";
import {
  ARR_FAMILY_FOR_TYPE,
  countArrInstances,
  findArrInstance,
  findArrInstances,
} from "@/lib/arr/instances";
import type { FractionReporter } from "@/lib/progress/fraction";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

/** Human label for the Arr family that serves a library type. */
export function arrFamilyLabel(type: "MOVIE" | "SERIES" | "MUSIC"): string {
  return type === "MOVIE" ? "Radarr" : type === "MUSIC" ? "Lidarr" : "Sonarr";
}

/**
 * The one Arr instance a rule set's Arr criteria are read from.
 *
 * A rule set's action runs against `RuleSet.arrInstanceId`, so its criteria
 * must be judged on that same instance's records. Merged across every
 * instance, a movie present on two Radarrs (a 1080p and a 4K one is the common
 * setup) was judged on whichever instance happened to be read last: a `keep`
 * tag on the 4K copy could be replaced by the 1080p copy's tags, the rule set
 * matched, and its DELETE ran against the 4K instance.
 *
 * Returns the instance when `arrInstanceId` names one of this family that the
 * user owns; `null` otherwise (no instance chosen, or an id from another
 * family — those rule sets keep reading every enabled instance).
 */
export async function resolveArrInstanceScope(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  arrInstanceId?: string | null,
): Promise<{ id: string; name: string; enabled: boolean } | null> {
  if (!arrInstanceId) return null;
  return findArrInstance(
    ARR_FAMILY_FOR_TYPE[type],
    { id: arrInstanceId, userId },
    { id: true, name: true, enabled: true },
  );
}

/**
 * Whether at least one ENABLED Arr instance of the family serving `type`
 * exists — or, when `arrInstanceId` names an instance of that family, whether
 * THAT instance is enabled (see `resolveArrInstanceScope`). Rule sets that
 * reference Arr fields must be skipped when this is false: `fetchArrMetadata`
 * would return an empty map, and Phase 2 then
 * evaluates every item with `meta === undefined` — which makes
 * `foundInArr equals false` (the common "not managed by Radarr" rule)
 * vacuously true for the ENTIRE library. With a destructive action attached,
 * one detection cycle while an instance is disabled floods RuleMatch and
 * schedules deletes for everything; re-enabling the instance before the next
 * detection would then let those actions execute. "No instance" must read as
 * "Arr data unavailable" (skip, like a fetch failure), never as "nothing is
 * in Arr".
 */
export async function hasEnabledArrInstances(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  arrInstanceId?: string | null,
): Promise<boolean> {
  const scoped = await resolveArrInstanceScope(userId, type, arrInstanceId);
  if (scoped) return scoped.enabled;
  return (await countArrInstances(ARR_FAMILY_FOR_TYPE[type], { userId, enabled: true })) > 0;
}

export interface FetchArrMetadataOptions {
  /**
   * Read Radarr's custom-format scores (`ArrFamilyLoadOptions`). Pass
   * `hasCustomFormatScoreRules(rules)`; defaults to true, the complete answer.
   */
  customFormatScores?: boolean;
}

/** The instance scope as a cache key part: the named instance, or every one. */
async function scopeKey(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  arrInstanceId?: string | null,
): Promise<{ scoped: { id: string } | null; key: string }> {
  const scoped = await resolveArrInstanceScope(userId, type, arrInstanceId);
  return { scoped, key: scoped?.id ?? "*" };
}

async function loadScoped(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  scoped: { id: string } | null,
  onProgress: FractionReporter | undefined,
  options: FetchArrMetadataOptions,
): Promise<ArrDataMap> {
  const family = ARR_FAMILY_FOR_TYPE[type];
  const where = scoped ? { id: scoped.id, userId, enabled: true } : { userId, enabled: true };
  const instances = await findArrInstances(family, where);
  return loadArrFamilyData(family, instances, {
    customFormatScores: options.customFormatScores ?? true,
    onProgress,
  });
}

/**
 * Arr metadata keyed by the family's external id. With `arrInstanceId` naming
 * an instance of the family, only that instance is read (see
 * `resolveArrInstanceScope`); otherwise every enabled instance is, oldest
 * first, and an item on several keeps the OLDEST instance's record — a fixed
 * order, where the unordered query let the answer change from run to run.
 * The instances are read in parallel (`loadArrFamilyData`).
 *
 * Always read fresh: detection and execution decide what to delete from it.
 * The rule editor's previews read through `fetchArrMetadataForPreview`.
 */
export async function fetchArrMetadata(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  onProgress?: FractionReporter,
  arrInstanceId?: string | null,
  options: FetchArrMetadataOptions = {},
): Promise<ArrDataMap> {
  const { scoped } = await scopeKey(userId, type, arrInstanceId);
  return loadScoped(userId, type, scoped, onProgress, options);
}

const ARR_METADATA_CACHE_PREFIX = "arr-metadata:";
// Long enough that the rule editor's preview, diff and Test Media — often
// pressed in a row, each reading the whole Arr library — share one read; short
// enough that a tag changed in the Arr app shows up in the next preview.
const ARR_METADATA_PREVIEW_TTL_MS = 45_000;

/**
 * `fetchArrMetadata` for the rule editor's preview, diff and Test Media: the
 * same answer, shared for `ARR_METADATA_PREVIEW_TTL_MS` (single-flight, so two
 * previews started together read the Arr library once). A preview only shows
 * what detection would do; detection and execution never read this cache.
 *
 * A read with scores serves a later read without them; one without never
 * stands in for one that needs them.
 */
export async function fetchArrMetadataForPreview(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  onProgress?: FractionReporter,
  arrInstanceId?: string | null,
  options: FetchArrMetadataOptions = {},
): Promise<ArrDataMap> {
  const { scoped, key } = await scopeKey(userId, type, arrInstanceId);
  const withScores = options.customFormatScores ?? true;
  const fullKey = `${ARR_METADATA_CACHE_PREFIX}${type}:${key}:scores`;
  if (!withScores) {
    const full = appCache.get<ArrDataMap>(fullKey);
    if (full) {
      onProgress?.(1);
      return full;
    }
  }
  const cacheKey = withScores ? fullKey : `${ARR_METADATA_CACHE_PREFIX}${type}:${key}:base`;
  let computed = false;
  const data = await appCache.getOrSet(
    cacheKey,
    () => {
      computed = true;
      return loadScoped(userId, type, scoped, onProgress, { customFormatScores: withScores });
    },
    ARR_METADATA_PREVIEW_TTL_MS,
  );
  if (!computed) onProgress?.(1);
  return data;
}

/**
 * The Arr data for ONE item, for Test Media: a map holding at most the record
 * `fetchArrMetadataForPreview` would hold under `externalId`. Served from the
 * preview cache when a preview has just read the library; otherwise each
 * instance in scope is asked for that one record (`loadArrRecord`) rather
 * than for its whole library, and — as the library read merges them — the
 * oldest instance holding it answers.
 */
export async function fetchArrRecordForPreview(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  externalId: string,
  arrInstanceId?: string | null,
  options: FetchArrMetadataOptions = {},
): Promise<ArrDataMap> {
  const { scoped, key } = await scopeKey(userId, type, arrInstanceId);
  const withScores = options.customFormatScores ?? true;
  const pick = (map: ArrDataMap): ArrDataMap =>
    externalId in map ? { [externalId]: map[externalId] } : {};
  const cached =
    appCache.get<ArrDataMap>(`${ARR_METADATA_CACHE_PREFIX}${type}:${key}:scores`) ??
    (withScores ? undefined : appCache.get<ArrDataMap>(`${ARR_METADATA_CACHE_PREFIX}${type}:${key}:base`));
  if (cached) return pick(cached);

  const family = ARR_FAMILY_FOR_TYPE[type];
  const where = scoped ? { id: scoped.id, userId, enabled: true } : { userId, enabled: true };
  const instances = await findArrInstances(family, where);
  const records = await Promise.all(
    instances.map((instance) => loadArrRecord(family, instance, externalId, { customFormatScores: withScores })),
  );
  const found = records.find((record) => record !== null);
  return found ? { [externalId]: found } : {};
}

/**
 * Drop every cached preview read. Called whenever an Arr instance is added,
 * edited, enabled, disabled or deleted, and after an execution run changed
 * records in an Arr app (tags, monitoring, quality profiles).
 */
export function invalidateArrMetadataCache(): void {
  appCache.invalidatePrefix(ARR_METADATA_CACHE_PREFIX);
}
