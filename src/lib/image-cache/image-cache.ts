import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { createHash } from "crypto";
import sharp from "sharp";
import { logger } from "@/lib/logger";
import { ALL_CACHE_WIDTHS, CACHE_WIDTH_DEFAULT } from "@/lib/image-url";
import { mapWithConcurrency } from "@/lib/media-server/concurrency";

// Runtime data directory: env-resolved and outside the project (under /config in
// the container), so Turbopack's build-time tracer cannot resolve it statically and
// falls back to tracing the WHOLE project into the standalone output ("Dynamic
// filesystem access causes tracing of the whole project"). Nothing here is a build
// input, so every fs/path call it flags carries `/* turbopackIgnore: true */`.
const IMAGE_CACHE_DIR = process.env.IMAGE_CACHE_DIR || "/config/cache/images";
const STATS_FILE = path.join(IMAGE_CACHE_DIR, "_stats.json");
const CACHE_QUALITY = 80;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Disable Sharp's internal operation cache for memory safety in long-running processes
sharp.cache(false);
// libvips defaults its thread pool to the core count, so a burst of concurrent
// cache misses could otherwise occupy every core of a small NAS and starve live
// browsing. Inputs are server-resized (see fetchImage), so one thread is plenty.
sharp.concurrency(1);

// Pinned to globalThis: the sync in the job worker (started from
// instrumentation) invalidates files and the artwork routes add them, and a
// production build gives each its own copy of this module. With a lock per
// copy their read-modify-write updates of _stats.json interleaved and lost
// counts.
const globalForImageCache = globalThis as unknown as {
  imageCacheState: { inFlight: Map<string, Promise<Buffer>>; statsLock: Promise<void> } | undefined;
};
const state = (globalForImageCache.imageCacheState ??= {
  // In-flight request deduplication: cacheKey -> Promise<Buffer>
  inFlight: new Map<string, Promise<Buffer>>(),
  // Serializes stats file updates to prevent read-modify-write races
  statsLock: Promise.resolve(),
});
const inFlight = state.inFlight;

class SharpFailedError extends Error {
  constructor(
    public originalData: Buffer,
    public originalContentType: string,
  ) {
    super("Sharp optimization failed");
  }
}

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
}

/**
 * Normalize Plex-style thumb/art URLs by stripping the trailing timestamp segment.
 * Plex URLs like `/library/metadata/12345/thumb/1706000000` become `/library/metadata/12345/thumb`.
 * Jellyfin/Emby URLs and external URLs pass through unchanged.
 */
export function normalizeCacheUrl(url: string): string {
  return url.replace(/^(\/library\/metadata\/\d+\/(?:thumb|art))\/\d+$/, "$1");
}

function getCacheKey(thumbPath: string): string {
  return createHash("sha256").update(thumbPath).digest("hex");
}

function getCachePath(cacheKey: string): string {
  const shard1 = cacheKey.slice(0, 2);
  const shard2 = cacheKey.slice(2, 4);
  return path.join(/* turbopackIgnore: true */ IMAGE_CACHE_DIR, shard1, shard2, `${cacheKey}.webp`);
}

async function optimizeImage(buffer: Buffer, maxWidth: number = CACHE_WIDTH_DEFAULT): Promise<Buffer | null> {
  try {
    return await sharp(buffer)
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality: CACHE_QUALITY })
      .toBuffer();
  } catch (error) {
    logger.warn("ImageCache", "Sharp optimization failed, falling back to original", {
      error: String(error),
    });
    return null;
  }
}

// --- Stats file helpers ---

