import { describe, it, expect, vi, beforeEach } from "vitest";
import { CACHE_WIDTH_GRID, CACHE_WIDTH_GRID_WIDE } from "@/lib/image-url";

const m = vi.hoisted(() => ({
  findUniqueServer: vi.fn(),
  findUniqueSettings: vi.fn(),
  queryRaw: vi.fn(),
  fetchImage: vi.fn(),
  createMediaServerClient: vi.fn(),
  cacheImage: vi.fn(),
  getCachedImageInfo: vi.fn(),
  isUnreachable: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    mediaServer: { findUnique: m.findUniqueServer },
    appSettings: { findUnique: m.findUniqueSettings },
    $queryRaw: m.queryRaw,
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: m.createMediaServerClient,
}));
vi.mock("@/lib/media-server/health-cache", () => ({ isUnreachable: m.isUnreachable }));
// Keep the real computeCacheKey/normalizeCacheUrl — target dedup depends on the
// actual key derivation, so stubbing it would test nothing.
vi.mock("@/lib/image-cache/image-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/image-cache/image-cache")>();
  return { ...actual, cacheImage: m.cacheImage, getCachedImageInfo: m.getCachedImageInfo };
});

import { prewarmServerArtwork } from "@/lib/image-cache/prewarm";

const SERVER = {
  id: "srv-1",
  userId: "user-1",
  type: "PLEX",
  url: "http://plex.local:32400",
  accessToken: "tok",
  tlsSkipVerify: false,
  enabled: true,
};

/** Rows returned per query, keyed by the grid the query feeds. */
interface Fixture {
  moviePosters?: string[];
  showPosters?: string[];
  seasonPosters?: string[];
  musicArtists?: string[];
  musicAlbums?: string[];
  episodeStills?: string[];
}

function stubQueries(fx: Fixture) {
  m.queryRaw.mockImplementation((strings: TemplateStringsArray) => {
    const sql = strings.join(" ");
    const rows = (urls: string[] | undefined) => Promise.resolve((urls ?? []).map((url) => ({ url })));
    if (sql.includes("l.type = 'MOVIE'")) return rows(fx.moviePosters);
    if (sql.includes("l.type = 'MUSIC'")) {
      return sql.includes('mi."seasonThumbUrl"') ? rows(fx.musicAlbums) : rows(fx.musicArtists);
    }
    if (sql.includes('mi."seasonThumbUrl"')) return rows(fx.seasonPosters);
    if (sql.includes('mi."parentThumbUrl"')) return rows(fx.showPosters);
    return rows(fx.episodeStills);
  });
}

/** URL -> width actually requested from the media server. */
function warmedWidths(): Map<string, number | undefined> {
  return new Map(
    m.cacheImage.mock.calls.map((c) => [c[0] as string, (c[2] as { maxWidth?: number } | undefined)?.maxWidth]),
  );
}

