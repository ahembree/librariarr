/**
 * A failed per-item enrichment fetch in the full sync (Plex lists items without
 * stream detail, so each changed item is fetched on its own). The bulk listing
 * item used to be upserted in its place — overwriting every stream-derived
 * column with the poorer listing values — and its `serverUpdatedAt` recorded,
 * so every later sync classified the item as unchanged and never enriched it
 * again. One timeout made a Dolby Vision film read as SDR to the rule engine
 * until Plex next touched the item.
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

const state = vi.hoisted(() => ({ updatedAt: 1_700_000_000, enrichFails: false }));

// What Plex's section listing returns: Media/Part, no Stream array.
const bulk = () => ({
  ratingKey: "m1", key: "/library/metadata/m1", type: "movie", title: "Dune", year: 2021,
  updatedAt: state.updatedAt,
  Media: [{ id: 1, width: 3840, height: 2160, Part: [{ id: 1, key: "", file: "/movies/Dune (2021).mkv", size: 1000 }] }],
});
// What /library/metadata/m1 returns: the same plus the stream detail.
const enriched = () => ({
  ...bulk(),
  Media: [{
    id: 1, width: 3840, height: 2160,
    Part: [{
      id: 1, key: "", file: "/movies/Dune (2021).mkv", size: 1000,
      Stream: [{ id: 1, streamType: 1, codec: "hevc", width: 3840, height: 2160, bitDepth: 10, videoRangeType: "DOVI" }],
    }],
  }],
});

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({
    bulkListingIncomplete: true,
    testConnection: vi.fn(async () => ({ ok: true })),
    getLibraries: vi.fn(async () => [{ key: "1", title: "Movies", type: "movie" }]),
    getWatchCounts: vi.fn(async () => new Map()),
    getLibraryItemsPage: vi.fn(async () => ({ items: [bulk()], total: 1 })),
    getItemMetadata: vi.fn(async () => {
      if (state.enrichFails) throw new Error("timeout of 30000ms exceeded");
      return enriched();
    }),
  })),
}));

import { syncMediaServer } from "@/lib/sync/sync-server";

const prisma = getTestPrisma();

beforeEach(async () => {
  await cleanDatabase();
  state.updatedAt = 1_700_000_000;
  state.enrichFails = false;
});
afterAll(async () => { await cleanDatabase(); await disconnectTestDb(); });

describe("full sync enrichment failure", () => {
  it("keeps a stored row's detail through a failed fetch, and refreshes it on the next sync", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    let row = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m1" } });
    expect(row.dynamicRange).toBe("Dolby Vision");

    // Plex refreshes the item (updatedAt moves) and the next sync's detail
    // fetch for it times out: the stored detail survives.
    state.updatedAt += 60;
    state.enrichFails = true;
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    row = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m1" } });
    expect(row.dynamicRange).toBe("Dolby Vision");
    expect(row.videoBitDepth).toBe(10);
    // Still the OLD server timestamp, so the next sync enriches it again.
    expect(row.serverUpdatedAt?.getTime()).toBe((state.updatedAt - 60) * 1000);

    state.enrichFails = false;
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    row = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m1" } });
    expect(row.dynamicRange).toBe("Dolby Vision");
    expect(row.serverUpdatedAt?.getTime()).toBe(state.updatedAt * 1000);
  });

  it("stores a new item whose fetch failed, then enriches it on the next sync", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });

    state.enrichFails = true;
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    let row = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m1" } });
    // It exists (from the listing) but has no server timestamp recorded...
    expect(row.serverUpdatedAt).toBeNull();

    // ...so a healthy sync does not call it unchanged.
    state.enrichFails = false;
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    row = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m1" } });
    expect(row.dynamicRange).toBe("Dolby Vision");
    expect(row.videoBitDepth).toBe(10);
  });
});