async function readStatsFile(): Promise<{ fileCount: number; totalSize: number }> {
  try {
    const raw = await fs.readFile(STATS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { fileCount: 0, totalSize: 0 };
  }
}

async function writeStatsFile(s: { fileCount: number; totalSize: number }): Promise<void> {
  await ensureCacheDir();
  await fs.writeFile(STATS_FILE, JSON.stringify(s));
}

/** Fire-and-forget stats update, serialized via lock to prevent races. */
function updateStats(fn: (s: { fileCount: number; totalSize: number }) => void): void {
  state.statsLock = state.statsLock.then(async () => {
    const s = await readStatsFile();
    fn(s);
    if (s.fileCount < 0) s.fileCount = 0;
    if (s.totalSize < 0) s.totalSize = 0;
    await writeStatsFile(s);
  }).catch(() => {});
}

/**
 * How many filesystem operations a cache-wide pass keeps in flight. The walks
 * below used to fan out over every leaf directory and every file at once — up
 * to 65,536 leaves — which flooded the libuv threadpool the artwork routes'
 * own reads queue on, and opened a handle per entry in one burst.
 */
const FILE_OP_CONCURRENCY = 8;

/**
 * Visit every cached `.webp` file with its stat, a bounded number of leaf
 * directories at a time. A file or directory that vanishes mid-walk (a clear,
 * an invalidation) is skipped.
 */
async function forEachCachedFile(
  visit: (filePath: string, stat: { size: number; mtimeMs: number }) => Promise<void> | void,
): Promise<void> {
  await ensureCacheDir();
  const shard1Entries = await fs.readdir(/* turbopackIgnore: true */ IMAGE_CACHE_DIR, { withFileTypes: true });
  const leafDirs: string[] = [];
  for (const s1 of shard1Entries) {
    if (!s1.isDirectory()) continue;
    const s1Path = path.join(/* turbopackIgnore: true */ IMAGE_CACHE_DIR, s1.name);
    let shard2Entries;
    try {
      shard2Entries = await fs.readdir(/* turbopackIgnore: true */ s1Path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s2 of shard2Entries) {
      if (s2.isDirectory()) leafDirs.push(path.join(/* turbopackIgnore: true */ s1Path, s2.name));
    }
  }

  await mapWithConcurrency(leafDirs, FILE_OP_CONCURRENCY, async (leafDir) => {
    let files;
    try {
      files = await fs.readdir(/* turbopackIgnore: true */ leafDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".webp")) continue;
      const filePath = path.join(/* turbopackIgnore: true */ leafDir, f.name);
      let st;
      try {
        st = await fs.stat(/* turbopackIgnore: true */ filePath);
      } catch {
        continue;
      }
      await visit(filePath, st);
    }
  });
}

/** Walk the cache directory tree to compute stats from scratch. */
async function scanCacheStats(): Promise<{ fileCount: number; totalSize: number }> {
  let fileCount = 0;
  let totalSize = 0;

  try {
    await forEachCachedFile((_filePath, st) => {
      fileCount++;
      totalSize += st.size;
    });
  } catch {
    // Directory doesn't exist yet
  }

  return { fileCount, totalSize };
}

/**
 * Compute the cache key for a thumb URL path and optional max width, within
 * `scope` — the id of the library the artwork belongs to.
 *
 * The scope is not decoration: an artwork path only means something to the
 * server that issued it. Plex rating keys (and Emby item ids) are per-server
 * row ids, so two Plex servers both hold a `/library/metadata/1234/thumb` for
 * unrelated items, and keyed by the path alone whichever was fetched first was
 * served for the other for the whole TTL. A library belongs to exactly one
 * server and an item's artwork (its own, its season's, its show's or artist's)
 * lives in the item's own library, so the library id separates servers without
 * splitting artwork the items of one library share.
 */
export function computeCacheKey(scope: string, thumbPath: string, maxWidth?: number): string {
  const mw = maxWidth ?? CACHE_WIDTH_DEFAULT;
  const scoped = `${scope}:${normalizeCacheUrl(thumbPath)}`;
  return getCacheKey(mw === CACHE_WIDTH_DEFAULT ? scoped : `${scoped}@${mw}`);
}

interface CachedImageInfo {
  /** Cache key usable as an ETag */
  cacheKey: string;
  /** Absolute path to the cached file */
  filePath: string;
  /** File size in bytes */
  size: number;
  /** File modification time (ms since epoch) */
  mtimeMs: number;
}

/**
 * Check if a cached image exists and is still valid (within TTL).
 * Returns metadata for ETag/304 checks and streaming without reading the file into memory.
 */
export async function getCachedImageInfo(
  scope: string,
  thumbPath: string,
  options?: { maxWidth?: number },
): Promise<CachedImageInfo | null> {
  const cacheKey = computeCacheKey(scope, thumbPath, options?.maxWidth);
  const cachePath = getCachePath(cacheKey);
  try {
    const stat = await fs.stat(cachePath);
    if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS) {
      return { cacheKey, filePath: cachePath, size: stat.size, mtimeMs: stat.mtimeMs };
    }
    return null; // expired
  } catch {
    return null; // not cached
  }
}

