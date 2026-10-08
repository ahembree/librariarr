/**
 * A Jellyfin user whose played-items listing stays unreliable, through the REAL full sync (a hold
 * release nulls the marker, then the history pass runs). bob's stored rows vouch for the history;
 * the price is that his plays not stored stay missing. Real database; the client is faked.
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
  const ESTABLISHED = new Date("2026-01-01T00:00:00.000Z");
  const BOB_PLAYED = new Date("2025-06-01T00:00:00.000Z");

  /** An established server whose Movies library holds m1, which bob played while readable. */
  async function fixture() {
    const user = await createTestUser();
    userId = user.id;
    const server = await createTestServer(user.id, { type: "JELLYFIN", watchHistorySyncedAt: ESTABLISHED });
    serverId = server.id;
    const movies = await createTestLibrary(server.id, { key: "1", title: "Movies", type: "MOVIE" });
    const m1 = await createTestMediaItem(movies.id, { ratingKey: "m1", type: "MOVIE", title: "Movie m1" });
    await prisma.watchHistory.create({
      data: { mediaItemId: m1.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: BOB_PLAYED },
    });
    m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
    m.listings = { "1": [movie("m1")] };
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

  it.each([
    { run: "a full sync", libraryKey: undefined },
    { run: "Sync Now on the new library (a scoped run releasing its own hold)", libraryKey: "2" },
  ])("re-establishes the history after $run whose population hold release nulled the marker", async ({ libraryKey }) => {
    await fixture();
    // A second library enabled on the server: its first sync takes a population hold.
    await createTestLibrary(serverId, { key: "2", title: "New Movies", type: "MOVIE" });
    m.libraries.push({ key: "2", title: "New Movies", type: "movie" });
    m.listings["2"] = [movie("n1")];

    await syncMediaServer(serverId, libraryKey, { trigger: "test: sync" });

    // The release nulled the marker; the same sync's history pass re-established it.
    expect(await state()).toEqual({ watchHistorySyncedAt: expect.any(Date), libraryResyncRequiredAt: null });
    expect(await bobsRows()).toBe(1);
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    // And it stays so through later (unheld) full syncs and Refreshes.
    for (let run = 0; run < 2; run++) {
      await syncMediaServer(serverId, undefined, { trigger: `test: full sync #${run}` });
      await syncWatchHistory(serverId);
    }
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
  });

  it("establishes it after a purge although bob's plays of the purged library cannot come back — and every sync says so", async () => {
    // The deliberate cost of vouching on stored rows: m1 (Movies) and o1 (Other)
    // were both watched only by bob.
    await fixture();
    const other = await createTestLibrary(serverId, { key: "2", title: "Other", type: "MOVIE" });
    const o1 = await createTestMediaItem(other.id, { ratingKey: "o1", type: "MOVIE", title: "Movie o1" });
    await prisma.watchHistory.create({
      data: { mediaItemId: o1.id, mediaServerId: serverId, serverUsername: "bob", watchedAt: BOB_PLAYED },
    });
    await prisma.mediaItem.updateMany({ data: { createdAt: new Date("2025-01-01T00:00:00.000Z") } });
    m.libraries.push({ key: "2", title: "Other", type: "movie" });
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
    // ...while m1, re-added by that sync, reads as never played: bob's play went with the purge.
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
});
