import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WatchHistoryProgress } from "@/lib/sync/watch-history-progress";

const {
  mockPrisma,
  mockClient,
  mockReconcile,
  mockSyncTracearr,
  mockEnqueueJob,
} = vi.hoisted(() => {
  // The DELETE + INSERTs run inside prisma.$transaction(cb) via tx.$executeRawUnsafe.
  // Route the tx's raw methods to the same fn the tests assert against so the
  // existing call-inspection (DELETE/INSERT string filters) keeps working.
  const queryRawUnsafe = vi.fn();
  const tx = { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: queryRawUnsafe };
  return {
    mockPrisma: {
      tracearrInstance: { findFirst: vi.fn() },
      // Clears the "history cleared" marker once the full replace repopulates.
      mediaServer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: queryRawUnsafe,
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    },
    mockClient: {
      getDetailedWatchHistory: vi.fn(),
    },
    mockReconcile: vi.fn(async () => 0),
    // The importer's result shape: a count, plus whether the archive walk is
    // still owed. Typed params rather than a bare `vi.fn()` so the options
    // object this file asserts on is a real, checked argument.
    mockSyncTracearr: vi.fn(
      async (
        _serverId: string,
        _options?: {
          onProgress?: unknown;
          signal?: AbortSignal;
          passes?: "forward" | "backfill" | "both";
          deadlineMs?: number;
        },
      ) => ({ count: 7, backfillPending: false }),
    ),
    mockEnqueueJob: vi.fn(
      async (_identifier: string, _payload: unknown, _spec?: unknown) => true,
    ),
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

vi.mock("@/lib/sync/sync-tracearr-history", () => ({
  syncTracearrHistory: mockSyncTracearr,
}));

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: mockEnqueueJob,
}));

import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
// Deliberately NOT mocked: `@/lib/jobs/constants` is a dependency-free module of
// string literals, and asserting against the real identifiers is what keeps the
// enqueue in step with the task the worker actually registers.
import { TASK_TRACEARR_BACKFILL, MAIN_QUEUE } from "@/lib/jobs/constants";

