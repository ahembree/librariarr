import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let cacheDir: string;

/** The library the artwork belongs to — the cache's scope (see computeCacheKey). */
const LIB = "lib-a";

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
    vi.stubEnv("IMAGE_CACHE_DIR", cacheDir);
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("removes every width variant of the artwork, not just the default", async () => {
    const { invalidateCachedUrls, computeCacheKey } = await import("@/lib/image-cache/image-cache");
    const { ALL_CACHE_WIDTHS } = await import("@/lib/image-url");

    const url = "/library/metadata/12345/thumb/1706000000";
    const variants = ALL_CACHE_WIDTHS.map((w) => writeVariant(computeCacheKey(LIB, url, w)));
    expect(variants.every(existsSync)).toBe(true);

    await invalidateCachedUrls(LIB, [url]);

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

    const cached = writeVariant(computeCacheKey(LIB, "/library/metadata/99/thumb/1700000000", CACHE_WIDTH_GRID));

    await invalidateCachedUrls(LIB, ["/library/metadata/99/thumb/1799999999"]);

    expect(existsSync(cached)).toBe(false);
  });

  it("leaves other artwork alone and tolerates null entries", async () => {
    const { invalidateCachedUrls, computeCacheKey } = await import("@/lib/image-cache/image-cache");
    const { CACHE_WIDTH_GRID } = await import("@/lib/image-url");

    const other = writeVariant(computeCacheKey(LIB, "/library/metadata/777/thumb", CACHE_WIDTH_GRID));
    const target = writeVariant(computeCacheKey(LIB, "/library/metadata/12345/thumb", CACHE_WIDTH_GRID));

    await invalidateCachedUrls(LIB, [null, undefined, "/library/metadata/12345/thumb"]);

    expect(existsSync(target)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("does not throw when nothing is cached for the URL", async () => {
    const { invalidateCachedUrls } = await import("@/lib/image-cache/image-cache");
    await expect(invalidateCachedUrls(LIB, ["/library/metadata/404/thumb"])).resolves.toBeUndefined();
  });

  it("leaves the same path cached for another library (another server) alone", async () => {
    const { invalidateCachedUrls, computeCacheKey } = await import("@/lib/image-cache/image-cache");
    const { CACHE_WIDTH_GRID } = await import("@/lib/image-url");

    // Plex rating keys are per-server, so another server's item can hold the
    // very same path. A sync of this library must not purge that one's art.
    const url = "/library/metadata/1234/thumb/1700000000";
    const mine = writeVariant(computeCacheKey(LIB, url, CACHE_WIDTH_GRID));
    const theirs = writeVariant(computeCacheKey("lib-on-other-server", url, CACHE_WIDTH_GRID));

    await invalidateCachedUrls(LIB, [url]);

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });
});
