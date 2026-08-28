import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rm, readdir } from "node:fs/promises";
import sharp from "sharp";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Point the cache at a scratch dir before the module reads the env var at import
// time, so a test run can never touch a real /config/cache/images.
const { mockFetchImage, cacheDir } = vi.hoisted(() => {
  const dir = `/tmp/librariarr-imgproxy-test-${process.pid}`;
  process.env.IMAGE_CACHE_DIR = dir;
  return { mockFetchImage: vi.fn(), cacheDir: dir };
});

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
  createMediaServerClient: vi.fn(() => ({ fetchImage: mockFetchImage })),
}));

vi.mock("axios", () => ({
  default: {
    get: vi.fn().mockResolvedValue({
      data: Buffer.from("fake-image-data"),
      headers: { "content-type": "image/jpeg" },
    }),
  },
}));

import { GET } from "@/app/api/media/[id]/image/route";
import { computeCacheKey } from "@/lib/image-cache/image-cache";
import {
  CACHE_WIDTH_ART,
  CACHE_WIDTH_DEFAULT,
  CACHE_WIDTH_GRID,
  CACHE_WIDTH_GRID_WIDE,
} from "@/lib/image-url";

const THUMB = "/library/metadata/12345/thumb/1706000000";
const ART = "/library/metadata/12345/art/1706000000";

describe("GET /api/media/[id]/image", () => {
  let userId: string;
  let libraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    // Now that the cache is genuinely written, it survives between tests and
    // the shared THUMB would be served from disk — start every test cold.
    await rm(cacheDir, { recursive: true, force: true });
    mockFetchImage.mockReset();
    // A REAL image: with unparseable bytes sharp throws, cacheImage returns via
    // its SharpFailedError path and never writes to disk, so nothing here would
    // actually exercise the cache.
    mockFetchImage.mockResolvedValue({
      data: await sharp({
        create: { width: 64, height: 96, channels: 3, background: "#123456" },
      })
        .jpeg()
        .toBuffer(),
      contentType: "image/jpeg",
    });
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
    const server = await createTestServer(userId);
    const library = await createTestLibrary(server.id);
    libraryId = library.id;
  });

  afterAll(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    const response = await callRouteWithParams(GET, { id: "any" });
    expect(response.status).toBe(401);
  });

  it("returns 404 for non-existent item", async () => {
    const response = await callRouteWithParams(GET, { id: "nonexistent" });
    expect(response.status).toBe(404);
  });

  it("returns 404 when item has no thumbnail", async () => {
    const item = await createTestMediaItem(libraryId);
    // item has no thumbUrl set by default
    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(404);
  });

  describe("width selection", () => {
    // The ETag is the cache key, and the cache key encodes the width, so it is
    // the observable proof of which variant the route resolved to.
    async function etagFor(searchParams?: Record<string, string>) {
      const item = await createTestMediaItem(libraryId, { thumbUrl: THUMB });
      await getTestPrisma().mediaItem.update({
        where: { id: item.id },
        data: { artUrl: ART },
      });
      const response = await callRouteWithParams(GET, { id: item.id }, { searchParams });
      expect(response.status).toBe(200);
      return response.headers.get("etag");
    }

    it("serves the default width when no w is given", async () => {
      expect(await etagFor()).toBe(`"${computeCacheKey(THUMB, CACHE_WIDTH_DEFAULT)}"`);
    });

    it("serves the grid width for w=400", async () => {
      expect(await etagFor({ w: String(CACHE_WIDTH_GRID) })).toBe(
        `"${computeCacheKey(THUMB, CACHE_WIDTH_GRID)}"`,
      );
    });

    it("serves the wide grid width for w=640", async () => {
      expect(await etagFor({ w: String(CACHE_WIDTH_GRID_WIDE) })).toBe(
        `"${computeCacheKey(THUMB, CACHE_WIDTH_GRID_WIDE)}"`,
      );
    });

    it("caches each width separately", async () => {
      const grid = await etagFor({ w: String(CACHE_WIDTH_GRID) });
      const wide = await etagFor({ w: String(CACHE_WIDTH_GRID_WIDE) });
      const def = await etagFor();
      expect(new Set([grid, wide, def]).size).toBe(3);
    });

    it("falls back to the default width for a w outside the allow-list", async () => {
      // Otherwise any caller could mint arbitrary cache entries.
      expect(await etagFor({ w: "401" })).toBe(`"${computeCacheKey(THUMB, CACHE_WIDTH_DEFAULT)}"`);
      expect(await etagFor({ w: "abc" })).toBe(`"${computeCacheKey(THUMB, CACHE_WIDTH_DEFAULT)}"`);
    });

    it("ignores w for type=art — the hero picks its own width", async () => {
      expect(await etagFor({ type: "art", w: String(CACHE_WIDTH_GRID) })).toBe(
        `"${computeCacheKey(ART, CACHE_WIDTH_ART)}"`,
      );
    });

    it("requests the artwork from the media server once per uncached width", async () => {
      const item = await createTestMediaItem(libraryId, { thumbUrl: THUMB });
      const params = { w: String(CACHE_WIDTH_GRID) };

      const first = await callRouteWithParams(GET, { id: item.id }, { searchParams: params });
      expect(first.status).toBe(200);
      expect(mockFetchImage).toHaveBeenCalledTimes(1);

      // Second request for the same (thumb, width) must be served from disk.
      const second = await callRouteWithParams(GET, { id: item.id }, { searchParams: params });
      expect(second.status).toBe(200);
      expect(mockFetchImage).toHaveBeenCalledTimes(1);
    });

    it("actually writes the resized variant to the cache directory", async () => {
      // Guards the whole suite: if the fetch mock stops returning a decodable
      // image, cacheImage silently stops writing and every assertion above
      // starts passing through the failure path instead.
      const item = await createTestMediaItem(libraryId, { thumbUrl: THUMB });
      await callRouteWithParams(GET, { id: item.id }, { searchParams: { w: String(CACHE_WIDTH_GRID) } });

      const shards = await readdir(cacheDir).catch(() => []);
      expect(shards.length).toBeGreaterThan(0);
    });

    it("caches each width as a separate file, so a second width still fetches", async () => {
      const item = await createTestMediaItem(libraryId, { thumbUrl: THUMB });
      await callRouteWithParams(GET, { id: item.id }, { searchParams: { w: String(CACHE_WIDTH_GRID) } });
      expect(mockFetchImage).toHaveBeenCalledTimes(1);

      await callRouteWithParams(GET, { id: item.id }, { searchParams: { w: String(CACHE_WIDTH_GRID_WIDE) } });
      expect(mockFetchImage).toHaveBeenCalledTimes(2);
    });

    it("tells the media server which width to resize to", async () => {
      // The server-side resize is where the bytes are saved; the local resize
      // would still produce a correct image without it, so only this asserts it.
      await etagFor({ w: String(CACHE_WIDTH_GRID) });
      expect(mockFetchImage).toHaveBeenCalledWith(THUMB, { width: CACHE_WIDTH_GRID });
    });

    it("asks for the default width when the caller does not specify one", async () => {
      await etagFor();
      expect(mockFetchImage).toHaveBeenCalledWith(THUMB, { width: CACHE_WIDTH_DEFAULT });
    });

    it("asks for the hero width for type=art", async () => {
      await etagFor({ type: "art" });
      expect(mockFetchImage).toHaveBeenCalledWith(ART, { width: CACHE_WIDTH_ART });
    });
  });
});
