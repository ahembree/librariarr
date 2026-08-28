import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let cacheDir: string;

/** Materialise a cache file at the key the cache itself would compute. */
function writeVariant(cacheKey: string) {
  const shardDir = path.join(cacheDir, cacheKey.slice(0, 2), cacheKey.slice(2, 4));
  mkdirSync(shardDir, { recursive: true });
  const fp = path.join(shardDir, `${cacheKey}.webp`);
  writeFileSync(fp, "fake-webp");
  return fp;
}

describe("invalidateCachedUrls", () => {
  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(tmpdir(), "librariarr-imginval-"));
    process.env.IMAGE_CACHE_DIR = cacheDir;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.IMAGE_CACHE_DIR;
  });

  it("removes every width variant of the artwork, not just the default", async () => {
    const { invalidateCachedUrls, computeCacheKey } = await import("@/lib/image-cache/image-cache");
    const { ALL_CACHE_WIDTHS } = await import("@/lib/image-url");

    const url = "/library/metadata/12345/thumb/1706000000";
    const variants = ALL_CACHE_WIDTHS.map((w) => writeVariant(computeCacheKey(url, w)));
    expect(variants.every(existsSync)).toBe(true);

    await invalidateCachedUrls([url]);

    // A variant left behind would keep serving the old artwork for the rest of
    // the TTL: the key comes from the *normalized* URL, so Plex swapping the
    // image behind this path reuses the same key.
    for (const fp of variants) {
      expect(existsSync(fp)).toBe(false);
    }
  });

  it("purges variants written under a different Plex timestamp", async () => {
    const { invalidateCachedUrls, computeCacheKey } = await import("@/lib/image-cache/image-cache");
    const { CACHE_WIDTH_GRID } = await import("@/lib/image-url");

    const cached = writeVariant(computeCacheKey("/library/metadata/99/thumb/1700000000", CACHE_WIDTH_GRID));

    await invalidateCachedUrls(["/library/metadata/99/thumb/1799999999"]);

    expect(existsSync(cached)).toBe(false);
  });

  it("leaves other artwork alone and tolerates null entries", async () => {
    const { invalidateCachedUrls, computeCacheKey } = await import("@/lib/image-cache/image-cache");
    const { CACHE_WIDTH_GRID } = await import("@/lib/image-url");

    const other = writeVariant(computeCacheKey("/library/metadata/777/thumb", CACHE_WIDTH_GRID));

    await invalidateCachedUrls([null, undefined, "/library/metadata/12345/thumb"]);

    expect(existsSync(other)).toBe(true);
  });

  it("does not throw when nothing is cached for the URL", async () => {
    const { invalidateCachedUrls } = await import("@/lib/image-cache/image-cache");
    await expect(invalidateCachedUrls(["/library/metadata/404/thumb"])).resolves.toBeUndefined();
  });
});
