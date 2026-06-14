import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  library: { findMany: vi.fn() },
  lifecycleAction: { findMany: vi.fn() },
  collection: { findUnique: vi.fn(), findMany: vi.fn() },
  ruleSet: { findMany: vi.fn() },
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
  renameCollection: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/plex/client", () => ({
  PlexClient: function () { return mockPlexClient; },
}));

import {
  syncCollection,
  syncCollectionById,
  syncAllCollections,
  removePlexCollection,
  renameCollectionInPlex,
  type CollectionContribution,
} from "@/lib/lifecycle/collections";

function makeCollection(overrides: Record<string, unknown> = {}) {
  return {
    id: "col-def-1",
    userId: "u1",
    name: "Test Collection",
    type: "MOVIE",
    sortName: null,
    homeScreen: false,
    recommended: false,
    sort: "ALPHABETICAL",
    ...overrides,
  };
}

function contribution(
  items: Array<{ libraryId: string; ratingKey: string; title: string; parentTitle: string | null }>,
  overrides: Partial<CollectionContribution> = {},
): CollectionContribution {
  return { ruleSetId: "rs1", seriesScope: false, items, ...overrides };
}

const defaultServer = {
  id: "s1",
  url: "http://plex",
  accessToken: "token",
  machineId: "machine1",
  type: "PLEX",
  tlsSkipVerify: false,
};

const oneMovieLibrary = [
  { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
];

function stubSortAndVisibility() {
  mockPlexClient.editCollectionSortTitle.mockResolvedValue(undefined);
  mockPlexClient.editCollectionSort.mockResolvedValue(undefined);
  mockPlexClient.updateCollectionVisibility.mockResolvedValue(undefined);
}

describe("syncCollection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new collection when none exists", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollection(makeCollection(), [
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }]),
    ]);

    expect(mockPlexClient.createCollection).toHaveBeenCalledWith(
      "1", "Test Collection", "machine1", ["rk1"], 1,
    );
  });

  it("merges items across multiple contributing rule sets (union)", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollection(makeCollection(), [
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }], { ruleSetId: "rsA" }),
      contribution([{ libraryId: "lib1", ratingKey: "rk2", title: "Movie 2", parentTitle: null }], { ruleSetId: "rsB" }),
    ]);

    const [, , , keys] = mockPlexClient.createCollection.mock.calls[0];
    expect(new Set(keys)).toEqual(new Set(["rk1", "rk2"]));
  });

  it("dedupes the same item matched by two rule sets", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollection(makeCollection(), [
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }], { ruleSetId: "rsA" }),
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }], { ruleSetId: "rsB" }),
    ]);

    const [, , , keys] = mockPlexClient.createCollection.mock.calls[0];
    expect(keys).toEqual(["rk1"]);
  });

  it("syncs items in existing collection — adds missing, removes extras", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Test Collection" }]);
    mockPlexClient.getCollectionItems.mockResolvedValue([
      { ratingKey: "rk1" }, // existing, should stay
      { ratingKey: "rk_extra" }, // not in desired, should be removed
    ]);
    mockPlexClient.addCollectionItems.mockResolvedValue(undefined);
    mockPlexClient.removeCollectionItem.mockResolvedValue(undefined);
    stubSortAndVisibility();

    await syncCollection(makeCollection(), [
      contribution([
        { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk_new", title: "Movie 2", parentTitle: null },
      ]),
    ]);

    expect(mockPlexClient.addCollectionItems).toHaveBeenCalledWith("col1", "machine1", ["rk_new"]);
    expect(mockPlexClient.removeCollectionItem).toHaveBeenCalledWith("col1", "rk_extra");
  });

  it("deletes empty collection when no items remain (empty contributions)", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Test Collection" }]);
    mockPlexClient.getCollectionItems.mockResolvedValue([{ ratingKey: "rk_old" }]);
    mockPlexClient.removeCollectionItem.mockResolvedValue(undefined);
    mockPlexClient.deleteCollection.mockResolvedValue(undefined);

    await syncCollection(makeCollection(), []);

    expect(mockPlexClient.deleteCollection).toHaveBeenCalledWith("col1");
  });

  it("skips when no collection exists and no items to add", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);

    await syncCollection(makeCollection(), []);

    expect(mockPlexClient.createCollection).not.toHaveBeenCalled();
  });

  it("queries libraries once (N+1 fix)", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies 1", mediaServer: defaultServer, mediaServerId: "s1" },
      { id: "lib2", key: "2", title: "Movies 2", mediaServer: { ...defaultServer, id: "s2" }, mediaServerId: "s2" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollection(makeCollection(), [
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }]),
    ]);

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
    stubSortAndVisibility();

    await syncCollection(makeCollection({ type: "SERIES" }), [
      contribution(
        [{ libraryId: "lib1", ratingKey: "ep-rk-1", title: "Ep 1", parentTitle: "Breaking Bad" }],
        { seriesScope: true },
      ),
    ]);

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
    stubSortAndVisibility();

    const cache = new Map([["1", [{ title: "Cached Show", ratingKey: "cached-rk" }]]]);

    await syncCollection(
      makeCollection({ type: "SERIES" }),
      [contribution([{ libraryId: "lib1", ratingKey: "ep-rk", title: "Ep 1", parentTitle: "Cached Show" }], { seriesScope: true })],
      cache,
    );

    expect(mockPlexClient.getLibraryItems).not.toHaveBeenCalled();
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith(
      "1", "Test Collection", "machine1", ["cached-rk"], 2,
    );
  });

  it("sets ACTION_DATE sort order and reorders items across rule sets", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.moveCollectionItem.mockResolvedValue(undefined);
    stubSortAndVisibility();

    // Two rule sets feed the collection; the soonest deletion (rk1, rsB) sorts first.
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      { scheduledFor: new Date("2025-01-10"), ruleSetId: "rsA", mediaItem: { ratingKey: "rk2", parentTitle: null, title: "Movie 2" } },
      { scheduledFor: new Date("2025-01-05"), ruleSetId: "rsB", mediaItem: { ratingKey: "rk1", parentTitle: null, title: "Movie 1" } },
    ]);

    await syncCollection(makeCollection({ sort: "ACTION_DATE" }), [
      contribution([{ libraryId: "lib1", ratingKey: "rk2", title: "Movie 2", parentTitle: null }], { ruleSetId: "rsA" }),
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }], { ruleSetId: "rsB" }),
    ]);

    expect(mockPlexClient.editCollectionSort).toHaveBeenCalledWith("col1", 2);
    expect(mockPlexClient.moveCollectionItem).toHaveBeenCalledWith("col1", "rk1", undefined);
    expect(mockPlexClient.moveCollectionItem).toHaveBeenCalledWith("col1", "rk2", "rk1");
  });

  it("syncs visibility settings", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollection(makeCollection({ homeScreen: true, recommended: true }), [
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }]),
    ]);

    expect(mockPlexClient.updateCollectionVisibility).toHaveBeenCalledWith("1", "col1", true, true, true);
  });

  it("skips library without machineId", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: { ...defaultServer, machineId: null }, mediaServerId: "s1" },
    ]);

    await syncCollection(makeCollection(), [
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }]),
    ]);

    expect(mockPlexClient.getCollections).not.toHaveBeenCalled();
  });

  it("handles MUSIC type with plexType 2", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Music", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollection(makeCollection({ type: "MUSIC" }), [
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Artist", parentTitle: null }]),
    ]);

    expect(mockPlexClient.createCollection).toHaveBeenCalledWith("1", "Test Collection", "machine1", ["rk1"], 2);
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
    stubSortAndVisibility();

    await syncCollection(makeCollection(), [
      contribution([
        { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
        { libraryId: "lib2", ratingKey: "rk2", title: "Movie 2", parentTitle: null },
      ]),
    ]);

    expect(mockPlexClient.createCollection).toHaveBeenCalled();
  });
});

