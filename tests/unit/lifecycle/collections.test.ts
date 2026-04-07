import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  library: { findMany: vi.fn() },
  lifecycleAction: { findMany: vi.fn() },
  ruleSet: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  ruleMatch: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
}));

const mockPlexClient = vi.hoisted(() => ({
  getCollections: vi.fn(),
  createCollection: vi.fn(),
  getCollectionItems: vi.fn(),
  addCollectionItems: vi.fn(),
  removeCollectionItem: vi.fn(),
  deleteCollection: vi.fn(),
  editCollectionSortTitle: vi.fn(),
  editCollectionSort: vi.fn(),
  updateCollectionVisibility: vi.fn(),
  moveCollectionItem: vi.fn(),
  getLibraryItems: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/plex/client", () => ({
  PlexClient: function () { return mockPlexClient; },
}));

import { syncPlexCollection, removePlexCollection } from "@/lib/lifecycle/collections";

function makeRuleSet(overrides = {}) {
  return {
    id: "rs1",
    userId: "u1",
    type: "MOVIE",
    seriesScope: false,
    collectionName: "Test Collection",
    collectionSortName: null,
    collectionHomeScreen: false,
    collectionRecommended: false,
    collectionSort: "ALPHABETICAL",
    ...overrides,
  };
}

const defaultServer = {
  id: "s1",
  url: "http://plex",
  accessToken: "token",
  machineId: "machine1",
  type: "PLEX",
  tlsSkipVerify: false,
};

