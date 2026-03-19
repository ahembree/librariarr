import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma, mockClient } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRawUnsafe: vi.fn(),
  },
  mockClient: {
    getDetailedWatchHistory: vi.fn(),
  },
}));

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

import { syncWatchHistory } from "@/lib/sync/sync-watch-history";

describe("syncWatchHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    // Generate 150 entries (batch size is 100)
    const entries = Array.from({ length: 150 }, (_, i) => ({
      ratingKey: String(i),
      username: "Admin",
      watchedAt: "2024-01-01T00:00:00Z",
      deviceName: "Roku",
      platform: "Roku",
    }));
    mockClient.getDetailedWatchHistory.mockResolvedValueOnce(entries);

    // Media items (all match)
    const mediaItems = Array.from({ length: 150 }, (_, i) => ({
      id: `item-${i}`,
      ratingKey: String(i),
    }));
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mediaItems);

    // DELETE from WatchHistory
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    // INSERT batch 1 (100 items) and batch 2 (50 items)
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await syncWatchHistory("server-1");
    expect(result).toEqual({ count: 150 });

    // Should have 2 INSERT calls (batches of 100 + 50)
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
});
