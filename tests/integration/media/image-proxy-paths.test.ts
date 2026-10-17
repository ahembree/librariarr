import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
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

const { mockFetchImage, mockIsUnreachable, cacheDir } = vi.hoisted(() => {
  const dir = `/tmp/librariarr-imgproxy-paths-test-${process.pid}`;
  process.env.IMAGE_CACHE_DIR = dir;
  return { mockFetchImage: vi.fn(), mockIsUnreachable: vi.fn(() => false), cacheDir: dir };
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

vi.mock("@/lib/media-server/health-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media-server/health-cache")>()),
  isUnreachable: mockIsUnreachable,
}));

import { GET } from "@/app/api/media/[id]/image/route";
import { appCache } from "@/lib/cache/memory-cache";
import { computeCacheKey } from "@/lib/image-cache/image-cache";
import { CACHE_WIDTH_DEFAULT } from "@/lib/image-url";

const THUMB = "/library/metadata/777/thumb/1";
// Plex stores a cast member's photo as an absolute plex.tv URL.
const ROLE_THUMB = "https://metadata-static.plex.tv/a/people/2b1c4f0e9d8a7b6c5d4e3f2a1b0c9d8e.jpg";

async function realJpeg() {
  return sharp({ create: { width: 32, height: 48, channels: 3, background: "#654321" } })
    .jpeg()
    .toBuffer();
}

describe("GET /api/media/[id]/image — roles, cache hits and failures", () => {
  let userId: string;
  let libraryId: string;

  beforeEach(async () => {
    appCache.clear();
    await cleanDatabase();
    clearMockSession();
    await rm(cacheDir, { recursive: true, force: true });
    mockFetchImage.mockReset();
    mockFetchImage.mockResolvedValue({ data: await realJpeg(), contentType: "image/jpeg" });
    mockIsUnreachable.mockReset();
    mockIsUnreachable.mockReturnValue(false);
    userId = (await createTestUser()).id;
    setMockSession({ userId, isLoggedIn: true });
    const server = await createTestServer(userId);
    libraryId = (await createTestLibrary(server.id)).id;
  });

  afterAll(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await disconnectTestDb();
  });

  describe("type=role", () => {
    async function withRoles() {
      const item = await createTestMediaItem(libraryId, { thumbUrl: THUMB });
      await getTestPrisma().mediaItem.update({
        where: { id: item.id },
        // The shape the sync stores: { tag (the actor), role (the character), thumb }.
        data: {
          roles: [
            { tag: "Amy Adams", role: "Louise Banks", thumb: ROLE_THUMB },
            { tag: "Mark O'Brien", role: "Captain Marks", thumb: null },
          ],
        },
      });
      return item;
    }

    it("serves the cast member's photo at the given index", async () => {
      const item = await withRoles();
      const res = await callRouteWithParams(GET, { id: item.id }, { searchParams: { type: "role", index: "0" } });
      expect(res.status).toBe(200);
      expect(mockFetchImage).toHaveBeenCalledWith(ROLE_THUMB, { width: CACHE_WIDTH_DEFAULT });
    });

    it("answers 404 for an index out of range, a missing index or a role without a photo", async () => {
      const item = await withRoles();
      for (const index of ["5", "-1", "x", "1"]) {
        const res = await callRouteWithParams(GET, { id: item.id }, { searchParams: { type: "role", index } });
        expect(res.status, `index=${index}`).toBe(404);
        expect(await res.json()).toEqual({ error: "No thumbnail" });
      }
      const noIndex = await callRouteWithParams(GET, { id: item.id }, { searchParams: { type: "role" } });
      expect(noIndex.status).toBe(404);
      expect(await noIndex.json()).toEqual({ error: "No thumbnail" });
      expect(mockFetchImage).not.toHaveBeenCalled();
    });

    it("answers 404 when the item has no roles at all", async () => {
      const item = await createTestMediaItem(libraryId, { thumbUrl: THUMB });
      const res = await callRouteWithParams(GET, { id: item.id }, { searchParams: { type: "role", index: "0" } });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No thumbnail" });
      expect(mockFetchImage).not.toHaveBeenCalled();
    });
  });

  it("serves a cached image from disk and answers 304 to a matching If-None-Match", async () => {
    const item = await createTestMediaItem(libraryId, { thumbUrl: THUMB });
    const first = await callRouteWithParams(GET, { id: item.id });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toBe(`"${computeCacheKey(libraryId, THUMB)}"`);
    await first.arrayBuffer();

    // Second request: served from the cache file, not the media server.
    const second = await callRouteWithParams(GET, { id: item.id });
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("image/webp");
    expect(second.headers.get("etag")).toBe(etag);
    expect(Number(second.headers.get("content-length"))).toBeGreaterThan(0);
    const bytes = new Uint8Array(await second.arrayBuffer());
    expect(bytes.length).toBe(Number(second.headers.get("content-length")));
    expect(mockFetchImage).toHaveBeenCalledTimes(1);

    const notModified = await callRouteWithParams(GET, { id: item.id }, { headers: { "if-none-match": etag } });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);

    // A stale ETag still gets the image.
    const stale = await callRouteWithParams(GET, { id: item.id }, { headers: { "if-none-match": '"old"' } });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("etag")).toBe(etag);
    expect(mockFetchImage).toHaveBeenCalledTimes(1);
  });

  it("answers 502 without a request when the server is marked unreachable", async () => {
    mockIsUnreachable.mockReturnValue(true);
    const item = await createTestMediaItem(libraryId, { thumbUrl: THUMB });
    const res = await callRouteWithParams(GET, { id: item.id });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Server unreachable" });
    expect(mockFetchImage).not.toHaveBeenCalled();
  });

  it("answers 502 on a failed fetch and does not retry that thumbnail while the failure is cached", async () => {
    mockFetchImage.mockRejectedValue(new Error("boom"));
    const item = await createTestMediaItem(libraryId, { thumbUrl: THUMB });
    const first = await callRouteWithParams(GET, { id: item.id });
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ error: "Failed to fetch image" });
    expect(mockFetchImage).toHaveBeenCalledTimes(1);

    const second = await callRouteWithParams(GET, { id: item.id });
    expect(second.status).toBe(502);
    expect(await second.json()).toEqual({ error: "Failed to fetch image" });
    expect(mockFetchImage).toHaveBeenCalledTimes(1);
  });
});
