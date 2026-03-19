import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Mocks ---

const { mockPrisma, mockClient } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRawUnsafe: vi.fn(),
  },
  mockClient: {
    bulkListingIncomplete: false,
    testConnection: vi.fn(),
    getLibraries: vi.fn(),
    getLibraryItems: vi.fn(),
    getLibraryShows: vi.fn(),
    getLibraryEpisodes: vi.fn(),
    getLibraryTracks: vi.fn(),
    getLibraryItemsPage: vi.fn(),
    getItemMetadata: vi.fn(),
    getWatchCounts: vi.fn(),
    getWatchHistory: vi.fn(),
    getDetailedWatchHistory: vi.fn(),
    getSessions: vi.fn(),
    terminateSession: vi.fn(),
    getImageUrl: vi.fn(),
    fetchImage: vi.fn(),
    getWatchlistGuids: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => mockClient),
}));

vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: vi.fn((url: string) => url),
}));

vi.mock("@/lib/dedup/compute-dedup-key", () => ({
  computeDedupKey: vi.fn(() => "dedup-key-mock"),
}));

vi.mock("@/lib/dedup/recompute-canonical", () => ({
  recomputeCanonical: vi.fn(),
}));

vi.mock("@/lib/db-retry", () => ({
  withDeadlockRetry: vi.fn((_label: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  appCache: { invalidate: vi.fn(), invalidatePrefix: vi.fn(), clear: vi.fn() },
}));

vi.mock("@/lib/resolution", () => ({
  normalizeResolutionFromDimensions: vi.fn(() => null),
}));

vi.mock("@/lib/sync/sync-semaphore", () => ({
  acquireSyncSlot: vi.fn(),
  releaseSyncSlot: vi.fn(),
}));

vi.mock("@/lib/sync/sync-watch-history", () => ({
  syncWatchHistory: vi.fn().mockResolvedValue({ count: 0 }),
}));

vi.mock("@/lib/http-retry", () => ({
  configureRetry: vi.fn(),
}));

import {
  detectDynamicRange,
  detectAudioProfile,
  syncMediaServer,
} from "@/lib/sync/sync-server";
import type { MediaStream, MediaPart } from "@/lib/media-server/types";

// Note: detectDynamicRangeFromFilename and detectAudioProfileFromFilename
// are already thoroughly tested in tests/unit/sync/detection.test.ts.
// Here we focus on detectDynamicRange, detectAudioProfile (with stream metadata),
// and the main syncMediaServer orchestrator.

// Helper to search through raw SQL calls by SQL pattern and optional parameter value
function findDbCalls(sqlPattern: string, paramValue?: string): unknown[][] {
  return mockPrisma.$queryRawUnsafe.mock.calls.filter(
    (args: unknown[]) => {
      const sql = String(args[0]);
      if (!sql.includes(sqlPattern)) return false;
      if (paramValue === undefined) return true;
      return args.includes(paramValue);
    },
  );
}

describe("detectDynamicRange (stream-based)", () => {
  it("returns Dolby Vision for DOVI rangeType", () => {
    const stream = { videoRangeType: "DOVIWithHDR10" } as MediaStream;
    expect(detectDynamicRange(stream, null)).toBe("Dolby Vision");
  });

  it("returns HDR10+ for HDR10Plus rangeType", () => {
    const stream = { videoRangeType: "HDR10Plus" } as MediaStream;
    expect(detectDynamicRange(stream, null)).toBe("HDR10+");
  });

  it("returns HDR10 for HDR10 rangeType", () => {
    const stream = { videoRangeType: "HDR10" } as MediaStream;
    expect(detectDynamicRange(stream, null)).toBe("HDR10");
  });

  it("returns HLG for HLG rangeType", () => {
    const stream = { videoRangeType: "HLG" } as MediaStream;
    expect(detectDynamicRange(stream, null)).toBe("HLG");
  });

  it("returns HDR10 for PQ rangeType", () => {
    const stream = { videoRangeType: "PQ" } as MediaStream;
    expect(detectDynamicRange(stream, null)).toBe("HDR10");
  });

  it("returns SDR for SDR rangeType", () => {
    const stream = { videoRangeType: "SDR" } as MediaStream;
    expect(detectDynamicRange(stream, null)).toBe("SDR");
  });

  it("returns Dolby Vision for DOVIPresent flag", () => {
    const stream = { DOVIPresent: true } as MediaStream;
    expect(detectDynamicRange(stream, null)).toBe("Dolby Vision");
  });

  it("returns HDR10+ for HDR10PlusPresent flag", () => {
    const stream = { HDR10PlusPresent: true } as MediaStream;
    expect(detectDynamicRange(stream, null)).toBe("HDR10+");
  });

  it("falls back to filename when no stream data", () => {
    expect(detectDynamicRange(undefined, "/movies/Movie.DV.mkv")).toBe("Dolby Vision");
    expect(detectDynamicRange(undefined, null)).toBe("SDR");
  });

  it("returns HDR for generic HDR rangeType", () => {
    const stream = { videoRangeType: "HDR" } as MediaStream;
    expect(detectDynamicRange(stream, null)).toBe("HDR");
  });
});

describe("detectAudioProfile (stream-based)", () => {
  it("returns Dolby Atmos from audioSpatialFormat", () => {
    const stream = { audioSpatialFormat: "DolbyAtmos" } as MediaStream;
    expect(detectAudioProfile(stream, undefined, null)).toBe("Dolby Atmos");
  });

  it("returns DTS:X from audioSpatialFormat", () => {
    const stream = { audioSpatialFormat: "DTSX" } as MediaStream;
    expect(detectAudioProfile(stream, undefined, null)).toBe("DTS:X");
  });

  it("returns Dolby Atmos from display title", () => {
    const stream = { extendedDisplayTitle: "English (TrueHD 7.1 Atmos)" } as MediaStream;
    expect(detectAudioProfile(stream, undefined, null)).toBe("Dolby Atmos");
  });

  it("returns DTS:X from display title", () => {
    const stream = { displayTitle: "English (DTS:X 7.1)" } as MediaStream;
    expect(detectAudioProfile(stream, undefined, null)).toBe("DTS:X");
  });

  it("returns DTS-HD MA from display title", () => {
    const stream = { displayTitle: "English (DTS-HD MA 5.1)" } as MediaStream;
    expect(detectAudioProfile(stream, undefined, null)).toBe("DTS-HD MA");
  });

  it("returns Dolby TrueHD from display title", () => {
    const stream = { displayTitle: "English (TrueHD 7.1)" } as MediaStream;
    expect(detectAudioProfile(stream, undefined, null)).toBe("Dolby TrueHD");
  });

  it("returns Dolby TrueHD from stream profile field", () => {
    const stream = { profile: "truehd" } as MediaStream;
    expect(detectAudioProfile(stream, undefined, null)).toBe("Dolby TrueHD");
  });

  it("returns DTS-HD MA from part audioProfile", () => {
    const part = { audioProfile: "ma" } as MediaPart;
    expect(detectAudioProfile(undefined as unknown as MediaStream, part, null)).toBe("DTS-HD MA");
  });

  it("falls back to filename when no stream/part data", () => {
    expect(detectAudioProfile(undefined, undefined, "/movies/Movie.TrueHD.Atmos.mkv")).toBe("Dolby Atmos");
    expect(detectAudioProfile(undefined, undefined, null)).toBeNull();
  });
});

describe("syncMediaServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: sync job creation
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO "SyncJob"')) {
        return [{ id: "sync-job-id" }];
      }
      if (sql.includes('UPDATE "SyncJob"')) {
        return [];
      }
      if (sql.includes('SELECT') && sql.includes('"MediaServer"')) {
        return [{
          id: "server-1",
          name: "Test Plex",
          url: "http://plex:32400",
          accessToken: "token",
          type: "PLEX",
          userId: "user-1",
          tlsSkipVerify: false,
          enabled: true,
        }];
      }
      if (sql.includes('SELECT') && sql.includes('"Library"') && sql.includes('enabled')) {
        return [];
      }
      if (sql.includes('DELETE FROM "MediaItem"')) {
        return [];
      }
      if (sql.includes('SELECT') && sql.includes('"MediaItem"') && sql.includes('thumbUrl')) {
        return [];
      }
      if (sql.includes('INSERT INTO "MediaItem"')) {
        return [];
      }
      if (sql.includes('SELECT') && sql.includes('"Library"') && sql.includes('"key"')) {
        return [];
      }
      return [];
    });

    mockClient.testConnection.mockResolvedValue({ ok: true, serverName: "Test Plex" });
    mockClient.getLibraries.mockResolvedValue([]);
    mockClient.getWatchCounts.mockResolvedValue(new Map());
  });

  it("creates a sync job and acquires semaphore", async () => {
    const { acquireSyncSlot, releaseSyncSlot } = await import("@/lib/sync/sync-semaphore");
    await syncMediaServer("server-1");
    expect(acquireSyncSlot).toHaveBeenCalled();
    expect(releaseSyncSlot).toHaveBeenCalled();
  });

  it("throws when server not found", async () => {
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO "SyncJob"')) return [{ id: "sync-job-id" }];
      if (sql.includes('UPDATE "SyncJob"')) return [];
      if (sql.includes('SELECT') && sql.includes('"MediaServer"')) return [];
      return [];
    });

    await expect(syncMediaServer("nonexistent")).rejects.toThrow("MediaServer not found");
  });

  it("cancels sync for disabled server", async () => {
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO "SyncJob"')) return [{ id: "sync-job-id" }];
      if (sql.includes('UPDATE "SyncJob"')) return [];
      if (sql.includes('SELECT') && sql.includes('"MediaServer"')) {
        return [{
          id: "server-1",
          name: "Disabled Server",
          url: "http://plex:32400",
          accessToken: "token",
          type: "PLEX",
          userId: "user-1",
          tlsSkipVerify: false,
          enabled: false,
        }];
      }
      return [];
    });

    await syncMediaServer("server-1");

    // Should have updated job status to CANCELLED (passed as $1 param)
    const cancelCalls = findDbCalls('UPDATE "SyncJob"', "CANCELLED");
    expect(cancelCalls.length).toBeGreaterThan(0);
  });

  it("syncs empty library list successfully", async () => {
    mockClient.getLibraries.mockResolvedValue([]);

    await syncMediaServer("server-1");

    // Should complete without error — sync job should be COMPLETED
    const completedCalls = findDbCalls('UPDATE "SyncJob"', "COMPLETED");
    expect(completedCalls.length).toBeGreaterThan(0);
  });

  it("skips disabled libraries", async () => {
    mockClient.getLibraries.mockResolvedValue([
      { key: "1", title: "Movies", type: "movie", agent: "", scanner: "" },
      { key: "2", title: "TV Shows", type: "show", agent: "", scanner: "" },
    ]);

    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO "SyncJob"')) return [{ id: "sync-job-id" }];
      if (sql.includes('UPDATE "SyncJob"')) return [];
      if (sql.includes('SELECT') && sql.includes('"MediaServer"')) {
        return [{
          id: "server-1",
          name: "Test Plex",
          url: "http://plex:32400",
          accessToken: "token",
          type: "PLEX",
          userId: "user-1",
          tlsSkipVerify: false,
          enabled: true,
        }];
      }
      if (sql.includes('SELECT') && sql.includes('"Library"') && sql.includes('enabled')) {
        return [{ key: "2" }]; // Library 2 is disabled
      }
      // Library upsert/sync queries
      if (sql.includes('INSERT INTO "Library"') || sql.includes('ON CONFLICT')) {
        return [{ id: "lib-1" }];
      }
      if (sql.includes('SELECT') && sql.includes('"MediaItem"') && sql.includes('thumbUrl')) {
        return [];
      }
      if (sql.includes('DELETE FROM "MediaItem"')) {
        return [];
      }
      if (sql.includes('SELECT') && sql.includes('"Library"') && sql.includes('"key"')) {
        return [];
      }
      return [];
    });

    // Mock getLibraryItemsPage for the movie library sync
    mockClient.getLibraryItemsPage.mockResolvedValue({ items: [], total: 0 });

    await syncMediaServer("server-1");
    // Should complete successfully — disabled library skipped
  });

  it("releases semaphore even on error", async () => {
    const { releaseSyncSlot } = await import("@/lib/sync/sync-semaphore");

    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO "SyncJob"')) return [{ id: "sync-job-id" }];
      if (sql.includes('UPDATE "SyncJob"')) return [];
      if (sql.includes('SELECT') && sql.includes('"MediaServer"')) {
        throw new Error("DB error");
      }
      return [];
    });

    await expect(syncMediaServer("server-1")).rejects.toThrow();
    expect(releaseSyncSlot).toHaveBeenCalled();
  });

  it("updates server name if changed", async () => {
    mockClient.testConnection.mockResolvedValue({ ok: true, serverName: "New Name" });
    mockClient.getLibraries.mockResolvedValue([]);

    await syncMediaServer("server-1");

    const nameUpdateCalls = findDbCalls('UPDATE "MediaServer"', "New Name");
    expect(nameUpdateCalls.length).toBeGreaterThan(0);
  });
});
