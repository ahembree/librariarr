import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import { CACHE_WIDTH_GRID, CACHE_WIDTH_GRID_WIDE } from "@/lib/image-url";

const m = vi.hoisted(() => ({
  fetchImage: vi.fn(),
  cacheImage: vi.fn(),
  getCachedImageInfo: vi.fn(),
  isUnreachable: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({ fetchImage: m.fetchImage })),
}));

vi.mock("@/lib/media-server/health-cache", () => ({ isUnreachable: m.isUnreachable }));

// Only the disk-touching half is stubbed — the target collection under test is
// the raw SQL, which has to run against real Postgres to prove anything.
vi.mock("@/lib/image-cache/image-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/image-cache/image-cache")>();
  return { ...actual, cacheImage: m.cacheImage, getCachedImageInfo: m.getCachedImageInfo };
});

import { prewarmServerArtwork } from "@/lib/image-cache/prewarm";

/** Every (url, width) pair the prewarmer asked the media server for. */
function warmed(): Array<{ url: string; width: number | undefined }> {
  return m.cacheImage.mock.calls.map((c) => ({
    url: c[0] as string,
    width: (c[2] as { maxWidth?: number } | undefined)?.maxWidth,
  }));
}

describe("prewarmServerArtwork (real DB)", () => {
  let userId: string;
  let serverId: string;

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    m.isUnreachable.mockReturnValue(false);
    m.getCachedImageInfo.mockResolvedValue(null);
    m.cacheImage.mockResolvedValue({ data: Buffer.from("x"), contentType: "image/webp", cacheKey: "k" });

    const user = await createTestUser();
    userId = user.id;
    const server = await createTestServer(userId);
    serverId = server.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("collects movie posters at the grid width", async () => {
    const lib = await createTestLibrary(serverId, { type: "MOVIE" });
    await createTestMediaItem(lib.id, { thumbUrl: "/movie/a/thumb/1", type: "MOVIE" });
    await createTestMediaItem(lib.id, { thumbUrl: "/movie/b/thumb/1", type: "MOVIE" });

    const result = await prewarmServerArtwork(serverId);

    expect(result.warmed).toBe(2);
    expect(warmed()).toEqual(
      expect.arrayContaining([
        { url: "/movie/a/thumb/1", width: CACHE_WIDTH_GRID },
        { url: "/movie/b/thumb/1", width: CACHE_WIDTH_GRID },
      ]),
    );
  });

  it("collapses a show's poster across all of its episodes", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const prisma = getTestPrisma();
    for (let i = 1; i <= 5; i++) {
      const ep = await createTestMediaItem(lib.id, { thumbUrl: `/ep/${i}/thumb/1`, type: "SERIES" });
      await prisma.mediaItem.update({
        where: { id: ep.id },
        // Every episode carries the same show + season artwork.
        data: { parentThumbUrl: "/show/x/thumb/1", seasonThumbUrl: "/show/x/s1/thumb/1" },
      });
    }

    const result = await prewarmServerArtwork(serverId);

    const urls = warmed().map((w) => w.url);
    // 5 stills + 1 show poster + 1 season poster, not 5 of each.
    expect(result.warmed).toBe(7);
    expect(urls.filter((u) => u === "/show/x/thumb/1")).toHaveLength(1);
    expect(urls.filter((u) => u === "/show/x/s1/thumb/1")).toHaveLength(1);
  });

  it("requests episode stills at the wide width and posters at the grid width", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, { thumbUrl: "/ep/1/thumb/1", type: "SERIES" });
    await getTestPrisma().mediaItem.update({
      where: { id: ep.id },
      data: { parentThumbUrl: "/show/x/thumb/1" },
    });

    await prewarmServerArtwork(serverId);

    const byUrl = new Map(warmed().map((w) => [w.url, w.width]));
    expect(byUrl.get("/ep/1/thumb/1")).toBe(CACHE_WIDTH_GRID_WIDE);
    expect(byUrl.get("/show/x/thumb/1")).toBe(CACHE_WIDTH_GRID);
  });

  it("falls back to the item thumb when a show has no parent artwork", async () => {
    // Mirrors resolveArtworkPath: ?type=parent falls back to the item's thumb.
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    await createTestMediaItem(lib.id, { thumbUrl: "/ep/1/thumb/1", type: "SERIES" });

    await prewarmServerArtwork(serverId);

    const byWidth = warmed().filter((w) => w.width === CACHE_WIDTH_GRID).map((w) => w.url);
    expect(byWidth).toEqual(["/ep/1/thumb/1"]);
  });

  it("collects music artist and album artwork", async () => {
    const lib = await createTestLibrary(serverId, { type: "MUSIC" });
    const track = await createTestMediaItem(lib.id, { thumbUrl: "/track/1/thumb/1", type: "MUSIC" });
    await getTestPrisma().mediaItem.update({
      where: { id: track.id },
      data: { parentThumbUrl: "/artist/q/thumb/1", seasonThumbUrl: "/album/z/thumb/1" },
    });

    await prewarmServerArtwork(serverId);

    const urls = warmed().map((w) => w.url);
    expect(urls).toContain("/artist/q/thumb/1");
    expect(urls).toContain("/album/z/thumb/1");
    // A music library has no landscape grid — nothing at the wide width.
    expect(warmed().every((w) => w.width === CACHE_WIDTH_GRID)).toBe(true);
  });

  it("ignores libraries belonging to another server", async () => {
    const otherServer = await createTestServer(userId, { name: "Other" });
    const otherLib = await createTestLibrary(otherServer.id, { type: "MOVIE" });
    await createTestMediaItem(otherLib.id, { thumbUrl: "/other/thumb/1", type: "MOVIE" });

    const lib = await createTestLibrary(serverId, { type: "MOVIE" });
    await createTestMediaItem(lib.id, { thumbUrl: "/mine/thumb/1", type: "MOVIE" });

    await prewarmServerArtwork(serverId);

    expect(warmed().map((w) => w.url)).toEqual(["/mine/thumb/1"]);
  });

  it("skips items with no artwork at all", async () => {
    const lib = await createTestLibrary(serverId, { type: "MOVIE" });
    await createTestMediaItem(lib.id, { type: "MOVIE" }); // no thumbUrl

    const result = await prewarmServerArtwork(serverId);

    expect(result.considered).toBe(0);
    expect(m.cacheImage).not.toHaveBeenCalled();
  });

  it("honours the prewarmArtwork setting", async () => {
    const lib = await createTestLibrary(serverId, { type: "MOVIE" });
    await createTestMediaItem(lib.id, { thumbUrl: "/movie/a/thumb/1", type: "MOVIE" });
    await getTestPrisma().appSettings.create({
      data: { userId, prewarmArtwork: false },
    });

    const result = await prewarmServerArtwork(serverId);

    expect(result.warmed).toBe(0);
    expect(m.cacheImage).not.toHaveBeenCalled();
  });
});
