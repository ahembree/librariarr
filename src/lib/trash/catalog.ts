import axios from "axios";
import { appCache } from "@/lib/cache/memory-cache";
import { logger } from "@/lib/logger";
import { configureRetry } from "@/lib/http-retry";
import {
  treeUrl,
  rawUrl,
  servicePaths,
  catalogCacheKey,
  CATALOG_TTL_MS,
  FETCH_CONCURRENCY,
} from "./constants";
import type {
  ServiceType,
  ResourceType,
  TrashCatalog,
  TrashCustomFormat,
  TrashCfGroup,
  TrashQualityProfile,
  TrashQualitySize,
  TrashNaming,
} from "./types";
import { NAMING_TRASH_ID } from "./types";
import { TRASH_REF } from "./constants";

const http = axios.create({
  timeout: 20000,
  // GitHub's API rejects requests without a User-Agent.
  headers: { "User-Agent": "librariarr-trash-sync", Accept: "application/json" },
});
// Retry transient network/5xx blips on these idempotent GETs so a single failed
// file doesn't fail (and un-cache) the whole catalog build unnecessarily.
configureRetry(http, "TrashCatalog", logger);

interface TreeEntry {
  path: string;
  type: string;
}

interface RawCfGroup {
  name?: string;
  trash_id?: string;
  custom_formats?: Array<{ trash_id?: string } | null>;
}

/** Run `worker` over `items` with a bounded number of concurrent tasks. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Fetch one guide file. A failure here THROWS (after the axios-level retries) so
 * the whole catalog build fails and is NOT cached — previously a transient
 * per-file blip was swallowed to `null`, filtered out, and an incomplete catalog
 * was cached for hours, silently dropping managed resources and (for a profile
 * referencing the dropped CF) zeroing its score on the next sync.
 */
async function fetchJson<T>(path: string): Promise<T> {
  try {
    const { data } = await http.get<T>(rawUrl(path));
    return data;
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn("TrashSync", `Failed to fetch guide file ${path}: ${msg}`);
    throw new Error(`Failed to fetch guide file ${path}: ${msg}`);
  }
}

/**
 * Fetch and parse the TRaSH Guides catalog for a service. The whole parsed
 * catalog is cached in-process for hours; pass `force` to bypass the cache
 * (the "Refresh guides" action).
 */
export async function fetchTrashCatalog(
  service: ServiceType,
  opts: { force?: boolean } = {},
): Promise<TrashCatalog> {
  const key = catalogCacheKey(service);
  if (opts.force) appCache.invalidate(key);
  return appCache.getOrSet(key, () => buildCatalog(service), CATALOG_TTL_MS);
}

