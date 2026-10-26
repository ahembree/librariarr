import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({ mediaItem: { findMany: vi.fn() } }));
const mockSyncMediaServer = vi.hoisted(() => vi.fn());
const mockSyncMediaServerItems = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));
vi.mock("@/lib/sync/sync-server", () => ({ syncMediaServer: mockSyncMediaServer }));
vi.mock("@/lib/sync/sync-incremental", () => ({ syncMediaServerItems: mockSyncMediaServerItems }));

import {
  PostDeleteResync,
  POST_DELETE_INCREMENTAL_LIMIT,
  POST_DELETE_SYNC_TRIGGER,
} from "@/lib/lifecycle/post-delete-resync";

const movie = (id: string, server = "s1", key = "1") => ({
  id,
  libraryId: `lib-${server}-${key}`,
  parentTitle: null,
  seriesKey: null,
  fileSize: null,
  externalIds: [],
  library: { key, mediaServerId: server },
});

const episode = (id: string) => ({
  id,
  libraryId: "lib-tv",
  parentTitle: "Lost",
  seriesKey: "tvdb:1",
  fileSize: null,
  externalIds: [],
  library: { key: "2", mediaServerId: "s1" },
});

/** The rows `run` reads back: rating key `rk-<id>` in the given library. */
function rowsFor(ids: Array<[string, string, string]>) {
  return ids.map(([id, server, key]) => ({ ratingKey: `rk-${id}`, library: { key, mediaServerId: server } }));
}

const fullSync = (server: string, key: string) => [
  server,
  key,
  { trigger: POST_DELETE_SYNC_TRIGGER, skipWatchHistory: true },
];

beforeEach(() => {
  vi.resetAllMocks();
  mockSyncMediaServer.mockResolvedValue(undefined);
  mockSyncMediaServerItems.mockResolvedValue({ status: "done", upserted: 0, deleted: 1 });
});