describe("syncCollectionById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds contributions from persisted matches and syncs", async () => {
    mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        id: "rs1",
        seriesScope: false,
        ruleMatches: [
          { itemData: { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null } },
        ],
      },
    ]);
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollectionById("col-def-1");

    expect(mockPlexClient.createCollection).toHaveBeenCalledWith("1", "Test Collection", "machine1", ["rk1"], 1);
  });

  it("no-ops when the collection does not exist", async () => {
    mockPrisma.collection.findUnique.mockResolvedValue(null);
    await syncCollectionById("missing");
    expect(mockPrisma.library.findMany).not.toHaveBeenCalled();
  });

  it("drops match rows without a ratingKey/libraryId", async () => {
    mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        id: "rs1",
        seriesScope: false,
        ruleMatches: [
          { itemData: { title: "No keys" } },
          { itemData: { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null } },
        ],
      },
    ]);
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollectionById("col-def-1");

    expect(mockPlexClient.createCollection).toHaveBeenCalledWith("1", "Test Collection", "machine1", ["rk1"], 1);
  });
});

describe("syncAllCollections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs each of the user's collections", async () => {
    mockPrisma.collection.findMany.mockResolvedValue([{ id: "col-def-1" }, { id: "col-def-2" }]);
    mockPrisma.collection.findUnique
      .mockResolvedValueOnce(makeCollection({ id: "col-def-1" }))
      .mockResolvedValueOnce(makeCollection({ id: "col-def-2", name: "Other" }));
    mockPrisma.ruleSet.findMany.mockResolvedValue([]); // no rule sets -> empty union
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]); // nothing on plex, nothing to do

    await syncAllCollections("u1");

    expect(mockPrisma.collection.findMany).toHaveBeenCalledWith({ where: { userId: "u1" }, select: { id: true } });
    expect(mockPrisma.collection.findUnique).toHaveBeenCalledTimes(2);
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
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Old Collection" }]);
    mockPlexClient.deleteCollection.mockResolvedValue(undefined);

    await removePlexCollection("u1", "MOVIE", "Old Collection");

    expect(mockPlexClient.deleteCollection).toHaveBeenCalledWith("col1");
  });

  it("skips library when collection does not exist", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Different Collection" }]);

    await removePlexCollection("u1", "MOVIE", "Missing Collection");

    expect(mockPlexClient.deleteCollection).not.toHaveBeenCalled();
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

    await removePlexCollection("u1", "MOVIE", "Target");

    expect(mockPlexClient.deleteCollection).toHaveBeenCalledWith("col2");
  });
});

describe("renameCollectionInPlex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renames the matching collection across libraries", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Old Name" }]);
    mockPlexClient.renameCollection.mockResolvedValue(undefined);

    await renameCollectionInPlex("u1", "MOVIE", "Old Name", "New Name");

    expect(mockPlexClient.renameCollection).toHaveBeenCalledWith("1", "col1", "New Name");
  });

  it("skips when the old collection is not found", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Unrelated" }]);

    await renameCollectionInPlex("u1", "MOVIE", "Old Name", "New Name");

    expect(mockPlexClient.renameCollection).not.toHaveBeenCalled();
  });
});
