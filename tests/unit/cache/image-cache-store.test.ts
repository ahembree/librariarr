import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

// The cache's whole store path on a real temp directory with real sharp:
// miss → resize → write → stats, hit, TTL expiry, in-flight dedup, the
// sharp-failure fallback, streaming, clearing, stats bootstrap and pruning.

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type ImageCache = typeof import("@/lib/image-cache/image-cache");

let cacheDir: string;
let ic: ImageCache;
const LIB = "lib-1";
const EIGHT_DAYS_AGO = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;

async function png(width = 50, height = 30): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
}

function statsOnDisk(): { fileCount: number; totalSize: number } | null {
  const fp = path.join(cacheDir, "_stats.json");
  return existsSync(fp) ? JSON.parse(readFileSync(fp, "utf-8")) : null;
}

function fileFor(key: string): string {
  return path.join(cacheDir, key.slice(0, 2), key.slice(2, 4), `${key}.webp`);
}

beforeEach(async () => {
  cacheDir = mkdtempSync(path.join(tmpdir(), "librariarr-imgstore-"));
  vi.stubEnv("IMAGE_CACHE_DIR", cacheDir);
  vi.resetModules();
  // The module pins its state to globalThis; start every test with a fresh one.
  delete (globalThis as Record<string, unknown>).imageCacheState;
  ic = await import("@/lib/image-cache/image-cache");
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("cacheImage", () => {
  it("resizes a miss to WebP within the width, stores it and counts it", async () => {
    const source = await png(1200, 600);
    const fetchFn = vi.fn(async () => ({ data: source, contentType: "image/png" }));

    const first = await ic.cacheImage(LIB, "/library/metadata/1/thumb/111", fetchFn, { maxWidth: 400 });
    expect(first.contentType).toBe("image/webp");
    const meta = await sharp(first.data).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(400);
    expect(existsSync(fileFor(first.cacheKey))).toBe(true);
    await vi.waitFor(() => expect(statsOnDisk()).toEqual({ fileCount: 1, totalSize: first.data.length }));

    // A different Plex timestamp is the same artwork → served from disk.
    const second = await ic.cacheImage(LIB, "/library/metadata/1/thumb/222", fetchFn, { maxWidth: 400 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(second.data.equals(first.data)).toBe(true);
  });

  it("re-fetches an expired entry and adjusts only the size in the stats", async () => {
    const fetchFn = vi.fn(async () => ({ data: await png(), contentType: "image/png" }));
    const { cacheKey, data } = await ic.cacheImage(LIB, "/a", fetchFn);
    await vi.waitFor(() => expect(statsOnDisk()?.fileCount).toBe(1));

    // Age the file past the TTL and pad it so the overwrite changes the size.
    const fp = fileFor(cacheKey);
    writeFileSync(fp, Buffer.concat([data, Buffer.alloc(10)]));
    utimesSync(fp, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO);
    expect(await ic.getCachedImageInfo(LIB, "/a")).toBeNull();

    await ic.cacheImage(LIB, "/a", fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // The padded file was 10 bytes larger than the new one: count unchanged, size -10.
    await vi.waitFor(() => expect(statsOnDisk()).toEqual({ fileCount: 1, totalSize: data.length - 10 }));
    expect(await ic.getCachedImageInfo(LIB, "/a")).not.toBeNull();
  });

  it("leaves the stats alone when an expired entry is replaced by one of the same size", async () => {
    const fetchFn = vi.fn(async () => ({ data: await png(), contentType: "image/png" }));
    const { cacheKey } = await ic.cacheImage(LIB, "/same", fetchFn);
    await vi.waitFor(() => expect(statsOnDisk()?.fileCount).toBe(1));
    const before = statsOnDisk();
    utimesSync(fileFor(cacheKey), EIGHT_DAYS_AGO, EIGHT_DAYS_AGO);
    await ic.cacheImage(LIB, "/same", fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Stats updates are queued one after another, so once a later miss has been
    // counted, any update the replacement queued has landed too.
    const other = await ic.cacheImage(LIB, "/other", async () => ({ data: await png(70, 40), contentType: "image/png" }));
    await vi.waitFor(() => expect(statsOnDisk()?.fileCount).toBe(2));
    expect(statsOnDisk()).toEqual({ fileCount: 2, totalSize: before!.totalSize + other.data.length });
  });

  it("shares one fetch between concurrent misses for the same key", async () => {
    const source = await png();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = vi.fn(async () => {
      await gate;
      return { data: source, contentType: "image/png" };
    });
    const a = ic.cacheImage(LIB, "/dup", fetchFn);
    const b = ic.cacheImage(LIB, "/dup", fetchFn);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(ra.data.equals(rb.data)).toBe(true);
  });

  it("serves the original bytes, uncached, when sharp cannot decode them", async () => {
    const bogus = Buffer.from("<svg not really>");
    const res = await ic.cacheImage(LIB, "/bad", async () => ({ data: bogus, contentType: "text/html" }));
    expect(res.data).toEqual(bogus);
    expect(res.contentType).toBe("text/html");
    expect(existsSync(fileFor(res.cacheKey))).toBe(false);
    const { logger } = await import("@/lib/logger");
    expect(logger.warn).toHaveBeenCalledWith("ImageCache", expect.stringContaining("Sharp optimization failed"), expect.any(Object));
  });

  it("propagates a fetch failure and does not leave it in flight", async () => {
    const failing = vi.fn(async () => {
      throw new Error("server down");
    });
    await expect(ic.cacheImage(LIB, "/err", failing)).rejects.toThrow("server down");
    const ok = vi.fn(async () => ({ data: await png(), contentType: "image/png" }));
    await expect(ic.cacheImage(LIB, "/err", ok)).resolves.toMatchObject({ contentType: "image/webp" });
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("getCachedImageInfo / streamCachedImage", () => {
  it("returns the file's metadata and streams its bytes", async () => {
    const { cacheKey, data } = await ic.cacheImage(LIB, "/s", async () => ({ data: await png(), contentType: "image/png" }), {
      maxWidth: 640,
    });
    const info = await ic.getCachedImageInfo(LIB, "/s", { maxWidth: 640 });
    expect(info).toMatchObject({ cacheKey, filePath: fileFor(cacheKey), size: data.length });

    const chunks: Uint8Array[] = [];
    const reader = ic.streamCachedImage(info!.filePath).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });

  it("returns null for an uncached key", async () => {
    expect(await ic.getCachedImageInfo(LIB, "/nothing")).toBeNull();
  });

  it("errors the stream when the file cannot be read, and can be cancelled", async () => {
    const reader = ic.streamCachedImage(path.join(cacheDir, "missing.webp")).getReader();
    await expect(reader.read()).rejects.toThrow(/ENOENT/);

    const fp = path.join(cacheDir, "x.webp");
    writeFileSync(fp, "abc");
    const stream = ic.streamCachedImage(fp);
    await expect(stream.cancel()).resolves.toBeUndefined();
  });
});

describe("clearImageCache", () => {
  it("removes every shard but keeps the directory, and resets the stats", async () => {
    await ic.cacheImage(LIB, "/c", async () => ({ data: await png(), contentType: "image/png" }));
    await vi.waitFor(() => expect(statsOnDisk()?.fileCount).toBe(1));
    await ic.clearImageCache();
    expect(existsSync(cacheDir)).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(cacheDir)).toEqual(["_stats.json"]);
    expect(statsOnDisk()).toEqual({ fileCount: 0, totalSize: 0 });
  });

  it("logs and rethrows when the cache directory cannot be read", async () => {
    rmSync(cacheDir, { recursive: true, force: true });
    await expect(ic.clearImageCache()).rejects.toThrow(/ENOENT/);
    const { logger } = await import("@/lib/logger");
    expect(logger.error).toHaveBeenCalledWith("ImageCache", "Failed to clear image cache", expect.any(Object));
  });
});

describe("getImageCacheStats", () => {
  it("bootstraps the stats from a scan when no stats file exists", async () => {
    const shard = path.join(cacheDir, "ab", "cd");
    mkdirSync(shard, { recursive: true });
    writeFileSync(path.join(shard, "abcd1.webp"), Buffer.alloc(5));
    writeFileSync(path.join(shard, "abcd2.webp"), Buffer.alloc(7));
    writeFileSync(path.join(shard, "notes.txt"), "ignored");
    writeFileSync(path.join(cacheDir, "ab", "stray.webp"), "not in a shard2 dir");

    expect(await ic.getImageCacheStats()).toEqual({ fileCount: 2, totalSize: 12 });
    expect(statsOnDisk()).toEqual({ fileCount: 2, totalSize: 12 });
  });

  it("reads an existing stats file without scanning, and treats a corrupt one as empty", async () => {
    writeFileSync(path.join(cacheDir, "_stats.json"), JSON.stringify({ fileCount: 9, totalSize: 99 }));
    expect(await ic.getImageCacheStats()).toEqual({ fileCount: 9, totalSize: 99 });
    writeFileSync(path.join(cacheDir, "_stats.json"), "{not json");
    expect(await ic.getImageCacheStats()).toEqual({ fileCount: 0, totalSize: 0 });
  });

  it("never lets an invalidation drive the counters below zero", async () => {
    const { cacheKey } = await ic.cacheImage(LIB, "/neg", async () => ({ data: await png(), contentType: "image/png" }));
    await vi.waitFor(() => expect(statsOnDisk()?.fileCount).toBe(1));
    // The counters drifted low (e.g. a lost update) — invalidation must clamp at 0.
    writeFileSync(path.join(cacheDir, "_stats.json"), JSON.stringify({ fileCount: 0, totalSize: 1 }));
    await ic.invalidateCachedUrls(LIB, [null, undefined, "/neg"]);
    expect(existsSync(fileFor(cacheKey))).toBe(false);
    await vi.waitFor(() => expect(statsOnDisk()).toEqual({ fileCount: 0, totalSize: 0 }));
  });

  it("reports zero when the cache directory cannot be created", async () => {
    const blocker = path.join(cacheDir, "file-not-dir");
    writeFileSync(blocker, "x");
    vi.stubEnv("IMAGE_CACHE_DIR", path.join(blocker, "cache"));
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).imageCacheState;
    const blocked = await import("@/lib/image-cache/image-cache");
    // The scan finds nothing; writing the bootstrap stats then fails too.
    await expect(blocked.getImageCacheStats()).rejects.toThrow(/ENOTDIR|EEXIST/);
    expect(await blocked.pruneImageCache()).toEqual({ removed: 0 });
    const { logger } = await import("@/lib/logger");
    expect(logger.error).toHaveBeenCalledWith("ImageCache", "Failed to prune image cache", expect.any(Object));
  });
});

describe("invalidateCachedUrls", () => {
  it("removes every width of every distinct artwork, counting each file once", async () => {
    const widths = [400, 640, 1920];
    const keys: string[] = [];
    for (const url of ["/library/metadata/1/thumb/111", "/library/metadata/2/thumb"]) {
      keys.push((await ic.cacheImage(LIB, url, async () => ({ data: await png(), contentType: "image/png" }))).cacheKey);
      for (const maxWidth of widths) {
        keys.push(
          (await ic.cacheImage(LIB, url, async () => ({ data: await png(), contentType: "image/png" }), { maxWidth })).cacheKey,
        );
      }
    }
    await vi.waitFor(() => expect(statsOnDisk()?.fileCount).toBe(8));
    const kept = await ic.cacheImage("other-lib", "/library/metadata/2/thumb", async () => ({ data: await png(), contentType: "image/png" }));
    await vi.waitFor(() => expect(statsOnDisk()?.fileCount).toBe(9));

    // The same artwork named many times (episodes sharing a season poster),
    // under two spellings of the Plex URL.
    await ic.invalidateCachedUrls(LIB, [
      "/library/metadata/1/thumb/111",
      "/library/metadata/1/thumb/222",
      "/library/metadata/1/thumb",
      "/library/metadata/2/thumb",
      "/library/metadata/2/thumb",
      null,
    ]);

    for (const key of keys) expect(existsSync(fileFor(key))).toBe(false);
    expect(existsSync(fileFor(kept.cacheKey))).toBe(true);
    await vi.waitFor(() =>
      expect(statsOnDisk()).toEqual({ fileCount: 1, totalSize: statSync(fileFor(kept.cacheKey)).size }),
    );
  });

  it("does nothing for a list with no artwork", async () => {
    writeFileSync(path.join(cacheDir, "_stats.json"), JSON.stringify({ fileCount: 3, totalSize: 30 }));
    await ic.invalidateCachedUrls(LIB, [null, undefined, ""]);
    await ic.invalidateCachedUrls(LIB, ["/never-cached"]);
    expect(statsOnDisk()).toEqual({ fileCount: 3, totalSize: 30 });
  });
});

describe("pruneImageCache", () => {
  it("walks every shard, skipping stray files, and counts what it keeps", async () => {
    const shards = ["aa/bb", "aa/cc", "dd/ee"];
    for (const shard of shards) {
      mkdirSync(path.join(cacheDir, shard), { recursive: true });
      writeFileSync(path.join(cacheDir, shard, `${shard.replace("/", "")}-new.webp`), Buffer.alloc(4));
      const old = path.join(cacheDir, shard, `${shard.replace("/", "")}-old.webp`);
      writeFileSync(old, Buffer.alloc(9));
      utimesSync(old, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO);
    }
    writeFileSync(path.join(cacheDir, "aa", "bb", "readme.txt"), "not a cached image");

    expect(await ic.pruneImageCache()).toEqual({ removed: 3 });
    expect(statsOnDisk()).toEqual({ fileCount: 3, totalSize: 12 });
    expect(existsSync(path.join(cacheDir, "aa", "bb", "readme.txt"))).toBe(true);
  });

  it("removes only expired files and reconciles the stats from disk", async () => {
    const fresh = await ic.cacheImage(LIB, "/fresh", async () => ({ data: await png(), contentType: "image/png" }));
    const stale = await ic.cacheImage(LIB, "/stale", async () => ({ data: await png(60, 60), contentType: "image/png" }));
    await vi.waitFor(() => expect(statsOnDisk()?.fileCount).toBe(2));
    utimesSync(fileFor(stale.cacheKey), EIGHT_DAYS_AGO, EIGHT_DAYS_AGO);

    expect(await ic.pruneImageCache()).toEqual({ removed: 1 });
    expect(existsSync(fileFor(stale.cacheKey))).toBe(false);
    expect(existsSync(fileFor(fresh.cacheKey))).toBe(true);
    expect(statsOnDisk()).toEqual({ fileCount: 1, totalSize: statSync(fileFor(fresh.cacheKey)).size });
  });

  it("touches nothing when no file has expired", async () => {
    await ic.cacheImage(LIB, "/fresh", async () => ({ data: await png(), contentType: "image/png" }));
    await vi.waitFor(() => expect(statsOnDisk()?.fileCount).toBe(1));
    writeFileSync(path.join(cacheDir, "_stats.json"), JSON.stringify({ fileCount: 42, totalSize: 42 }));
    expect(await ic.pruneImageCache()).toEqual({ removed: 0 });
    // Not reconciled: nothing was removed.
    expect(statsOnDisk()).toEqual({ fileCount: 42, totalSize: 42 });
  });
});