describe("syncPlexCollection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when collectionName is null", async () => {
    await syncPlexCollection(makeRuleSet({ collectionName: null }), []);
    expect(mockPrisma.library.findMany).not.toHaveBeenCalled();
  });

  it("creates a new collection when none exists", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    await syncPlexCollection(makeRuleSet(), [
      { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
    ]);

    expect(mockPlexClient.createCollection).toHaveBeenCalledWith(
      "1", "Test Collection", "machine1", ["rk1"], 1,
    );
  });

  it("syncs items in existing collection — adds missing, removes extras", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Test Collection" },
    ]);
    mockPlexClient.getCollectionItems.mockResolvedValue([
      { ratingKey: "rk1" }, // existing, should stay
      { ratingKey: "rk_extra" }, // not in desired, should be removed
    ]);
    mockPlexClient.addCollectionItems.mockResolvedValue(undefined);
    mockPlexClient.removeCollectionItem.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    await syncPlexCollection(makeRuleSet(), [
      { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
      { libraryId: "lib1", ratingKey: "rk_new", title: "Movie 2", parentTitle: null },
    ]);

    expect(mockPlexClient.addCollectionItems).toHaveBeenCalledWith("col1", "machine1", ["rk_new"]);
    expect(mockPlexClient.removeCollectionItem).toHaveBeenCalledWith("col1", "rk_extra");
  });

  it("deletes empty collection when no items remain", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Test Collection" },
    ]);
    mockPlexClient.getCollectionItems.mockResolvedValue([
      { ratingKey: "rk_old" },
    ]);
    mockPlexClient.removeCollectionItem.mockResolvedValue(undefined);
    mockPlexClient.deleteCollection.mockResolvedValue(undefined);

    // No matched items for this library
    await syncPlexCollection(makeRuleSet(), []);

    expect(mockPlexClient.deleteCollection).toHaveBeenCalledWith("col1");
  });

  it("skips when no collection exists and no items to add", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);

    await syncPlexCollection(makeRuleSet(), []);

    expect(mockPlexClient.createCollection).not.toHaveBeenCalled();
  });

  it("uses map lookup instead of per-iteration DB query (N+1 fix)", async () => {
    // Two libraries, items in one
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies 1", mediaServer: defaultServer, mediaServerId: "s1" },
      { id: "lib2", key: "2", title: "Movies 2", mediaServer: { ...defaultServer, id: "s2" }, mediaServerId: "s2" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    await syncPlexCollection(makeRuleSet(), [
      { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
    ]);

    // findMany should only be called once (not per library iteration)
    expect(mockPrisma.library.findMany).toHaveBeenCalledTimes(1);
  });

  it("resolves series-scope items via Plex library items", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "TV Shows", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.getLibraryItems.mockResolvedValue([
      { title: "Breaking Bad", ratingKey: "series-rk-1" },
      { title: "Better Call Saul", ratingKey: "series-rk-2" },
    ]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    await syncPlexCollection(
      makeRuleSet({ type: "SERIES", seriesScope: true }),
      [
        { libraryId: "lib1", ratingKey: "ep-rk-1", title: "Ep 1", parentTitle: "Breaking Bad" },
      ],
    );

    // Should use the series-level ratingKey, not the episode one
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith(
      "1", "Test Collection", "machine1", ["series-rk-1"], 2,
    );
  });

  it("uses plexItemsCache for series-scope lookups", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "TV Shows", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    const cache = new Map([
      ["1", [{ title: "Cached Show", ratingKey: "cached-rk" }]],
    ]);

    await syncPlexCollection(
      makeRuleSet({ type: "SERIES", seriesScope: true }),
      [
        { libraryId: "lib1", ratingKey: "ep-rk", title: "Ep 1", parentTitle: "Cached Show" },
      ],
      cache,
    );

    // Should NOT call getLibraryItems since cache has the key
    expect(mockPlexClient.getLibraryItems).not.toHaveBeenCalled();
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith(
      "1", "Test Collection", "machine1", ["cached-rk"], 2,
    );
  });

  it("sets DELETION_DATE sort order and reorders items", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);
    mockPlexClient.moveCollectionItem.mockResolvedValue(undefined);

    // Return current rule set for deletion date ordering query
    mockPrisma.ruleSet.findMany.mockResolvedValue([{ id: "rs1" }]);

    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        scheduledFor: new Date("2025-01-10"),
        mediaItem: { ratingKey: "rk2", parentTitle: null, title: "Movie 2" },
      },
      {
        scheduledFor: new Date("2025-01-05"),
        mediaItem: { ratingKey: "rk1", parentTitle: null, title: "Movie 1" },
      },
    ]);

    await syncPlexCollection(
      makeRuleSet({ collectionSort: "DELETION_DATE" }),
      [
        { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk2", title: "Movie 2", parentTitle: null },
      ],
    );

    // Sort mode 2 = custom
    expect(mockPlexClient.editCollectionSort).toHaveBeenCalledWith("col1", 2);
    // rk1 has earlier date, should be first
    expect(mockPlexClient.moveCollectionItem).toHaveBeenCalledTimes(2);
    expect(mockPlexClient.moveCollectionItem).toHaveBeenCalledWith("col1", "rk1", undefined);
    expect(mockPlexClient.moveCollectionItem).toHaveBeenCalledWith("col1", "rk2", "rk1");
  });

  it("syncs visibility settings", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    await syncPlexCollection(
      makeRuleSet({ collectionHomeScreen: true, collectionRecommended: true }),
      [
        { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
      ],
    );

    expect(mockPlexClient.updateCollectionVisibility).toHaveBeenCalledWith(
      "1", "col1", true, true, true,
    );
  });

  it("skips library without machineId", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: { ...defaultServer, machineId: null }, mediaServerId: "s1" },
    ]);

    await syncPlexCollection(makeRuleSet(), [
      { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
    ]);

    expect(mockPlexClient.getCollections).not.toHaveBeenCalled();
  });

  it("handles MUSIC type with plexType 2", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Music", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    await syncPlexCollection(
      makeRuleSet({ type: "MUSIC" }),
      [
        { libraryId: "lib1", ratingKey: "rk1", title: "Artist", parentTitle: null },
      ],
    );

    // MUSIC type = 2 (not MOVIE = 1)
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith(
      "1", "Test Collection", "machine1", ["rk1"], 2,
    );
  });

  it("handles errors per library without aborting", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies 1", mediaServer: defaultServer, mediaServerId: "s1" },
      { id: "lib2", key: "2", title: "Movies 2", mediaServer: { ...defaultServer, id: "s2" }, mediaServerId: "s2" },
    ]);
    mockPlexClient.getCollections
      .mockRejectedValueOnce(new Error("Plex error"))
      .mockResolvedValueOnce([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col2", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    // Items in both libraries — lib1 will error, lib2 should still succeed
    await syncPlexCollection(makeRuleSet(), [
      { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
      { libraryId: "lib2", ratingKey: "rk2", title: "Movie 2", parentTitle: null },
    ]);

    // Second library should still be processed
    expect(mockPlexClient.createCollection).toHaveBeenCalled();
  });

  it("merges items from sibling rule sets sharing the same collection name", async () => {
    // Sibling rule set returns matched items
    mockPrisma.ruleSet.findMany.mockResolvedValue([{ id: "rs2", seriesScope: false }]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { mediaItem: { libraryId: "lib1", ratingKey: "rk_sibling", title: "Sibling Movie", parentTitle: null } },
    ]);

    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    await syncPlexCollection(makeRuleSet(), [
      { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
    ]);

    // Collection should contain both the current rule set's item and the sibling's item
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith(
      "1", "Test Collection", "machine1", ["rk1", "rk_sibling"], 1,
    );
  });

  it("deduplicates items when sibling rule set matches the same item", async () => {
    // Sibling returns the same item as the current rule set
    mockPrisma.ruleSet.findMany.mockResolvedValue([{ id: "rs2", seriesScope: false }]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { mediaItem: { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null } },
    ]);

    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
    mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
    mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);

    await syncPlexCollection(makeRuleSet(), [
      { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
    ]);

    // Should only have one copy of rk1, not two
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith(
      "1", "Test Collection", "machine1", ["rk1"], 1,
    );
  });
});

