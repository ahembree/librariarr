/**
 * The sync purges cached artwork under the scope the artwork routes cache it
 * under — the item's library id (see `computeCacheKey`). The scope is a plain
 * string, so a sync passing anything else (a server id, a library key) would
 * type-check and silently purge nothing: an item's old artwork would stay on
 * disk and keep being served until the 7-day TTL. Drives the real cache in a
 * scratch directory and checks each sync path that drops artwork, and that a
 * second server's file at the same path is left alone.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import sharp from "sharp";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestServer, createTestLibrary } from "../../setup/test-helpers";

const { cacheDir, state } = vi.hoisted(() => {
  const dir = `/tmp/librariarr-sync-imgscope-test-${process.pid}`;
  process.env.IMAGE_CACHE_DIR = dir;
  return {
    cacheDir: dir,
    state: {
      libraries: [] as { key: string; title: string; type: string }[],
      catalogs: {} as Record<string, { ratingKey: string; thumb: string }[]>,
    },
  };
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
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));
vi.mock("@/lib/sync/sync-watch-history", () => ({ syncWatchHistory: vi.fn(async () => ({ count: 0 })) }));

function movie(sectionKey: string, entry: { ratingKey: string; thumb: string }) {
  return {
    ratingKey: entry.ratingKey,
    key: `/library/metadata/${entry.ratingKey}`,
    type: "movie",
    title: `Movie ${entry.ratingKey}`,
    year: 2000,
    thumb: entry.thumb,
    librarySectionID: Number(sectionKey),
  };
}

vi.mock("@/lib/media-server/factory", async () => {
  const { MediaItemNotFoundError } = await import("@/lib/media-server/client");
  return {
    createMediaServerClient: vi.fn(() => ({
      bulkListingIncomplete: false,
      testConnection: vi.fn(async () => ({ ok: true })),
      getLibraries: vi.fn(async () => state.libraries),
      getWatchCounts: vi.fn(async () => new Map()),
      getLibraryItemsPage: vi.fn(async (sectionKey: string, _t: string, offset: number, limit: number) => {
        const catalog = state.catalogs[sectionKey] ?? [];
        return { items: catalog.slice(offset, offset + limit).map((e) => movie(sectionKey, e)), total: catalog.length };
      }),
      getItemMetadata: vi.fn(async (ratingKey: string) => {
        for (const [sectionKey, catalog] of Object.entries(state.catalogs)) {
          const entry = catalog.find((e) => e.ratingKey === ratingKey);
          if (entry) return movie(sectionKey, entry);
        }
        throw new MediaItemNotFoundError(ratingKey);
      }),
    })),
  };
});

import { syncMediaServer } from "@/lib/sync/sync-server";
import { syncMediaServerItems } from "@/lib/sync/sync-incremental";
import { cacheImage, getCachedImageInfo } from "@/lib/image-cache/image-cache";

const prisma = getTestPrisma();

/** Cache `path` exactly as the artwork route does for an item of `libraryId`. */
async function cacheArtwork(libraryId: string, path: string) {
  const data = await sharp({ create: { width: 8, height: 12, channels: 3, background: "#336699" } })
    .jpeg()
    .toBuffer();
  await cacheImage(libraryId, path, async () => ({ data, contentType: "image/jpeg" }));
  expect(await getCachedImageInfo(libraryId, path)).not.toBeNull();
}

const isCached = async (libraryId: string, path: string) => (await getCachedImageInfo(libraryId, path)) !== null;

/** One Plex server with a Movies library (key "1") holding `entries`, synced once. */
async function syncedServer(entries: { ratingKey: string; thumb: string }[]) {
  const user = await createTestUser();
  const server = await createTestServer(user.id, { type: "PLEX" });
  state.libraries = [{ key: "1", title: "Movies", type: "movie" }];
  state.catalogs = { "1": entries };
  await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
  const library = await prisma.library.findFirstOrThrow({ where: { mediaServerId: server.id, key: "1" } });
  // Another server's library: its item at the very same path is unrelated.
  const otherServer = await createTestServer(user.id, { type: "PLEX", name: "Other", url: "http://other:32400" });
  const otherLibrary = await createTestLibrary(otherServer.id, { key: "1", type: "MOVIE" });
  return { server, library, otherLibrary };
}

beforeEach(async () => {
  await cleanDatabase();
  await rm(cacheDir, { recursive: true, force: true });
  state.libraries = [];
  state.catalogs = {};
});
afterAll(async () => {
  await cleanDatabase();
  await rm(cacheDir, { recursive: true, force: true });
  await disconnectTestDb();
});

describe("sync purges cached artwork under the item's library", () => {
  it("when an item's artwork moves to another path", async () => {
    const old = "/library/metadata/7/thumb/1700000000";
    const { server, library, otherLibrary } = await syncedServer([{ ratingKey: "7", thumb: old }]);
    await cacheArtwork(library.id, old);
    await cacheArtwork(otherLibrary.id, old);

    state.catalogs["1"] = [{ ratingKey: "7", thumb: "/library/metadata/8/thumb/1700000000" }];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(await isCached(library.id, old)).toBe(false);
    expect(await isCached(otherLibrary.id, old)).toBe(true);
  });

  it("when the full sync purges an item the server no longer has", async () => {
    const thumb = "/library/metadata/9/thumb/1700000000";
    const { server, library, otherLibrary } = await syncedServer([
      { ratingKey: "5", thumb: "/library/metadata/5/thumb/1700000000" },
      { ratingKey: "9", thumb },
    ]);
    await cacheArtwork(library.id, thumb);
    await cacheArtwork(otherLibrary.id, thumb);

    state.catalogs["1"] = [{ ratingKey: "5", thumb: "/library/metadata/5/thumb/1700000000" }];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(await prisma.mediaItem.count({ where: { ratingKey: "9" } })).toBe(0);
    expect(await isCached(library.id, thumb)).toBe(false);
    expect(await isCached(otherLibrary.id, thumb)).toBe(true);
  });

  it("when the full sync purges a library the server no longer lists", async () => {
    const thumb = "/library/metadata/3/thumb/1700000000";
    const { server, library, otherLibrary } = await syncedServer([{ ratingKey: "3", thumb }]);
    await cacheArtwork(library.id, thumb);
    await cacheArtwork(otherLibrary.id, thumb);

    // Re-created on the server under a new key.
    state.libraries = [{ key: "2", title: "Movies", type: "movie" }];
    state.catalogs = { "2": [{ ratingKey: "4", thumb: "/library/metadata/4/thumb/1700000000" }] };
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(await prisma.library.count({ where: { id: library.id } })).toBe(0);
    expect(await isCached(library.id, thumb)).toBe(false);
    expect(await isCached(otherLibrary.id, thumb)).toBe(true);
  });

  it("when the incremental sync removes an item", async () => {
    const thumb = "/library/metadata/6/thumb/1700000000";
    const { server, library, otherLibrary } = await syncedServer([{ ratingKey: "6", thumb }]);
    await cacheArtwork(library.id, thumb);
    await cacheArtwork(otherLibrary.id, thumb);

    state.catalogs["1"] = [];
    const result = await syncMediaServerItems(server.id, [], ["6"]);

    expect(result.status).not.toBe("fell-back");
    expect(await prisma.mediaItem.count({ where: { ratingKey: "6" } })).toBe(0);
    expect(await isCached(library.id, thumb)).toBe(false);
    expect(await isCached(otherLibrary.id, thumb)).toBe(true);
  });
});