async function buildCatalog(service: ServiceType): Promise<TrashCatalog> {
  const paths = servicePaths(service);

  const { data: tree } = await http.get<{ tree: TreeEntry[] }>(treeUrl());
  const files = (tree.tree ?? []).filter(
    (e) => e.type === "blob" && e.path.endsWith(".json"),
  );

  const inDir = (prefix: string) =>
    files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path);

  const cfPaths = inDir(paths.customFormats);
  const cfGroupPaths = inDir(paths.cfGroups);
  const qpPaths = inDir(paths.qualityProfiles);
  const qsPaths = inDir(paths.qualitySize);
  const namingPaths = inDir(paths.naming);

  const [cfRaw, cfGroupRaw, qpRaw, qsRaw, namingRaw] = await Promise.all([
    mapConcurrent(cfPaths, FETCH_CONCURRENCY, (p) => fetchJson<TrashCustomFormat>(p)),
    mapConcurrent(cfGroupPaths, FETCH_CONCURRENCY, (p) => fetchJson<RawCfGroup>(p)),
    mapConcurrent(qpPaths, FETCH_CONCURRENCY, (p) => fetchJson<TrashQualityProfile>(p)),
    mapConcurrent(qsPaths, FETCH_CONCURRENCY, (p) => fetchJson<TrashQualitySize>(p)),
    mapConcurrent(namingPaths, FETCH_CONCURRENCY, (p) => fetchJson<TrashNaming>(p)),
  ]);

  const customFormats = cfRaw.filter(
    (c): c is TrashCustomFormat => !!c && !!c.trash_id && Array.isArray(c.specifications),
  );
  const cfGroups: TrashCfGroup[] = cfGroupRaw
    .filter((g): g is RawCfGroup => !!g && !!g.name && Array.isArray(g.custom_formats))
    .map((g) => ({
      name: g.name!,
      trash_id: g.trash_id,
      customFormats: g.custom_formats!
        .map((c) => c?.trash_id)
        .filter((id): id is string => !!id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const qualityProfiles = qpRaw.filter(
    (q): q is TrashQualityProfile => !!q && !!q.trash_id && Array.isArray(q.items),
  );

  // A service has one primary quality-size file (movie / series). Prefer the
  // one whose type matches the service; otherwise take the first valid file.
  const wantType = service === "SONARR" ? "series" : "movie";
  const qsValid = qsRaw.filter((q): q is TrashQualitySize => !!q && Array.isArray(q.qualities));
  const qualitySize = qsValid.find((q) => q.type === wantType) ?? qsValid[0] ?? null;

  const naming = namingRaw.find((n): n is TrashNaming => !!n) ?? null;

  const catalog: TrashCatalog = {
    service,
    ref: TRASH_REF,
    customFormats: customFormats.sort((a, b) => a.name.localeCompare(b.name)),
    cfGroups,
    qualityProfiles: qualityProfiles.sort((a, b) => a.name.localeCompare(b.name)),
    qualitySize,
    naming,
    fetchedAt: new Date().toISOString(),
  };

  logger.info(
    "TrashSync",
    `Loaded ${service} guide catalog: ${catalog.customFormats.length} custom formats, ` +
      `${catalog.qualityProfiles.length} quality profiles, ` +
      `${catalog.qualitySize ? 1 : 0} quality-size, ${catalog.naming ? 1 : 0} naming`,
  );

  return catalog;
}

/**
 * Whether a (resourceType, trashId) pair belongs to a given service's catalog.
 * This is the cross-service gate: a Sonarr custom format's trash_id is not in
 * the Radarr catalog (and vice-versa), so assigning it to the wrong app type is
 * rejected. NAMING uses one synthetic id that is valid for either service (the
 * variants themselves are service-specific and applied by service at sync time).
 */
/**
 * Collapse cf-group names into top-level categories using the `[Bracket]`
 * prefix — e.g. "[Audio] Audio Formats" and "[Audio] Audio Channels" both
 * become the "Audio" category, merging their custom formats. Groups without a
 * bracket keep their full name. Sorted by category name.
 */
export function deriveCategories(cfGroups: TrashCfGroup[]): { name: string; trashIds: string[] }[] {
  const map = new Map<string, Set<string>>();
  for (const g of cfGroups) {
    const match = g.name.match(/^\s*\[([^\]]+)\]/);
    const name = (match ? match[1] : g.name).trim();
    let set = map.get(name);
    if (!set) {
      set = new Set();
      map.set(name, set);
    }
    for (const id of g.customFormats) set.add(id);
  }
  return [...map.entries()]
    .map(([name, ids]) => ({ name, trashIds: [...ids] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function catalogHasResource(
  catalog: TrashCatalog,
  resourceType: ResourceType,
  trashId: string,
): boolean {
  switch (resourceType) {
    case "CUSTOM_FORMAT":
      return catalog.customFormats.some((c) => c.trash_id === trashId);
    case "QUALITY_PROFILE":
      return catalog.qualityProfiles.some((p) => p.trash_id === trashId);
    case "QUALITY_DEFINITION":
      return !!catalog.qualitySize && catalog.qualitySize.trash_id === trashId;
    case "NAMING":
      return !!catalog.naming && trashId === NAMING_TRASH_ID;
    default:
      return false;
  }
}
