import axios from "axios";
import { appCache } from "@/lib/cache/memory-cache";
import { logger } from "@/lib/logger";
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
  TrashCatalog,
  TrashCustomFormat,
  TrashQualityProfile,
  TrashQualitySize,
  TrashNaming,
} from "./types";
import { TRASH_REF } from "./constants";

const http = axios.create({
  timeout: 20000,
  // GitHub's API rejects requests without a User-Agent.
  headers: { "User-Agent": "librariarr-trash-sync", Accept: "application/json" },
});

interface TreeEntry {
  path: string;
  type: string;
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

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const { data } = await http.get<T>(rawUrl(path));
    return data;
  } catch (err) {
    logger.warn("TrashSync", `Failed to fetch guide file ${path}: ${(err as Error).message}`);
    return null;
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
  const qpPaths = inDir(paths.qualityProfiles);
  const qsPaths = inDir(paths.qualitySize);
  const namingPaths = inDir(paths.naming);

  const [cfRaw, qpRaw, qsRaw, namingRaw] = await Promise.all([
    mapConcurrent(cfPaths, FETCH_CONCURRENCY, (p) => fetchJson<TrashCustomFormat>(p)),
    mapConcurrent(qpPaths, FETCH_CONCURRENCY, (p) => fetchJson<TrashQualityProfile>(p)),
    mapConcurrent(qsPaths, FETCH_CONCURRENCY, (p) => fetchJson<TrashQualitySize>(p)),
    mapConcurrent(namingPaths, FETCH_CONCURRENCY, (p) => fetchJson<TrashNaming>(p)),
  ]);

  const customFormats = cfRaw.filter(
    (c): c is TrashCustomFormat => !!c && !!c.trash_id && Array.isArray(c.specifications),
  );
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
