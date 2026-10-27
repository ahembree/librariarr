/**
 * The full sync's stale-item purge against a library that changes WHILE it is
 * read. The listing is paged by offset, so one item deleted before the current
 * offset plus one added after it shifts the next page by one: the item that
 * slides back into the window already read is never seen, while the traversal
 * counts still add up to the server's total. Deleting that item cascades its
 * plays and lifecycle exceptions, so every stale candidate is confirmed with
 * the server before it is purged.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestServer } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));
vi.mock("@/lib/sync/sync-watch-history", () => ({ syncWatchHistory: vi.fn(async () => ({ count: 0 })) }));

// A sorted server-side catalogue served by offset paging, like Plex/Jellyfin.
const state = vi.hoisted(() => ({
  catalog: [] as string[],
  onFirstPage: null as null | (() => void),
  /** Rating keys the sync asked the server about one by one. */
  confirmed: [] as string[],
}));

function movie(key: string) {
  return {
    ratingKey: key,
    key: `/library/metadata/${key}`,
    type: "movie",
    title: `Movie ${key}`,
    year: 2000,
    librarySectionID: 1,
  };
}

vi.mock("@/lib/media-server/factory", async () => {
  const { MediaItemNotFoundError } = await import("@/lib/media-server/client");
  return {
    createMediaServerClient: vi.fn(() => ({
      bulkListingIncomplete: false,
      testConnection: vi.fn(async () => ({ ok: true })),
      getLibraries: vi.fn(async () => [{ key: "1", title: "Movies", type: "movie" }]),
      getLibraryItemsPage: vi.fn(async (_s: string, _t: string, offset: number, limit: number) => {
        const total = state.catalog.length;
        const items = state.catalog.slice(offset, offset + limit).map(movie);
        if (offset === 0 && state.onFirstPage) {
          const mutate = state.onFirstPage;
          state.onFirstPage = null;
          mutate();
        }
        return { items, total };
      }),
      getItemMetadata: vi.fn(async (key: string) => {
        state.confirmed.push(key);
        if (!state.catalog.includes(key)) throw new MediaItemNotFoundError(key);
        return movie(key);
      }),
    })),
  };
});

import { syncMediaServer } from "@/lib/sync/sync-server";

const prisma = getTestPrisma();
const keyAt = (i: number) => `k${String(i).padStart(4, "0")}`;

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.lifecycleException.deleteMany();
  await cleanDatabase();
  state.onFirstPage = null;
  state.confirmed = [];
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.lifecycleException.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("full sync stale purge under a shifting listing", () => {
  it("keeps an item the listing skipped, and still purges the one really removed", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });

    // 600 movies, sorted by key: two pages of 500. The first sync stores them.
    state.catalog = Array.from({ length: 600 }, (_, i) => keyAt(i));
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    expect(await prisma.mediaItem.count()).toBe(600);

    // The first item of page 2 has a play and an exception protecting it.
    const skipped = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: keyAt(500) } });
    await prisma.watchHistory.create({
      data: { mediaItemId: skipped.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date() },
    });
    await prisma.lifecycleException.create({
      data: { mediaItemId: skipped.id, userId: user.id, reason: "keep" },
    });

    // While page 1 is processed, k0010 is deleted on the server (before the
    // offset) and a new movie is added (sorted after everything). The total
    // stays 600, so the next page at offset 500 starts at k0501.
    state.onFirstPage = () => {
      state.catalog = state.catalog.filter((k) => k !== keyAt(10));
      state.catalog.push("z-new-movie");
    };
    // Keeps the second sync's start strictly after the first sync's row writes,
    // so the skipped row really is a stale candidate below.
    await new Promise((r) => setTimeout(r, 5));
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    // It was a stale candidate, and kept only because the server confirmed it.
    expect(state.confirmed).toEqual([keyAt(500)]);
    const still = await prisma.mediaItem.findFirst({ where: { ratingKey: keyAt(500) } });
    expect(still, "k0500 is still on the server but was purged").not.toBeNull();
    expect(await prisma.watchHistory.count({ where: { mediaItemId: skipped.id } })).toBe(1);
    expect(await prisma.lifecycleException.count({ where: { mediaItemId: skipped.id } })).toBe(1);
    expect(await prisma.mediaItem.count({ where: { ratingKey: "z-new-movie" } })).toBe(1);

    // k0010 was read on page 1 before it was deleted, so this run touched it.
    // The next sync does not see it, the server confirms it gone, and it goes —
    // the confirmation keeps what is there without keeping what is not.
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    expect(await prisma.mediaItem.count({ where: { ratingKey: keyAt(10) } })).toBe(0);
    expect(await prisma.mediaItem.count({ where: { ratingKey: keyAt(500) } })).toBe(1);
    expect(await prisma.mediaItem.count()).toBe(600);
  });
});
