/**
 * A Jellyfin/Emby server with one user whose played-items listing stays
 * unreliable (an empty first page under a non-zero total: their items hidden
 * from the key by parental controls or library access, while the server still
 * counts them), through the REAL full sync — so every release of a
 * library-resync hold, which nulls the watch-history marker on purpose, is
 * followed by the history pass exactly as in production.
 *
 * The set-aside user's stored rows vouch for the history, so it is established
 * again after a release. Only a user with nothing stored at all, on a server
 * whose history was never established, keeps the play-activity rules paused.
 * Before, the first rule held for an established server only, and any hold
 * release (a library's first sync via Sync Now or a full sync, a purge, a
 * restore) left the marker null for good. The price is pinned here too: their
 * plays that are not stored — those of a purged library, for one — stay
 * missing while the history counts as established.
 *
 * Real database; the media-server client is faked (what the server lists, and
 * which users the history fetch sets aside).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

const m = vi.hoisted(() => ({
  libraries: [] as Array<{ key: string; title: string; type: string }>,
  listings: {} as Record<string, Array<Record<string, unknown>>>,
  history: vi.fn(),
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
  createMediaServerClient: vi.fn(() => ({
    bulkListingIncomplete: false,
    supportsHistorySince: false,
    testConnection: vi.fn(async () => ({ ok: true, serverName: "Test Server" })),
    getLibraries: vi.fn(async () => m.libraries),
    getWatchCounts: vi.fn(async () => new Map()),
    getLibraryShows: vi.fn(async () => []),
    getLibraryItemsPage: vi.fn(async (key: string, _type: string, offset: number, limit: number) => {
      const items = m.listings[key] ?? [];
      return { items: items.slice(offset, offset + limit).map((i) => ({ ...i })), total: items.length };
    }),
    getItemMetadata: vi.fn(async () => ({})),
    getDetailedWatchHistory: vi.fn((...args: unknown[]) => m.history(...args)),
  })),
}));

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: vi.fn(async () => true),
  isJobRetrying: vi.fn(async () => false),
}));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));

import { syncMediaServer } from "@/lib/sync/sync-server";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { checkWatchHistoryCompleteness } from "@/lib/lifecycle/evaluability";
import { DELETE as purge } from "@/app/api/media/purge/route";
import { logger } from "@/lib/logger";
import type { DetailedWatchHistoryReport } from "@/lib/media-server/types";

const prisma = getTestPrisma();

const movie = (ratingKey: string) => ({ ratingKey, title: `Movie ${ratingKey}`, type: "movie" });
const play = (ratingKey: string, username: string) => ({
  ratingKey,
  username,
  watchedAt: "2026-01-05T20:00:00.000Z",
  deviceName: null,
  platform: null,
});

describe("a Jellyfin user whose played-items listing stays unreliable", () => {
  let userId: string;
  let serverId: string;

  /** A server with a Movies library holding m1, which alice and bob have played. */
  async function fixture(options: { marker: Date | null; bobStored: boolean }) {
    const user = await createTestUser();
    userId = user.id;
    const server = await createTestServer(user.id, { type: "JELLYFIN", watchHistorySyncedAt: options.marker });
    serverId = server.id;
    const movies = await createTestLibrary(server.id, { key: "1", title: "Movies", type: "MOVIE" });
    const m1 = await createTestMediaItem(movies.id, { ratingKey: "m1", type: "MOVIE", title: "Movie m1" });
    if (options.bobStored) {
      // Stored by an earlier sync, while bob's listing could still be read.
      await prisma.watchHistory.create({
        data: { mediaItemId: m1.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: new Date("2025-06-01T00:00:00.000Z") },
      });
    }
    m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
    m.listings = { "1": [movie("m1")] };
  }

  /** A second library, enabled on the server: its first sync takes a population hold. */
  async function addLibrary() {
    await createTestLibrary(serverId, { key: "2", title: "New Movies", type: "MOVIE" });
    m.libraries = [
      { key: "1", title: "Movies", type: "movie" },
      { key: "2", title: "New Movies", type: "movie" },
    ];
    m.listings["2"] = [movie("n1")];
  }

  const state = () =>
    prisma.mediaServer.findUniqueOrThrow({
      where: { id: serverId },
      select: { watchHistorySyncedAt: true, libraryResyncRequiredAt: true },
    });
  const bobsRows = () =>
    prisma.watchHistory.count({ where: { mediaServerId: serverId, serverUsername: "bob" } });

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // bob's listing is set aside as unreliable on every history fetch.
    m.history.mockImplementation(async (options?: { report?: DetailedWatchHistoryReport }) => {
      options?.report?.incompleteUsers.set("bob", "unreliable");
      return [play("m1", "alice")];
    });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("keeps an established server established", async () => {
    await fixture({ marker: new Date("2026-01-01T00:00:00.000Z"), bobStored: true });

    await syncMediaServer(serverId, undefined, { trigger: "test: full sync" });

    expect((await state()).watchHistorySyncedAt).toBeInstanceOf(Date);
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
  });

  it("re-establishes it after a full sync whose new library's hold release nulled the marker", async () => {
    await fixture({ marker: new Date("2026-01-01T00:00:00.000Z"), bobStored: true });
    await addLibrary();

    await syncMediaServer(serverId, undefined, { trigger: "test: full sync" });

    // The release nulled the marker; the same sync's history pass re-establishes it.
    expect(await state()).toEqual({
      watchHistorySyncedAt: expect.any(Date),
      libraryResyncRequiredAt: null,
    });
    expect(await bobsRows()).toBe(1);
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });

    // And it stays so through later syncs and Refreshes (the reviewer's loop).
    for (let run = 0; run < 2; run++) {
      await syncMediaServer(serverId, undefined, { trigger: `test: full sync #${run}` });
      await syncWatchHistory(serverId);
    }
    expect((await state()).watchHistorySyncedAt).toBeInstanceOf(Date);
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
  });

  it("re-establishes it after Sync Now on the new library (a scoped run releasing its own hold)", async () => {
    await fixture({ marker: new Date("2026-01-01T00:00:00.000Z"), bobStored: true });
    await addLibrary();
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });

    await syncMediaServer(serverId, "2", { trigger: "test: Sync Now" });

    expect(await state()).toEqual({
      watchHistorySyncedAt: expect.any(Date),
      libraryResyncRequiredAt: null,
    });
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
  });

  it("establishes it after a purge although bob's plays of the purged library cannot come back — and every sync says so", async () => {
    // The deliberate cost of vouching on stored rows. m1 (Movies) was watched
    // only by bob, o1 (Other) too; both rows were stored while his listing
    // could still be read, long after the items were added.
    await fixture({ marker: new Date("2026-01-01T00:00:00.000Z"), bobStored: true });
    const other = await createTestLibrary(serverId, { key: "2", title: "Other", type: "MOVIE" });
    const o1 = await createTestMediaItem(other.id, { ratingKey: "o1", type: "MOVIE", title: "Movie o1" });
    await prisma.watchHistory.create({
      data: { mediaItemId: o1.id, mediaServerId: serverId, serverUsername: "bob", watchedAt: new Date("2025-06-01T00:00:00.000Z") },
    });
    await prisma.mediaItem.updateMany({ data: { createdAt: new Date("2025-01-01T00:00:00.000Z") } });
    m.libraries = [
      { key: "1", title: "Movies", type: "movie" },
      { key: "2", title: "Other", type: "movie" },
    ];
    m.listings["2"] = [movie("o1")];
    m.history.mockImplementation(async (options?: { report?: DetailedWatchHistoryReport }) => {
      options?.report?.incompleteUsers.set("bob", "unreliable");
      return [];
    });
    const movies = await prisma.library.findFirstOrThrow({ where: { mediaServerId: serverId, key: "1" } });

    setMockSession({ isLoggedIn: true, userId });
    await expectJson(
      await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId: movies.id } }),
      200,
    );
    await syncMediaServer(serverId, undefined, { trigger: "test: full sync after the purge" });

    // The hold is released, and bob's o1 row vouches for the history...
    expect(await state()).toEqual({ watchHistorySyncedAt: expect.any(Date), libraryResyncRequiredAt: null });
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    expect(await bobsRows()).toBe(1);
    // ...while m1, re-added by that sync, reads as never played: bob's play of
    // it went with the purge, and nothing can bring it back while he is
    // unreadable — "Play Count = 0" matches it.
    const m1 = await prisma.mediaItem.findFirstOrThrow({
      where: { ratingKey: "m1" },
      select: { id: true, playCount: true, lastPlayedAt: true },
    });
    expect(m1).toMatchObject({ playCount: 0, lastPlayedAt: null });
    expect(await prisma.watchHistory.count({ where: { mediaItemId: m1.id } })).toBe(0);
    // Every sync says so, naming bob and what to change.
    expect(logger.warn).toHaveBeenCalledWith(
      "WatchHistory",
      expect.stringMatching(
        /^Not replacing the stored plays of "bob" \(listing incomplete\) .*every play of media added or re-added since \(a newly enabled, purged or re-created library\) — stay missing until their listing can be read, and an item they alone watched reads as never played unless one of its plays is stored\. Make their played items readable in Jellyfin \(their library access, parental controls\) or remove the user there$/,
      ),
    );
  });

  it("still does not establish a fresh server where bob has nothing stored — and a Refresh does not lift it", async () => {
    await fixture({ marker: null, bobStored: false });

    await syncMediaServer(serverId, undefined, { trigger: "test: first sync" });

    // alice's history is stored all the same.
    expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId, serverUsername: "alice" } })).toBe(1);
    expect(await state()).toEqual({ watchHistorySyncedAt: null, libraryResyncRequiredAt: null });
    expect((await checkWatchHistoryCompleteness(userId, [serverId])).complete).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "WatchHistory",
      expect.stringContaining('the played-items listing of "bob" could not be read completely'),
    );

    await syncWatchHistory(serverId);
    expect((await state()).watchHistorySyncedAt).toBeNull();
  });
});
