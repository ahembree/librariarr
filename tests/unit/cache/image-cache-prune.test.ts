import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let cacheDir: string;

function writeWebp(name: string, ageMs: number) {
  const shardDir = path.join(cacheDir, name.slice(0, 2), name.slice(2, 4));
  mkdirSync(shardDir, { recursive: true });
  const fp = path.join(shardDir, `${name}.webp`);
  writeFileSync(fp, "fake-webp");
  const when = new Date(Date.now() - ageMs);
  utimesSync(fp, when, when);
  return fp;
}

describe("pruneImageCache", () => {
  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(tmpdir(), "librariarr-imgcache-"));
    vi.stubEnv("IMAGE_CACHE_DIR", cacheDir);
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("deletes images older than the TTL and keeps fresh ones", async () => {
    const stale = writeWebp("aabbccdd1111", SEVEN_DAYS_MS + 60_000); // older than 7d
    const fresh = writeWebp("eeff00112222", 60_000); // 1 minute old

    const { pruneImageCache } = await import("@/lib/image-cache/image-cache");
    const { removed } = await pruneImageCache();

    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // The stored counters are rebuilt from what is left on disk.
    expect(JSON.parse(readFileSync(path.join(cacheDir, "_stats.json"), "utf8"))).toEqual({
      fileCount: 1,
      totalSize: "fake-webp".length,
    });
  });

  it("removes nothing when all entries are fresh", async () => {
    const fresh = writeWebp("1234567890ab", 1000);
    const { pruneImageCache } = await import("@/lib/image-cache/image-cache");
    const { removed } = await pruneImageCache();
    expect(removed).toBe(0);
    expect(existsSync(fresh)).toBe(true);
    // Nothing pruned, nothing rewritten.
    expect(existsSync(path.join(cacheDir, "_stats.json"))).toBe(false);
  });
});