describe("removePlexCollection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes collection from all user libraries", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Old Collection" },
    ]);
    mockPlexClient.deleteCollection.mockResolvedValue(undefined);

    await removePlexCollection("u1", "MOVIE", "Old Collection");

    expect(mockPlexClient.deleteCollection).toHaveBeenCalledWith("col1");
  });

  it("skips library when collection does not exist", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Different Collection" },
    ]);

    await removePlexCollection("u1", "MOVIE", "Missing Collection");

    expect(mockPlexClient.deleteCollection).not.toHaveBeenCalled();
  });

  it("skips library without machineId", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: { ...defaultServer, machineId: null } },
    ]);

    await removePlexCollection("u1", "MOVIE", "Collection");

    expect(mockPlexClient.getCollections).not.toHaveBeenCalled();
  });

  it("handles errors per library without aborting", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies 1", mediaServer: defaultServer },
      { id: "lib2", key: "2", title: "Movies 2", mediaServer: { ...defaultServer, id: "s2" } },
    ]);
    mockPlexClient.getCollections
      .mockRejectedValueOnce(new Error("Plex error"))
      .mockResolvedValueOnce([{ ratingKey: "col2", title: "Target" }]);
    mockPlexClient.deleteCollection.mockResolvedValue(undefined);

    // Should not throw
    await removePlexCollection("u1", "MOVIE", "Target");

    // Second library should still be processed
    expect(mockPlexClient.deleteCollection).toHaveBeenCalledWith("col2");
  });

  it("skips removal when other rule sets still share the collection name", async () => {
    mockPrisma.ruleSet.count.mockResolvedValue(1); // 1 sibling still uses this collection

    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer },
    ]);

    await removePlexCollection("u1", "MOVIE", "Shared Collection", "rs1");

    // Should NOT delete since a sibling still uses it
    expect(mockPlexClient.deleteCollection).not.toHaveBeenCalled();
  });
});