describe("syncWatchHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcile.mockResolvedValue(0);
    mockSyncTracearr.mockResolvedValue({ count: 7, backfillPending: false });
    mockEnqueueJob.mockResolvedValue(true);
    mockPrisma.tracearrInstance.findFirst.mockResolvedValue(null);
  });

  /** The server row the route's first raw SELECT returns. */
  function serverRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "server-1",
      name: "Test Server",
      url: "http://plex:32400",
      accessToken: "token",
      type: "PLEX",
      tlsSkipVerify: false,
      enabled: true,
      userId: "user-1",
      tracearrServerId: null,
      ...overrides,
    };
  }

  describe("watch-history source selection", () => {
    it("delegates to the Tracearr importer for a mapped server with an enabled instance", async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        serverRow({ tracearrServerId: "srv-uuid" }),
      ]);
      mockPrisma.tracearrInstance.findFirst.mockResolvedValueOnce({ id: "t1" });

      await expect(syncWatchHistory("server-1")).resolves.toEqual({ count: 7 });
      // No reporter and no signal here — the delegation forwards whatever it
      // was given, including nothing. The pass is not optional though: this
      // caller is always a foreground request or a short scheduled job, so it
      // asks for the bounded catch-up and never the archive walk.
      expect(mockSyncTracearr).toHaveBeenCalledWith("server-1", {
        onProgress: undefined,
        signal: undefined,
        passes: "forward",
      });
      expect(mockClient.getDetailedWatchHistory).not.toHaveBeenCalled();
    });

    it("skips entirely — never falls back to native — when the instance is disabled", async () => {
      // Falling back would be doubly destructive: the native path's unscoped
      // full-replace DELETEs the imported Tracearr rows, and because the
      // importer's watermark is derived from those rows, re-enabling the
      // instance then re-imports the whole history ON TOP of the NATIVE rows
      // the fallback wrote. reconcileWatchStateFromHistory counts both, and
      // MediaItem.playCount is monotonic — so every play would be permanently
      // double-counted, arming playCount-based DELETE rules across the library.
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        serverRow({ tracearrServerId: "srv-uuid" }),
      ]);
      mockPrisma.tracearrInstance.findFirst.mockResolvedValueOnce(null);

      await expect(syncWatchHistory("server-1")).resolves.toEqual({ count: 0 });
      expect(mockSyncTracearr).not.toHaveBeenCalled();
      expect(mockClient.getDetailedWatchHistory).not.toHaveBeenCalled();
      // The decisive assertion: nothing was deleted, so the imported rows survive.
      const deletes = mockPrisma.$queryRawUnsafe.mock.calls.filter((args) =>
        typeof args[0] === "string" && args[0].includes(`DELETE FROM "WatchHistory"`),
      );
      expect(deletes).toHaveLength(0);
    });

    it("uses the native path for an unmapped server", async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([serverRow()]);
      mockClient.getDetailedWatchHistory.mockResolvedValueOnce([]);
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

      await syncWatchHistory("server-1");
      expect(mockSyncTracearr).not.toHaveBeenCalled();
      expect(mockClient.getDetailedWatchHistory).toHaveBeenCalled();
    });
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

  describe("progress reporting", () => {
    /** A reporter that records every emission. */
    function progressRecorder() {
      const updates: WatchHistoryProgress[] = [];
      return {
        updates,
        report: (update: WatchHistoryProgress) => updates.push(update),
      };
    }

    /** `n` matched entries, plus the media-item rows they resolve against. */
    function armEntries(count: number) {
      mockClient.getDetailedWatchHistory.mockResolvedValueOnce(
        Array.from({ length: count }, (_, i) => ({
          ratingKey: String(i),
          username: "Admin",
          watchedAt: `2025-07-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
          deviceName: "Roku",
          platform: "Roku",
        })),
      );
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(
        Array.from({ length: count }, (_, i) => ({
          id: `item-${i}`,
          ratingKey: String(i),
        })),
      );
    }

    it("forwards the reporter to the Tracearr importer", async () => {
      const { report } = progressRecorder();
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        serverRow({ tracearrServerId: "srv-uuid" }),
      ]);
      mockPrisma.tracearrInstance.findFirst.mockResolvedValueOnce({ id: "t1" });

      await syncWatchHistory("server-1", report);

      // Both provenances report the same shape so a mixed set of servers
      // renders one coherent bar; the branch must not swallow the reporter.
      expect(mockSyncTracearr).toHaveBeenCalledWith(
        "server-1",
        expect.objectContaining({ onProgress: report, passes: "forward" }),
      );
    });

    it("names the server it is waiting on before the fetch, with no fraction", async () => {
      const { updates, report } = progressRecorder();
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([serverRow()]);
      mockClient.getDetailedWatchHistory.mockResolvedValueOnce([]);
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE

      await syncWatchHistory("server-1", report);

      // Indeterminate on purpose: the fetch is one server-wide scan with no
      // observable sub-steps, and the total does not exist until it returns.
      expect(updates[0]).toEqual({
        imported: 0,
        detail: "Fetching watch history from Test Server…",
      });
      expect(updates[0].fraction).toBeUndefined();
    });

    it("reports a rising determinate fraction that ends at 1 while writing", async () => {
      const { updates, report } = progressRecorder();
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([serverRow()]);
      armEntries(600); // BATCH_SIZE is 500 → two batches
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // INSERT batch 1
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // INSERT batch 2

      await expect(syncWatchHistory("server-1", report)).resolves.toEqual({
        count: 600,
      });

      // This is the one place a real percentage is honest — the fetch has
      // returned, so the denominator is a counted set of play events.
      const batches = updates.filter((u) => u.fraction !== undefined);
      expect(batches).toEqual([
        { imported: 500, fraction: 500 / 600, detail: "Stored 500 of 600 plays" },
        { imported: 600, fraction: 1, detail: "Stored 600 of 600 plays" },
      ]);
      const fractions = batches.map((u) => u.fraction!);
      expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
      expect(fractions.at(-1)).toBe(1);
    });

    it("advances over entries rather than rows, so unmatched plays still finish at 1", async () => {
      const { updates, report } = progressRecorder();
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([serverRow()]);
      mockClient.getDetailedWatchHistory.mockResolvedValueOnce([
        { ratingKey: "100", username: "Admin", watchedAt: "2025-07-01T00:00:00Z", deviceName: null, platform: null },
        { ratingKey: "200", username: "Admin", watchedAt: "2025-07-02T00:00:00Z", deviceName: null, platform: null },
        // No MediaItem for this one — work done, but no row written.
        { ratingKey: "999", username: "Admin", watchedAt: "2025-07-03T00:00:00Z", deviceName: null, platform: null },
      ]);
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: "item-1", ratingKey: "100" },
        { id: "item-2", ratingKey: "200" },
      ]);
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // INSERT

      await expect(syncWatchHistory("server-1", report)).resolves.toEqual({
        count: 2,
      });

      // Counting rows instead would leave a server with unmatched plays stuck
      // short of 100% forever.
      expect(updates.at(-1)).toEqual({
        imported: 2,
        fraction: 1,
        detail: "Stored 2 of 3 plays",
      });
    });

    it("keeps the progress reported before a failed fetch, and does not throw", async () => {
      const { updates, report } = progressRecorder();
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([serverRow()]);
      mockClient.getDetailedWatchHistory.mockRejectedValueOnce(
        new Error("ECONNREFUSED"),
      );

      // The sync bails out without the destructive full-replace, and the one
      // emission the user already saw stands rather than being retracted.
      await expect(syncWatchHistory("server-1", report)).resolves.toEqual({
        count: 0,
      });
      expect(updates).toEqual([
        { imported: 0, detail: "Fetching watch history from Test Server…" },
      ]);
    });

    it("syncs identically when no reporter is passed", async () => {
      // The dispatcher and the realtime watch-changed job both omit it, so
      // progress must be pure observation.
      const arm = () => {
        mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([serverRow()]);
        armEntries(3);
        mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE
        mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // INSERT
      };

      arm();
      const reported = await syncWatchHistory("server-1", vi.fn());
      const reportedSql = mockPrisma.$queryRawUnsafe.mock.calls.map(
        (args) => args[0],
      );
      const reportedReconciles = mockReconcile.mock.calls.length;

      // `clearAllMocks` drops the recorded calls but keeps the `beforeEach`
      // implementations, so the second run starts from the same state.
      vi.clearAllMocks();
      arm();
      const silent = await syncWatchHistory("server-1");

      expect(silent).toEqual(reported);
      expect(mockPrisma.$queryRawUnsafe.mock.calls.map((args) => args[0])).toEqual(
        reportedSql,
      );
      expect(mockReconcile.mock.calls.length).toBe(reportedReconciles);
    });
  });

  describe("cancellation", () => {
    /** SQL statements of a given kind that were actually issued. */
    function statements(kind: "DELETE" | "INSERT") {
      const needle =
        kind === "DELETE"
          ? 'DELETE FROM "WatchHistory"'
          : 'INSERT INTO "WatchHistory"';
      return mockPrisma.$queryRawUnsafe.mock.calls.filter(
        (args) => typeof args[0] === "string" && (args[0] as string).includes(needle),
      );
    }

    /** `n` matched entries plus the MediaItem rows their ratingKeys resolve to. */
    function armEntries(count: number) {
      mockClient.getDetailedWatchHistory.mockResolvedValueOnce(
        Array.from({ length: count }, (_, i) => ({
          ratingKey: String(i),
          username: "Admin",
          watchedAt: "2025-07-01T00:00:00Z",
          deviceName: "Roku",
          platform: "Roku",
        })),
      );
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(
        Array.from({ length: count }, (_, i) => ({
          id: `item-${i}`,
          ratingKey: String(i),
        })),
      );
    }

    /**
     * Runs the callback the way Prisma does and records whether it rejected —
     * which is precisely the condition under which Prisma rolls the
     * transaction back rather than committing it.
     */
    function watchTransaction() {
      const state = { rolledBack: false };
      const tx = {
        $queryRawUnsafe: mockPrisma.$queryRawUnsafe,
        $executeRawUnsafe: mockPrisma.$executeRawUnsafe,
      };
      mockPrisma.$transaction.mockImplementationOnce(
        async (cb: (t: typeof tx) => Promise<unknown>) => {
          try {
            return await cb(tx);
          } catch (error) {
            state.rolledBack = true;
            throw error;
          }
        },
      );
      return state;
    }

    it("throws out of the transaction when cancelled mid-write, so the full replace rolls back", async () => {
      const controller = new AbortController();
      const tx = watchTransaction();

      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([serverRow()]);
      armEntries(600); // BATCH_SIZE is 500 → two batches
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE
      // The user hits Stop while the first batch is in flight.
      mockPrisma.$queryRawUnsafe.mockImplementationOnce(async () => {
        controller.abort();
        return [];
      });

      // The deliberate opposite of the Tracearr path, which BREAKS and keeps
      // its rows. This loop runs inside the full-replace transaction, which has
      // already DELETEd the server's history — breaking here would commit a
      // partially-rewritten history and silently lose every play that had not
      // been re-inserted yet. Throwing rolls the whole thing back, so a
      // cancelled native sync leaves the previous history exactly as it was.
      await expect(
        syncWatchHistory("server-1", undefined, controller.signal),
      ).rejects.toThrow("Watch history sync cancelled");

      // It escaped the transaction callback — Prisma's rollback point.
      expect(tx.rolledBack).toBe(true);
      // Batch 2 was never attempted: the check is at the top of the loop.
      expect(statements("INSERT")).toHaveLength(1);
      // ...and nothing downstream of the transaction ran.
      expect(mockReconcile).not.toHaveBeenCalled();
    });

    it("throws after the DELETE rather than committing an emptied history", async () => {
      const controller = new AbortController();
      controller.abort();
      const tx = watchTransaction();

      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([serverRow()]);
      armEntries(3);
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE

      await expect(
        syncWatchHistory("server-1", undefined, controller.signal),
      ).rejects.toThrow("Watch history sync cancelled");

      // The worst possible moment to stop: the wipe has been issued and not one
      // row has been written back. Committing here would leave the server with
      // no history at all, and because the native path is a full replace there
      // is nothing to resume from — only the rollback saves it.
      expect(statements("DELETE")).toHaveLength(1);
      expect(statements("INSERT")).toHaveLength(0);
      expect(tx.rolledBack).toBe(true);
    });

    it("forwards the signal to the Tracearr importer", async () => {
      const controller = new AbortController();
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        serverRow({ tracearrServerId: "srv-uuid" }),
      ]);
      mockPrisma.tracearrInstance.findFirst.mockResolvedValueOnce({ id: "t1" });

      await syncWatchHistory("server-1", undefined, controller.signal);

      // Without this the Stop button would be inert for exactly the sync it
      // exists for: a first Tracearr import walks ~1,600 pages, and the route's
      // own `signal.aborted` check only runs BETWEEN servers.
      expect(mockSyncTracearr).toHaveBeenCalledWith(
        "server-1",
        expect.objectContaining({
          signal: controller.signal,
          passes: "forward",
        }),
      );
    });
  });

  /**
   * Tracearr serves history newest-first, so importing an archive means walking
   * ~1,600 sequential pages backwards. That walk cannot live in this function:
   * every caller is either a foreground request that dies with the tab or a
   * scheduled job that should stay short. So this path takes the bounded forward
   * pass itself and hands the archive to the durable queue, which slices it and
   * re-enqueues under the same jobKey until the oldest play is reached.
   */
  describe("backfill hand-off", () => {
    /** A Tracearr-mapped server whose instance is present and enabled. */
    function armTracearrServer() {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        serverRow({ tracearrServerId: "srv-uuid" }),
      ]);
      mockPrisma.tracearrInstance.findFirst.mockResolvedValueOnce({ id: "t1" });
    }

    it("asks the importer for the forward pass only, with no backfill options", async () => {
      armTracearrServer();

      await syncWatchHistory("server-1");

      const options = mockSyncTracearr.mock.calls[0][1];
      expect(options?.passes).toBe("forward");
      // The archive walk belongs to the job, which owns its own time slice.
      // Handing a deadline down from here would instead cap the catch-up — the
      // one pass that must always run to completion.
      expect(options?.deadlineMs).toBeUndefined();
    });

    it("queues the durable backfill when the importer says one is owed", async () => {
      armTracearrServer();
      mockSyncTracearr.mockResolvedValueOnce({ count: 3, backfillPending: true });

      await syncWatchHistory("server-1");

      expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
      expect(mockEnqueueJob).toHaveBeenCalledWith(
        TASK_TRACEARR_BACKFILL,
        { serverId: "server-1" },
        {
          // jobKey-deduped, so a user hammering Refresh — or a Refresh racing
          // the per-minute dispatcher — collapses onto one queued backfill
          // instead of stacking a walk per trigger.
          jobKey: "tracearr-backfill:server-1",
          // Serial with the other heavy domain jobs. The time slice, not the
          // queue, is what stops it monopolising them.
          queueName: MAIN_QUEUE,
          maxAttempts: 3,
        },
      );
    });

    it("still queues once the history is fully backfilled, for the re-add recovery", async () => {
      armTracearrServer();
      mockSyncTracearr.mockResolvedValueOnce({
        count: 2,
        backfillPending: false,
      });

      await syncWatchHistory("server-1");

      // This looks like wasted work and is not. The backfill task does double
      // duty: it takes another slice while the archive walk is unfinished, and
      // once it IS finished it runs the pass that recovers a re-added item's
      // watch history. Gating the enqueue on `backfillPending` made that second
      // job unreachable — the flag latches false forever once the walk
      // completes, so the recovery pass ran exactly once per server, in the very
      // slice that finished the walk, before any re-add could have happened. An
      // item re-added a month later then stayed at `playCount 0` /
      // `lastPlayedAt null` and was eligible for a DELETE rule.
      //
      // The cost of getting this right is one jobKey-deduped job whose walk does
      // nothing and whose recovery pass is a single indexed query when there are
      // no recent additions.
      expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
      expect(mockEnqueueJob).toHaveBeenCalledWith(
        TASK_TRACEARR_BACKFILL,
        { serverId: "server-1" },
        expect.objectContaining({ jobKey: "tracearr-backfill:server-1" }),
      );
    });

    it("returns the unchanged { count } shape whatever the backfill state", async () => {
      armTracearrServer();
      mockSyncTracearr.mockResolvedValueOnce({
        count: 42,
        backfillPending: true,
      });

      // Every caller — the sync engine, the streaming History route, the queued
      // watch-history task — reads `.count` and nothing else. `backfillPending`
      // is a signal for this function, not part of its own contract.
      await expect(syncWatchHistory("server-1")).resolves.toEqual({ count: 42 });
    });

    it("never queues a backfill for a natively-synced server", async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([serverRow()]);
      mockClient.getDetailedWatchHistory.mockResolvedValueOnce([
        {
          ratingKey: "100",
          username: "Admin",
          watchedAt: "2025-07-01T00:00:00Z",
          deviceName: null,
          platform: null,
        },
      ]);
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: "item-1", ratingKey: "100" },
      ]);
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // DELETE
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // INSERT

      await expect(syncWatchHistory("server-1")).resolves.toEqual({ count: 1 });

      // There is no Tracearr archive to walk here, so a queued slice would wake
      // up on the serial queue, find no mapping and do nothing — once per sync,
      // for the life of the install.
      expect(mockSyncTracearr).not.toHaveBeenCalled();
      expect(mockEnqueueJob).not.toHaveBeenCalled();
    });
  });

  describe("establishing the watch-history marker", () => {
    // `MediaServer.watchHistorySyncedAt` records that a sync established what
    // was played on a server; `checkWatchHistoryCompleteness` reads it to pause
    // every play-activity criterion while it is null. Nothing else sets it for
    // a native server, so every successful full replace has to — a guard that
    // never releases is its own outage.
    function serverRow() {
      return [{
        id: "server-1",
        name: "Test Server",
        url: "http://plex:32400",
        accessToken: "token",
        type: "PLEX",
        tlsSkipVerify: false,
        enabled: true,
      }];
    }

    function establishCalls() {
      return mockPrisma.mediaServer.updateMany.mock.calls.filter(
        (args) =>
          (args[0] as { data?: Record<string, unknown> }).data
            ?.watchHistorySyncedAt instanceof Date,
      );
    }

    it("sets it after a normal full replace", async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(serverRow());
      mockClient.getDetailedWatchHistory.mockResolvedValueOnce([
        { ratingKey: "100", username: "Admin", watchedAt: "2024-01-01T00:00:00Z", deviceName: null, platform: null },
      ]);
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: "item-1", ratingKey: "100" }]);

      await syncWatchHistory("server-1");

      expect(establishCalls()).toHaveLength(1);
    });

    it("sets it when the server legitimately reports no plays at all", async () => {
      // The hole, and the reason "a server nobody watches" has to settle: a
      // genuinely empty native history — a fresh Plex, or Jellyfin degrading to
      // a per-user response — took an early return that deleted the rows and
      // never marked the history established. Every play-activity rule set
      // scoped to that server then stayed paused forever, silently.
      //
      // This IS a successful full replace: the fetch throws on a hard failure,
      // so reaching here means the server's answer is "no plays", which is a
      // complete and faithful record of its history.
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(serverRow());
      mockClient.getDetailedWatchHistory.mockResolvedValueOnce([]);

      await expect(syncWatchHistory("server-1")).resolves.toEqual({ count: 0 });

      expect(establishCalls()).toHaveLength(1);
    });

    it("leaves it unset when the fetch failed, because the history is still unknown", async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(serverRow());
      mockClient.getDetailedWatchHistory.mockRejectedValueOnce(new Error("plex down"));

      await expect(syncWatchHistory("server-1")).resolves.toEqual({ count: 0 });

      expect(establishCalls()).toHaveLength(0);
    });
  });

});
