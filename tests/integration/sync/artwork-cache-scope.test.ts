/**
 * The sync's artwork-cache invalidation against the REAL image cache. Cache
 * files are keyed by the item's library id plus the artwork path (see
 * `computeCacheKey`) — the image route reads and writes them under
 * `item.libraryId` — so every sync path that drops or replaces artwork has to
 * invalidate under that same library id. Passed anything else, the call is a
 * silent no-op and the old poster is served for the rest of the cache TTL;
 * every other sync test mocks the cache away, so only a test on disk sees it.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestServer } from "../../setup/test-helpers";

// Point the cache at a scratch dir before the module reads the env var at import
// time, so a test run can never touch a real /config/cache/images.
const { cacheDir, state } = vi.hoisted(() => {
  const dir = `/tmp/librariarr-sync-artwork-test-${process.pid}`;
  process.env.IMAGE_CACHE_DIR = dir;
  return {
    cacheDir: dir,
    state: {
      libraries: [] as { key: string; title: string; type: string }[],
      catalog: {} as Record<string, { ratingKey: string; thumb: string }[]>,
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

function movie(ratingKey: string, thumb: string, sectionKey: string) {
  return {
    ratingKey,
    key: `/library/metadata/${ratingKey}`,
    type: "movie",
    title: `Movie ${ratingKey}`,
    year: 2000,
    thumb,
    librarySectionID: Number(sectionKey),
  };
}

vi.mock("@/lib/media-server/factory", async () => {
  const { MediaItemNotFoundError } = await import("@/lib/media-server/client");
  const find = (key: string) => {
    for (const [section, items] of Object.entries(state.catalog)) {
      const hit = items.find((i) => i.ratingKey === key);
      if (hit) return movie(hit.ratingKey, hit.thumb, section);
    }
    return undefined;
  };
  return {
    createMediaServerClient: vi.fn(() => ({
      bulkListingIncomplete: false,
      testConnection: vi.fn(async () => ({ ok: true })),
      getLibraries: vi.fn(async () => state.libraries),
      getWatchCounts: vi.fn(async () => new Map()),
      getLibraryItemsPage: vi.fn(async (section: string, _t: string, offset: number, limit: number) => {
        const all = state.catalog[section] ?? [];
        return {
          items: all.slice(offset, offset + limit).map((i) => movie(i.ratingKey, i.thumb, section)),
          total: all.length,
        };
      }),
      getItemMetadata: vi.fn(async (key: string) => {
        const hit = find(key);
        if (!hit) throw new MediaItemNotFoundError(key);
        return hit;
      }),
    })),
  };
});

import { syncMediaServer } from "@/lib/sync/sync-server";
import { syncMediaServerItems } from "@/lib/sync/sync-incremental";
import { computeCacheKey } from "@/lib/image-cache/image-cache";

const prisma = getTestPrisma();

/** A cached variant at the exact path the image cache computes for `scope`. */
function writeCached(scope: string, url: string): string {
  const key = computeCacheKey(scope, url);
  const dir = path.join(cacheDir, key.slice(0, 2), key.slice(2, 4));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.webp`);
  writeFileSync(file, "fake-webp");
  return file;
}

/** One library ("1") with two movies, synced once; returns its library id. */
async function seed(serverId: string): Promise<string> {
  state.libraries = [{ key: "1", title: "Movies", type: "movie" }];
  state.catalog = {
    "1": [
      { ratingKey: "101", thumb: "/library/metadata/101/thumb/1700000000" },
      { ratingKey: "102", thumb: "/library/metadata/102/thumb/1700000000" },
    ],
  };
  await syncMediaServer(serverId, undefined, { skipWatchHistory: true });
  const library = await prisma.library.findFirstOrThrow({ where: { mediaServerId: serverId, key: "1" } });
  expect(await prisma.mediaItem.count({ where: { libraryId: library.id } })).toBe(2);
  return library.id;
}

beforeEach(async () => {
  await cleanDatabase();
  rmSync(cacheDir, { recursive: true, force: true });
});
afterAll(async () => {
  rmSync(cacheDir, { recursive: true, force: true });
  await cleanDatabase();
  await disconnectTestDb();
});

describe("sync invalidates cached artwork under the item's library", () => {
  it("when the stale purge removes an item", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    const libraryId = await seed(server.id);
    const url = "/library/metadata/102/thumb/1700000000";
    const cached = writeCached(libraryId, url);
    // Another library's copy of the same path is another server's poster.
    const otherLibrary = writeCached("some-other-library", url);

    state.catalog["1"] = state.catalog["1"].filter((i) => i.ratingKey !== "102");
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(await prisma.mediaItem.count({ where: { ratingKey: "102" } })).toBe(0);
    expect(existsSync(cached)).toBe(false);
    expect(existsSync(otherLibrary)).toBe(true);
  });

  it("when an item's artwork changes", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    const libraryId = await seed(server.id);
    const oldUrl = "/library/metadata/101/thumb/1700000000";
    const cached = writeCached(libraryId, oldUrl);
    const otherLibrary = writeCached("some-other-library", oldUrl);

    state.catalog["1"] = state.catalog["1"].map((i) =>
      i.ratingKey === "101" ? { ...i, thumb: "/library/metadata/101/art/1700000001" } : i,
    );
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(existsSync(cached)).toBe(false);
    expect(existsSync(otherLibrary)).toBe(true);
  });

  it("when the incremental sync removes an item", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    const libraryId = await seed(server.id);
    const url = "/library/metadata/101/thumb/1700000000";
    const cached = writeCached(libraryId, url);
    const otherLibrary = writeCached("some-other-library", url);

    const result = await syncMediaServerItems(server.id, [], ["101"]);

    expect(result.deleted).toBe(1);
    expect(existsSync(cached)).toBe(false);
    expect(existsSync(otherLibrary)).toBe(true);
  });

  it("when a library the server no longer lists is purged", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    const libraryId = await seed(server.id);
    const url = "/library/metadata/101/thumb/1700000000";
    const cached = writeCached(libraryId, url);
    const otherLibrary = writeCached("some-other-library", url);

    // Library "1" is gone; the server now lists only "2".
    state.libraries = [{ key: "2", title: "New Movies", type: "movie" }];
    state.catalog = { "2": [{ ratingKey: "201", thumb: "/library/metadata/201/thumb/1700000000" }] };
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(await prisma.library.count({ where: { id: libraryId } })).toBe(0);
    expect(existsSync(cached)).toBe(false);
    expect(existsSync(otherLibrary)).toBe(true);
  });
});