describe("PostDeleteResync", () => {
  it("does nothing when no destructive action ran", async () => {
    const resync = new PostDeleteResync();
    await resync.record("UNMONITOR_RADARR", movie("m1"), []);
    await resync.record("DELETE_RADARR", { ...movie("m2"), library: null }, []);
    await resync.run();
    expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    expect(mockSyncMediaServerItems).not.toHaveBeenCalled();
    expect(mockSyncMediaServer).not.toHaveBeenCalled();
  });

  it("asks each server about its deleted items once, by rating key", async () => {
    const resync = new PostDeleteResync();
    await resync.record("DELETE_RADARR", movie("m1"), []);
    await resync.record("DELETE_FILES_RADARR", movie("m2"), []);
    await resync.record("DELETE_RADARR", movie("m3", "s2"), []);
    mockPrisma.mediaItem.findMany.mockResolvedValue(
      rowsFor([["m1", "s1", "1"], ["m2", "s1", "1"], ["m3", "s2", "1"]]),
    );

    await resync.run();

    expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.mediaItem.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["m1", "m2", "m3"] } });
    expect(mockSyncMediaServerItems.mock.calls).toEqual([
      ["s1", ["rk-m1", "rk-m2"], []],
      ["s2", ["rk-m3"], []],
    ]);
    expect(mockSyncMediaServer).not.toHaveBeenCalled();
  });

  it("includes the members an episode-file delete acted on, and the ones it reports deleted", async () => {
    const resync = new PostDeleteResync();
    await resync.record("DELETE_FILES_SONARR", episode("e1"), ["e1", "e2"], { deletedMemberIds: ["e2", "e3"] });
    mockPrisma.mediaItem.findMany.mockResolvedValue(rowsFor([["e1", "s1", "2"], ["e2", "s1", "2"], ["e3", "s1", "2"]]));

    await resync.run();

    expect(new Set(mockPrisma.mediaItem.findMany.mock.calls[0][0].where.id.in)).toEqual(new Set(["e1", "e2", "e3"]));
    expect(mockSyncMediaServerItems).toHaveBeenCalledWith("s1", ["rk-e1", "rk-e2", "rk-e3"], []);
  });

  it("names every episode of a whole-show delete", async () => {
    const resync = new PostDeleteResync();
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([{ id: "e1" }, { id: "e2" }, { id: "e9" }]);
    await resync.record("DELETE_SONARR", episode("e1"), []);

    // The group is the show in the item's library, as the deleted bytes count it.
    expect(mockPrisma.mediaItem.findMany.mock.calls[0][0]).toEqual({
      where: { type: "SERIES", libraryId: "lib-tv", seriesKey: "tvdb:1" },
      select: { id: true },
      take: POST_DELETE_INCREMENTAL_LIMIT + 1,
    });

    mockPrisma.mediaItem.findMany.mockResolvedValueOnce(rowsFor([["e1", "s1", "2"], ["e2", "s1", "2"], ["e9", "s1", "2"]]));
    await resync.run();
    expect(mockSyncMediaServerItems).toHaveBeenCalledWith("s1", ["rk-e1", "rk-e2", "rk-e9"], []);
  });

  it("syncs the library in full for a show too large to name", async () => {
    const resync = new PostDeleteResync();
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce(
      Array.from({ length: POST_DELETE_INCREMENTAL_LIMIT + 1 }, (_, i) => ({ id: `e${i}` })),
    );
    await resync.record("DELETE_SONARR", episode("e0"), []);
    // A second delete in the same library adds nothing to read.
    await resync.record("DELETE_FILES_SONARR", episode("e5"), ["e5"]);
    expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledTimes(1);

    await resync.run();

    expect(mockSyncMediaServerItems).not.toHaveBeenCalled();
    expect(mockSyncMediaServer.mock.calls).toEqual([fullSync("s1", "2")]);
  });

  it("syncs the library in full when the group cannot be read", async () => {
    const resync = new PostDeleteResync();
    mockPrisma.mediaItem.findMany.mockRejectedValueOnce(new Error("db hiccup"));
    await resync.record("DELETE_LIDARR", { ...episode("t1"), library: { key: "3", mediaServerId: "s1" } }, []);

    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([]);
    await resync.run();

    expect(mockSyncMediaServer.mock.calls).toEqual([fullSync("s1", "3")]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("syncs the libraries in full past the limit, or when the re-check falls back or throws", async () => {
    // Past the limit across one server's libraries.
    const many = new PostDeleteResync();
    for (let i = 0; i <= POST_DELETE_INCREMENTAL_LIMIT; i++) await many.record("DELETE_RADARR", movie(`m${i}`, "s1", i % 2 ? "1" : "4"), []);
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce(
      Array.from({ length: POST_DELETE_INCREMENTAL_LIMIT + 1 }, (_, i) => ({
        ratingKey: `rk${i}`,
        library: { key: i % 2 ? "1" : "4", mediaServerId: "s1" },
      })),
    );
    await many.run();
    expect(mockSyncMediaServerItems).not.toHaveBeenCalled();
    expect(new Set(mockSyncMediaServer.mock.calls.map((c) => c[1]))).toEqual(new Set(["1", "4"]));

    // Fell back.
    mockSyncMediaServer.mockClear();
    const fellBack = new PostDeleteResync();
    await fellBack.record("DELETE_RADARR", movie("m1"), []);
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce(rowsFor([["m1", "s1", "1"]]));
    mockSyncMediaServerItems.mockResolvedValueOnce({ status: "fell-back", upserted: 0, deleted: 0, reason: "fetch failed" });
    await fellBack.run();
    expect(mockSyncMediaServer.mock.calls).toEqual([fullSync("s1", "1")]);

    // Threw.
    mockSyncMediaServer.mockClear();
    const threw = new PostDeleteResync();
    await threw.record("DELETE_RADARR", movie("m1"), []);
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce(rowsFor([["m1", "s1", "1"]]));
    mockSyncMediaServerItems.mockRejectedValueOnce(new Error("boom"));
    await threw.run();
    expect(mockSyncMediaServer.mock.calls).toEqual([fullSync("s1", "1")]);
  });

  it("leaves a run the incremental sync skipped to the sync that covers it", async () => {
    const resync = new PostDeleteResync();
    await resync.record("DELETE_RADARR", movie("m1"), []);
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce(rowsFor([["m1", "s1", "1"]]));
    mockSyncMediaServerItems.mockResolvedValueOnce({ status: "skipped", upserted: 0, deleted: 0, reason: "full sync in progress" });

    await resync.run();

    expect(mockSyncMediaServer).not.toHaveBeenCalled();
  });

  it("asks a member's own server about it, and syncs every recorded library when the rows cannot be read", async () => {
    const resync = new PostDeleteResync();
    // A member that is another server's copy.
    await resync.record("DELETE_FILES_SONARR", episode("e1"), ["e1", "copy"]);
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      ...rowsFor([["e1", "s1", "2"]]),
      { ratingKey: "rk-copy", library: { key: "7", mediaServerId: "s2" } },
    ]);
    await resync.run();
    expect(mockSyncMediaServerItems.mock.calls).toEqual([
      ["s1", ["rk-e1"], []],
      ["s2", ["rk-copy"], []],
    ]);

    const unreadable = new PostDeleteResync();
    await unreadable.record("DELETE_RADARR", movie("m1"), []);
    await unreadable.record("DELETE_RADARR", movie("m2", "s2", "5"), []);
    mockPrisma.mediaItem.findMany.mockRejectedValueOnce(new Error("db down"));
    await unreadable.run();
    expect(mockSyncMediaServer.mock.calls).toEqual([fullSync("s1", "1"), fullSync("s2", "5")]);
  });

  it("logs a failed library sync and goes on with the next", async () => {
    const resync = new PostDeleteResync();
    mockPrisma.mediaItem.findMany.mockRejectedValueOnce(new Error("db down"));
    await resync.record("DELETE_RADARR", movie("m1"), []);
    await resync.record("DELETE_RADARR", movie("m2", "s1", "9"), []);
    mockSyncMediaServer.mockRejectedValueOnce(new Error("plex down"));

    await expect(resync.run()).resolves.toBeUndefined();

    expect(mockSyncMediaServer).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Lifecycle",
      expect.stringContaining("Failed to sync library 1 on server s1"),
      expect.any(Object),
    );
  });
});
