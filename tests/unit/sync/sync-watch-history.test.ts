import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma, mockClient, mockReconcile } = vi.hoisted(() => {
  // The DELETE + INSERTs run inside prisma.$transaction(cb) via tx.$executeRawUnsafe.
  // Route the tx's raw methods to the same fn the tests assert against so the
  // existing call-inspection (DELETE/INSERT string filters) keeps working.
  const queryRawUnsafe = vi.fn();
  const tx = { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: queryRawUnsafe };
  return {
    mockPrisma: {
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: queryRawUnsafe,
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    },
    mockClient: {
      getDetailedWatchHistory: vi.fn(),
    },
    mockReconcile: vi.fn(async () => 0),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => mockClient),
}));

vi.mock("@/lib/http-retry", () => ({
  configureRetry: vi.fn(),
}));

vi.mock("@/lib/sync/watch-reconcile", () => ({
  reconcileWatchStateFromHistory: mockReconcile,
}));

import { syncWatchHistory } from "@/lib/sync/sync-watch-history";

describe("syncWatchHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcile.mockResolvedValue(0);
  });

  it("throws when server not found", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // server query
    await expect(syncWatchHistory("nonexistent")).rejects.toThrow("MediaServer not found");
  });

  it("skips sync for disabled server", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: false,
    }]);

    const result = await syncWatchHistory("server-1");
    expect(result).toEqual({ count: 0 });
    expect(mockClient.getDetailedWatchHistory).not.toHaveBeenCalled();
  });

  it("clears old records and returns 0 when no entries", async () => {
    // Server query
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: true,
    }]);

    mockClient.getDetailedWatchHistory.mockResolvedValueOnce([]);

    // DELETE from WatchHistory
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await syncWatchHistory("server-1");
    expect(result).toEqual({ count: 0 });

    // Should have called DELETE
    const deleteCalls = mockPrisma.$queryRawUnsafe.mock.calls
      .filter((args) => (args[0] as string).includes('DELETE FROM "WatchHistory"'));
    expect(deleteCalls.length).toBe(1);
  });

  it("skips the destructive DELETE when the watch-history fetch fails (no data loss)", async () => {
    // Server query
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: true,
    }]);

    // A transient outage: the client throws rather than returning [].
    mockClient.getDetailedWatchHistory.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await syncWatchHistory("server-1");
    expect(result).toEqual({ count: 0 });

    // CRITICAL: must NOT have wiped existing history on a fetch failure.
    const deleteCalls = mockPrisma.$queryRawUnsafe.mock.calls
      .filter((args) => (args[0] as string).includes('DELETE FROM "WatchHistory"'));
    expect(deleteCalls.length).toBe(0);
  });

  it("syncs watch history entries with matching media items", async () => {
    // Server query
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: true,
    }]);

    // Watch history entries from media server
    mockClient.getDetailedWatchHistory.mockResolvedValueOnce([
      { ratingKey: "100", username: "Admin", watchedAt: "2024-01-01T00:00:00Z", deviceName: "Roku", platform: "Roku" },
      { ratingKey: "200", username: "User1", watchedAt: "2024-01-02T00:00:00Z", deviceName: "iPhone", platform: "iOS" },
      { ratingKey: "999", username: "User2", watchedAt: "2024-01-03T00:00:00Z", deviceName: null, platform: null }, // no matching media item
    ]);

    // Media items query
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { id: "item-1", ratingKey: "100" },
      { id: "item-2", ratingKey: "200" },
    ]);

    // DELETE from WatchHistory
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    // INSERT into WatchHistory
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await syncWatchHistory("server-1");
    expect(result).toEqual({ count: 2 }); // Only 2 matched, not 3

    // Verify INSERT was called with correct number of value sets
    const insertCalls = mockPrisma.$queryRawUnsafe.mock.calls
      .filter((args) => (args[0] as string).includes('INSERT INTO "WatchHistory"'));
    expect(insertCalls.length).toBe(1);
  });

  it("handles entries in batches", async () => {
    // Server query
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: true,
    }]);

    // Generate 600 entries (batch size is 500 → splits into 2 batches)
    const entries = Array.from({ length: 600 }, (_, i) => ({
      ratingKey: String(i),
      username: "Admin",
      watchedAt: "2024-01-01T00:00:00Z",
      deviceName: "Roku",
      platform: "Roku",
    }));
    mockClient.getDetailedWatchHistory.mockResolvedValueOnce(entries);

    // Media items (all match)
    const mediaItems = Array.from({ length: 600 }, (_, i) => ({
      id: `item-${i}`,
      ratingKey: String(i),
    }));
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mediaItems);

    // DELETE from WatchHistory
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    // INSERT batch 1 (500 items) and batch 2 (100 items)
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await syncWatchHistory("server-1");
    expect(result).toEqual({ count: 600 });

    // Should have 2 INSERT calls (batches of 500 + 100)
    const insertCalls = mockPrisma.$queryRawUnsafe.mock.calls
      .filter((args) => (args[0] as string).includes('INSERT INTO "WatchHistory"'));
    expect(insertCalls.length).toBe(2);
  });

  it("returns 0 when no media items match", async () => {
    // Server query
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: true,
    }]);

    mockClient.getDetailedWatchHistory.mockResolvedValueOnce([
      { ratingKey: "100", username: "Admin", watchedAt: "2024-01-01T00:00:00Z", deviceName: null, platform: null },
    ]);

    // No matching media items
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    // DELETE from WatchHistory
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await syncWatchHistory("server-1");
    expect(result).toEqual({ count: 0 });

    // Should NOT have any INSERT calls since no items matched
    const insertCalls = mockPrisma.$queryRawUnsafe.mock.calls
      .filter((args) => (args[0] as string).includes('INSERT INTO "WatchHistory"'));
    expect(insertCalls.length).toBe(0);
  });

  it("keeps every undated play a count-only server reports", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Jellyfin",
      url: "http://jellyfin:8096",
      accessToken: "token",
      type: "JELLYFIN",
      tlsSkipVerify: false,
      enabled: true,
    }]);

    // Exactly what JellyfinBase.getDetailedWatchHistory emits for PlayCount=5:
    // one entry per play, only the first carrying LastPlayedDate. Keying the
    // dedupe on `watchedAt ?? ""` collapsed the four undated ones into one and
    // stored 2 rows, capping playCount at 2 per user for every Jellyfin/Emby
    // item — while the per-item history panel, which asks the server directly,
    // still reported 5.
    mockClient.getDetailedWatchHistory.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({
        ratingKey: "100",
        username: "bob",
        watchedAt: i === 0 ? "2025-07-01T00:00:00Z" : null,
        deviceName: null,
        platform: null,
      })),
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: "item-1", ratingKey: "100" }]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // INSERT

    await expect(syncWatchHistory("server-1")).resolves.toEqual({ count: 5 });
  });

  it("still collapses genuinely duplicated timestamped plays", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: true,
    }]);

    // Same item, user AND instant — one play reported twice by the source.
    mockClient.getDetailedWatchHistory.mockResolvedValueOnce([
      { ratingKey: "100", username: "bob", watchedAt: "2025-07-01T00:00:00Z", deviceName: null, platform: null },
      { ratingKey: "100", username: "bob", watchedAt: "2025-07-01T00:00:00Z", deviceName: null, platform: null },
      { ratingKey: "100", username: "bob", watchedAt: "2025-07-02T00:00:00Z", deviceName: null, platform: null },
    ]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: "item-1", ratingKey: "100" }]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // INSERT

    await expect(syncWatchHistory("server-1")).resolves.toEqual({ count: 2 });
  });

  it("reconciles MediaItem play state from the history it just stored", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: true,
    }]);

    mockClient.getDetailedWatchHistory.mockResolvedValueOnce([
      { ratingKey: "100", username: "Roommate", watchedAt: "2025-07-01T00:00:00Z", deviceName: null, platform: null },
    ]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: "item-1", ratingKey: "100" }]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // INSERT

    await syncWatchHistory("server-1");

    // Without this, a play by any non-admin user reaches WatchHistory and
    // nothing else — leaving `lastPlayedAt` (and the `seriesLastPlayedAt`
    // aggregate) reporting the admin's own, far older view.
    expect(mockReconcile).toHaveBeenCalledWith("server-1");
  });

  it("does not fail the sync when reconciliation throws", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: true,
    }]);

    mockClient.getDetailedWatchHistory.mockResolvedValueOnce([
      { ratingKey: "100", username: "Admin", watchedAt: "2025-07-01T00:00:00Z", deviceName: null, platform: null },
    ]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: "item-1", ratingKey: "100" }]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // INSERT
    mockReconcile.mockRejectedValueOnce(new Error("deadlock detected"));

    // The history rows are already committed — the count still reflects them.
    await expect(syncWatchHistory("server-1")).resolves.toEqual({ count: 1 });
  });
});