/**
 * Create a ReadableStream from a cached file for zero-copy response streaming.
 */
export function streamCachedImage(filePath: string): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(filePath);
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

/**
 * Cache an image by its thumb URL path within `scope` (see `computeCacheKey`).
 * Items of one library sharing the same artwork URL (e.g. all episodes of a
 * series) share a single cached file.
 */
export async function cacheImage(
  scope: string,
  thumbPath: string,
  fetchFn: () => Promise<{ data: Buffer; contentType: string }>,
  options?: { maxWidth?: number },
): Promise<{ data: Buffer; contentType: string; cacheKey: string }> {
  const maxWidth = options?.maxWidth ?? CACHE_WIDTH_DEFAULT;
  const cacheKey = computeCacheKey(scope, thumbPath, maxWidth);
  const cachePath = getCachePath(cacheKey);

  // 1. Try disk cache (with TTL — re-fetch if older than CACHE_MAX_AGE_MS)
  let expiredFileSize: number | null = null;
  try {
    const stat = await fs.stat(cachePath);
    if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS) {
      const cached = await fs.readFile(cachePath);
      return { data: cached, contentType: "image/webp", cacheKey };
    }
    // Cache entry expired — fall through to re-fetch
    expiredFileSize = stat.size;
  } catch {
    // Not cached
  }

  // 2. Deduplicate concurrent requests
  const existing = inFlight.get(cacheKey);
  if (existing) {
    const data = await existing;
    return { data, contentType: "image/webp", cacheKey };
  }

  // 3. Fetch, optimize, store
  const promise = (async (): Promise<Buffer> => {
    const image = await fetchFn();
    const optimized = await optimizeImage(image.data, maxWidth);

    if (optimized) {
      const dir = path.dirname(cachePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(cachePath, optimized);

      if (expiredFileSize !== null) {
        // Overwriting an expired cache file — adjust size only, not count
        const sizeDiff = optimized.length - expiredFileSize;
        if (sizeDiff !== 0) updateStats((s) => { s.totalSize += sizeDiff; });
      } else {
        updateStats((s) => {
          s.fileCount++;
          s.totalSize += optimized.length;
        });
      }

      return optimized;
    }

    // Sharp failed — serve original but don't cache
    throw new SharpFailedError(image.data, image.contentType);
  })();

  inFlight.set(cacheKey, promise);

  try {
    const data = await promise;
    return { data, contentType: "image/webp", cacheKey };
  } catch (error) {
    if (error instanceof SharpFailedError) {
      return { data: error.originalData, contentType: error.originalContentType, cacheKey };
    }
    throw error;
  } finally {
    inFlight.delete(cacheKey);
  }
}

/**
 * Invalidate cached images for the given thumb URL paths of one library
 * (`scope`, the id `cacheImage` was given — see `computeCacheKey`). Scoped so a
 * sync of one server cannot purge another server's artwork at the same path.
 * Null/undefined values are silently skipped.
 */
