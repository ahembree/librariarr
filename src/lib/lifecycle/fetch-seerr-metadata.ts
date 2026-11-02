import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { walkSeerrRequests } from "@/lib/seerr/request-walk";
import { SeerrDataMapBuilder } from "@/lib/seerr/seerr-data-map";
import { splitProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { SeerrDataMap } from "@/lib/rules/lifecycle-engine";

type SeerrMediaType = "MOVIE" | "SERIES";

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

interface SeerrWalkOptions {
  onProgress?: FractionReporter;
  /** First page without transport retries — for a caller someone waits on. */
  failFast?: boolean;
}

/**
 * The Seerr data maps for `types`, merged across every enabled instance. One
 * walk per instance covers every type asked for: with a single type the
 * server-side `mediaType` filter applies; with both, requests are routed by
 * their own `type` — the same rows two filtered walks would read, in one pass
 * (a server that ignores the filter would otherwise hand over the whole list
 * twice).
 *
 * Instances are walked in parallel, each into its own builders, and folded in
 * instance order (oldest first), so the merged maps are exactly what walking
 * them one after another produced.
 */
export async function fetchSeerrMetadataByType(
  userId: string,
  types: SeerrMediaType[],
  options: SeerrWalkOptions = {},
): Promise<Partial<Record<SeerrMediaType, SeerrDataMap>>> {
  if (types.length === 0) return {};
  return walkSeerrInstances(await loadEnabledSeerrInstances(userId), types, options);
}

/** The user's enabled Seerr instances, oldest first — the order maps are merged in. */
export function loadEnabledSeerrInstances(userId: string) {
  return prisma.seerrInstance.findMany({
    where: { userId, enabled: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** `fetchSeerrMetadataByType` over instances the caller already loaded. */
export async function walkSeerrInstances(
  instances: Array<{ name: string; url: string; apiKey: string }>,
  types: SeerrMediaType[],
  options: SeerrWalkOptions = {},
): Promise<Partial<Record<SeerrMediaType, SeerrDataMap>>> {
  const wanted = [...new Set(types)];
  if (wanted.length === 0) return {};
  const onlyType = wanted.length === 1 ? wanted[0] : undefined;
  const reporters = splitProgress(options.onProgress, instances.length);
  const perInstance = await Promise.all(
    instances.map(async (inst, idx) => {
      const builders = new Map(wanted.map((t) => [t, new SeerrDataMapBuilder(t)] as const));
      await walkSeerrRequests(
        new SeerrClient(inst.url, inst.apiKey),
        {
          instanceName: inst.name,
          mediaType: onlyType ? (onlyType === "MOVIE" ? "movie" : "tv") : undefined,
          onProgress: reporters[idx],
          ...(options.failFast ? { failFast: true } : {}),
        },
        (req) => {
          const type = req.type === "movie" ? "MOVIE" : req.type === "tv" ? "SERIES" : null;
          if (type) builders.get(type)?.add(req);
        },
      );
      return builders;
    }),
  );

  const result: Partial<Record<SeerrMediaType, SeerrDataMap>> = {};
  for (const type of wanted) {
    const merged = new SeerrDataMapBuilder(type);
    for (const builders of perInstance) merged.absorb(builders.get(type)!);
    result[type] = merged.build();
  }
  return result;
}

export async function fetchSeerrMetadata(
  userId: string,
  type: SeerrMediaType,
  onProgress?: FractionReporter,
): Promise<SeerrDataMap> {
  return (await fetchSeerrMetadataByType(userId, [type], { onProgress }))[type]!;
}

const SEERR_METADATA_CACHE_PREFIX = "seerr-metadata:";
// See ARR_METADATA_PREVIEW_TTL_MS: shared by the editor's preview, diff and
// Test Media pressed in a row, never by detection or execution.
const SEERR_METADATA_PREVIEW_TTL_MS = 45_000;

/**
 * `fetchSeerrMetadata` for the rule editor's preview, diff and Test Media,
 * shared for `SEERR_METADATA_PREVIEW_TTL_MS` (single-flight). Dropped by
 * `invalidateSeerrCaches()`, which every Seerr instance write calls.
 */
export async function fetchSeerrMetadataForPreview(
  userId: string,
  type: SeerrMediaType,
  onProgress?: FractionReporter,
): Promise<SeerrDataMap> {
  let computed = false;
  const data = await appCache.getOrSet(
    `${SEERR_METADATA_CACHE_PREFIX}${type}`,
    () => {
      computed = true;
      return fetchSeerrMetadata(userId, type, onProgress);
    },
    SEERR_METADATA_PREVIEW_TTL_MS,
  );
  if (!computed) onProgress?.(1);
  return data;
}

export function invalidateSeerrMetadataCache(): void {
  appCache.invalidatePrefix(SEERR_METADATA_CACHE_PREFIX);
}