describe("prewarmServerArtwork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findUniqueServer.mockResolvedValue(SERVER);
    m.findUniqueSettings.mockResolvedValue({ prewarmArtwork: true });
    m.isUnreachable.mockReturnValue(false);
    m.getCachedImageInfo.mockResolvedValue(null);
    m.cacheImage.mockResolvedValue({ data: Buffer.from("x"), contentType: "image/webp", cacheKey: "k" });
    m.createMediaServerClient.mockReturnValue({ fetchImage: m.fetchImage });
    stubQueries({});
  });

  it("warms posters at the grid width and episode stills at the wide width", async () => {
    stubQueries({
      moviePosters: ["/movie/a/thumb/1"],
      showPosters: ["/show/x/thumb/1"],
      seasonPosters: ["/show/x/season/1/thumb/1"],
      musicArtists: ["/artist/q/thumb/1"],
      musicAlbums: ["/album/z/thumb/1"],
      episodeStills: ["/ep/1/thumb/1"],
    });

    const result = await prewarmServerArtwork("srv-1");

    expect(result.considered).toBe(6);
    expect(result.warmed).toBe(6);
    const widths = warmedWidths();
    expect(widths.get("/movie/a/thumb/1")).toBe(CACHE_WIDTH_GRID);
    expect(widths.get("/album/z/thumb/1")).toBe(CACHE_WIDTH_GRID);
    // Landscape cards render episode stills much wider than a poster.
    expect(widths.get("/ep/1/thumb/1")).toBe(CACHE_WIDTH_GRID_WIDE);
  });

  it("asks the media server to resize to the width it will store", async () => {
    // Without this the server ships the full-resolution original and the whole
    // saving evaporates — the local resize happens either way, so nothing else
    // in the test suite would notice.
    stubQueries({ moviePosters: ["/movie/a/thumb/1"], episodeStills: ["/ep/1/thumb/1"] });

    await prewarmServerArtwork("srv-1");

    for (const call of m.cacheImage.mock.calls) {
      const [url, fetchFn, opts] = call as [string, () => Promise<unknown>, { maxWidth: number }];
      await fetchFn();
      expect(m.fetchImage).toHaveBeenCalledWith(url, { width: opts.maxWidth });
    }
    expect(m.fetchImage).toHaveBeenCalledWith("/movie/a/thumb/1", { width: CACHE_WIDTH_GRID });
    expect(m.fetchImage).toHaveBeenCalledWith("/ep/1/thumb/1", { width: CACHE_WIDTH_GRID_WIDE });
  });

  it("never warms the detail (800px) or hero (1920px) variants", async () => {
    stubQueries({ moviePosters: ["/movie/a/thumb/1"], episodeStills: ["/ep/1/thumb/1"] });
    await prewarmServerArtwork("srv-1");
    for (const width of warmedWidths().values()) {
      expect([CACHE_WIDTH_GRID, CACHE_WIDTH_GRID_WIDE]).toContain(width);
    }
  });

  it("skips targets already on disk instead of refetching", async () => {
    stubQueries({ moviePosters: ["/movie/a/thumb/1", "/movie/b/thumb/1"] });
    m.getCachedImageInfo.mockImplementation(async (url: string) =>
      url === "/movie/a/thumb/1" ? { cacheKey: "k", filePath: "/x", size: 1, mtimeMs: 0 } : null,
    );

    const result = await prewarmServerArtwork("srv-1");

    expect(result.alreadyCached).toBe(1);
    expect(result.warmed).toBe(1);
    expect(m.cacheImage).toHaveBeenCalledTimes(1);
    expect(m.cacheImage.mock.calls[0][0]).toBe("/movie/b/thumb/1");
  });

  it("collapses URLs that differ only by the Plex timestamp", async () => {
    // Both normalize to the same cache key, so warming both would be one
    // wasted fetch per duplicate across the whole library.
    stubQueries({
      moviePosters: ["/library/metadata/7/thumb/1706000000", "/library/metadata/7/thumb/1799999999"],
    });

    const result = await prewarmServerArtwork("srv-1");

    expect(result.considered).toBe(1);
    expect(m.cacheImage).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the setting is off", async () => {
    m.findUniqueSettings.mockResolvedValue({ prewarmArtwork: false });
    stubQueries({ moviePosters: ["/movie/a/thumb/1"] });

    const result = await prewarmServerArtwork("srv-1");

    expect(result.warmed).toBe(0);
    expect(m.queryRaw).not.toHaveBeenCalled();
    expect(m.cacheImage).not.toHaveBeenCalled();
  });

  it("defaults to warming when no settings row exists yet", async () => {
    m.findUniqueSettings.mockResolvedValue(null);
    stubQueries({ moviePosters: ["/movie/a/thumb/1"] });
    const result = await prewarmServerArtwork("srv-1");
    expect(result.warmed).toBe(1);
  });

  it("does nothing for a missing or disabled server", async () => {
    m.findUniqueServer.mockResolvedValue(null);
    expect((await prewarmServerArtwork("srv-1")).warmed).toBe(0);

    m.findUniqueServer.mockResolvedValue({ ...SERVER, enabled: false });
    expect((await prewarmServerArtwork("srv-1")).warmed).toBe(0);
    expect(m.cacheImage).not.toHaveBeenCalled();
  });

  it("skips the run when the server is already known to be unreachable", async () => {
    m.isUnreachable.mockReturnValue(true);
    stubQueries({ moviePosters: ["/movie/a/thumb/1"] });

    const result = await prewarmServerArtwork("srv-1");

    expect(result.abandoned).toBe(true);
    expect(m.cacheImage).not.toHaveBeenCalled();
  });

  it("gives up once the server starts failing consistently", async () => {
    stubQueries({ moviePosters: Array.from({ length: 200 }, (_, i) => `/movie/${i}/thumb/1`) });
    m.cacheImage.mockRejectedValue(new Error("ECONNRESET"));

    const result = await prewarmServerArtwork("srv-1");

    expect(result.abandoned).toBe(true);
    // Bailed out early rather than working through all 200.
    expect(result.failed).toBeLessThan(200);
  });

  it("survives an individual fetch failure without throwing", async () => {
    stubQueries({ moviePosters: ["/movie/a/thumb/1", "/movie/b/thumb/1"] });
    m.cacheImage.mockRejectedValueOnce(new Error("404")).mockResolvedValue({
      data: Buffer.from("x"), contentType: "image/webp", cacheKey: "k",
    });

    const result = await prewarmServerArtwork("srv-1");

    expect(result.failed).toBe(1);
    expect(result.warmed).toBe(1);
  });

  it("never throws when the target query fails", async () => {
    // A prewarm is best-effort — it must not surface as a failed job.
    m.queryRaw.mockRejectedValue(new Error("connection terminated"));

    const result = await prewarmServerArtwork("srv-1");

    expect(result.abandoned).toBe(true);
    expect(result.warmed).toBe(0);
  });

  it("caps a very large library and reports that it was capped", async () => {
    stubQueries({ moviePosters: Array.from({ length: 5001 }, (_, i) => `/movie/${i}/thumb/1`) });

    const result = await prewarmServerArtwork("srv-1");

    expect(result.considered).toBe(5001);
    expect(result.capped).toBe(true);
    expect(result.warmed).toBe(5000);
  });

  it("spends the per-run cap on fetches, so a capped library finishes over successive runs", async () => {
    // Regression: the cap used to truncate the *target list* before the
    // already-cached check, so every later run re-examined the same first 5000
    // targets, found them all cached, warmed nothing, and the deliberately
    // deferred tail (episode stills) stayed cold forever.
    const urls = Array.from({ length: 5003 }, (_, i) => `/movie/${i}/thumb/1`);
    stubQueries({ moviePosters: urls });

    // Stand in for the disk: whatever a run warms is cached for the next run.
    const onDisk = new Set<string>();
    m.getCachedImageInfo.mockImplementation(async (url: string) =>
      onDisk.has(url) ? { cacheKey: "k", filePath: "/x", size: 1, mtimeMs: 0 } : null,
    );
    m.cacheImage.mockImplementation(async (url: string) => {
      onDisk.add(url);
      return { data: Buffer.from("x"), contentType: "image/webp", cacheKey: "k" };
    });

    const first = await prewarmServerArtwork("srv-1");
    expect(first.warmed).toBe(5000);
    expect(first.capped).toBe(true);

    const second = await prewarmServerArtwork("srv-1");
    expect(second.warmed).toBe(3); // the remainder, not zero
    expect(second.alreadyCached).toBe(5000);
    expect(second.capped).toBe(false);

    // Everything is warm, and a third run is a pure no-op.
    expect(onDisk.size).toBe(5003);
    const third = await prewarmServerArtwork("srv-1");
    expect(third.warmed).toBe(0);
    expect(third.alreadyCached).toBe(5003);
  });

  it("does not let already-cached targets consume the fetch budget", async () => {
    // 5000 cached + 2 cold: the cold pair must still be warmed in one run.
    const cached = Array.from({ length: 5000 }, (_, i) => `/cached/${i}/thumb/1`);
    const cold = ["/cold/a/thumb/1", "/cold/b/thumb/1"];
    stubQueries({ moviePosters: [...cached, ...cold] });
    const cachedSet = new Set(cached);
    m.getCachedImageInfo.mockImplementation(async (url: string) =>
      cachedSet.has(url) ? { cacheKey: "k", filePath: "/x", size: 1, mtimeMs: 0 } : null,
    );

    const result = await prewarmServerArtwork("srv-1");

    expect(result.alreadyCached).toBe(5000);
    expect(result.warmed).toBe(2);
    expect(result.capped).toBe(false);
  });
});