export async function invalidateCachedUrls(
  scope: string,
  urls: (string | null | undefined)[],
): Promise<void> {
  // One file per distinct artwork and width. Episodes of a show share their
  // season's and show's artwork, so a batch of them names the same URL many
  // times over (and the key normalizes the URL, so two spellings of one
  // artwork are one file too).
  const cachePaths = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    // Every width variant of this artwork has to go, not just the default one.
    // Callers invalidate when an item's artwork URL changed or the item was
    // deleted; leaving the 400/640/1920 variants behind would orphan up to
    // three files per item on disk and skew the cache-stats counters, and the
    // grid would keep serving the old artwork from its own width until the TTL
    // expired even though the default-width file was purged.
    for (const width of ALL_CACHE_WIDTHS) {
      cachePaths.add(getCachePath(computeCacheKey(scope, url, width)));
    }
  }
  if (cachePaths.size === 0) return;

  let removedCount = 0;
  let removedBytes = 0;
  await mapWithConcurrency([...cachePaths], FILE_OP_CONCURRENCY, async (cachePath) => {
    try {
      const fileStat = await fs.stat(cachePath);
      await fs.unlink(cachePath);
      removedCount++;
      removedBytes += fileStat.size;
    } catch {
      // File doesn't exist, that's fine
    }
  });

  // One stats write for the whole call: each update is a read-modify-write of
  // `_stats.json`, and a purge of a few hundred items used to queue one per
  // deleted file.
  if (removedCount > 0) {
    updateStats((s) => {
      s.fileCount -= removedCount;
      s.totalSize -= removedBytes;
    });
  }
}

/**
 * Clear all cached images. Removes contents of the cache directory
 * without removing the directory itself (which may be a Docker volume mount).
 */
export async function clearImageCache(): Promise<void> {
  try {
    const entries = await fs.readdir(/* turbopackIgnore: true */ IMAGE_CACHE_DIR);
    await Promise.all(
      entries
        .filter((entry) => entry !== "_stats.json")
        .map((entry) =>
          fs.rm(path.join(/* turbopackIgnore: true */ IMAGE_CACHE_DIR, entry), { recursive: true, force: true }),
        ),
    );
    await writeStatsFile({ fileCount: 0, totalSize: 0 });
    logger.info("ImageCache", "Image cache cleared");
  } catch (error) {
    logger.error("ImageCache", "Failed to clear image cache", { error: String(error) });
    throw error;
  }
}

/**
 * Get image cache statistics. Reads from a persistent _stats.json file.
 * If the file doesn't exist (first run or after manual deletion),
 * performs a one-time directory scan to bootstrap it.
 */
export async function getImageCacheStats(): Promise<{ fileCount: number; totalSize: number }> {
  try {
    await fs.access(STATS_FILE);
    return await readStatsFile();
  } catch {
    // Stats file doesn't exist — bootstrap from directory scan
    const s = await scanCacheStats();
    await writeStatsFile(s);
    return s;
  }
}

/**
 * Delete cached images whose mtime is older than CACHE_MAX_AGE_MS and reconcile
 * the stats file from disk truth. TTL was previously enforced only lazily on
 * read, so `.webp` files for media that is no longer requested accumulated
 * forever (unbounded disk growth) and the stats counters only ever grew. Meant
 * to run periodically (daily cron). Returns the number of files removed.
 */
export async function pruneImageCache(): Promise<{ removed: number }> {
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  let removed = 0;
  // What is left on disk, counted in the same pass as the deletions. The prune
  // used to re-walk the whole tree afterwards just to count it again.
  let keptCount = 0;
  let keptBytes = 0;
  try {
    await forEachCachedFile(async (filePath, st) => {
      if (st.mtimeMs >= cutoff) {
        keptCount++;
        keptBytes += st.size;
        return;
      }
      try {
        await fs.unlink(/* turbopackIgnore: true */ filePath);
        removed++;
      } catch {
        // File vanished concurrently — ignore.
      }
    });

    if (removed > 0) {
      // Reconcile the counters from disk truth (avoids long-term drift).
      // Through the stats lock, so the write cannot interleave with an update
      // a request queued meanwhile.
      updateStats((s) => {
        s.fileCount = keptCount;
        s.totalSize = keptBytes;
      });
      await state.statsLock;
      logger.info("ImageCache", `Pruned ${removed} expired cached image(s)`);
    }
  } catch (error) {
    logger.error("ImageCache", "Failed to prune image cache", { error: String(error) });
  }
  return { removed };
}
