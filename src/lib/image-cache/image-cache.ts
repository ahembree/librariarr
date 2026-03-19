import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { createHash } from "crypto";
import sharp from "sharp";
import { logger } from "@/lib/logger";

const IMAGE_CACHE_DIR = process.env.IMAGE_CACHE_DIR || "/config/cache/images";
const STATS_FILE = path.join(IMAGE_CACHE_DIR, "_stats.json");
const CACHE_WIDTH_DEFAULT = 800;
export const CACHE_WIDTH_ART = 1920;
const CACHE_QUALITY = 80;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Disable Sharp's internal operation cache for memory safety in long-running processes
sharp.cache(false);

// In-flight request deduplication: cacheKey -> Promise<Buffer>
const inFlight = new Map<string, Promise<Buffer>>();

// Serialize stats file updates to prevent read-modify-write races
let statsLock: Promise<void> = Promise.resolve();

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
  return path.join(IMAGE_CACHE_DIR, shard1, shard2, `${cacheKey}.webp`);
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
  statsLock = statsLock.then(async () => {
    const s = await readStatsFile();
    fn(s);
    if (s.fileCount < 0) s.fileCount = 0;
    if (s.totalSize < 0) s.totalSize = 0;
    await writeStatsFile(s);
  }).catch(() => {});
}

/** Walk the cache directory tree to compute stats from scratch. */
async function scanCacheStats(): Promise<{ fileCount: number; totalSize: number }> {
  let fileCount = 0;
  let totalSize = 0;

  try {
    await ensureCacheDir();
    const shard1Entries = await fs.readdir(IMAGE_CACHE_DIR, { withFileTypes: true });

    await Promise.all(
      shard1Entries
        .filter((e) => e.isDirectory())
        .map(async (s1) => {
          const s1Path = path.join(IMAGE_CACHE_DIR, s1.name);
          const shard2Entries = await fs.readdir(s1Path, { withFileTypes: true });

          await Promise.all(
            shard2Entries
              .filter((e) => e.isDirectory())
              .map(async (s2) => {
                const s2Path = path.join(s1Path, s2.name);
                const files = await fs.readdir(s2Path, { withFileTypes: true });
                const webpFiles = files.filter((f) => f.isFile() && f.name.endsWith(".webp"));

                const fileSizes = await Promise.all(
                  webpFiles.map((f) => fs.stat(path.join(s2Path, f.name)).then((st) => st.size)),
                );

                for (const size of fileSizes) {
                  fileCount++;
                  totalSize += size;
                }
              }),
          );
        }),
    );
  } catch {
    // Directory doesn't exist yet
  }

  return { fileCount, totalSize };
}

/** Compute the cache key for a given thumb URL path and optional max width. */
export function computeCacheKey(thumbPath: string, maxWidth?: number): string {
  const mw = maxWidth ?? CACHE_WIDTH_DEFAULT;
  const normalized = normalizeCacheUrl(thumbPath);
  return getCacheKey(mw === CACHE_WIDTH_DEFAULT ? normalized : `${normalized}@${mw}`);
}

export interface CachedImageInfo {
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
  thumbPath: string,
  options?: { maxWidth?: number },
): Promise<CachedImageInfo | null> {
  const cacheKey = computeCacheKey(thumbPath, options?.maxWidth);
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
 * Cache an image by its thumb URL path. Items sharing the same artwork URL
 * (e.g. all episodes of a series) share a single cached file.
 */
export async function cacheImage(
  thumbPath: string,
  fetchFn: () => Promise<{ data: Buffer; contentType: string }>,
  options?: { maxWidth?: number },
): Promise<{ data: Buffer; contentType: string; cacheKey: string }> {
  const maxWidth = options?.maxWidth ?? CACHE_WIDTH_DEFAULT;
  const cacheKey = computeCacheKey(thumbPath, maxWidth);
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
 * Invalidate cached images for the given thumb URL paths.
 * Null/undefined values are silently skipped.
 */
export async function invalidateCachedUrls(urls: (string | null | undefined)[]): Promise<void> {
  for (const url of urls) {
    if (!url) continue;
    const cacheKey = getCacheKey(normalizeCacheUrl(url));
    const cachePath = getCachePath(cacheKey);
    try {
      const fileStat = await fs.stat(cachePath);
      await fs.unlink(cachePath);
      const fileSize = fileStat.size;
      updateStats((s) => {
        s.fileCount--;
        s.totalSize -= fileSize;
      });
    } catch {
      // File doesn't exist, that's fine
    }
  }
}

/**
 * Clear all cached images. Removes contents of the cache directory
 * without removing the directory itself (which may be a Docker volume mount).
 */
export async function clearImageCache(): Promise<void> {
  try {
    const entries = await fs.readdir(IMAGE_CACHE_DIR);
    await Promise.all(
      entries
        .filter((entry) => entry !== "_stats.json")
        .map((entry) =>
          fs.rm(path.join(IMAGE_CACHE_DIR, entry), { recursive: true, force: true }),
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
