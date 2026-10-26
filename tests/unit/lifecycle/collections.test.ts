import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  library: { findMany: vi.fn() },
  lifecycleAction: { findMany: vi.fn() },
  collection: { findUnique: vi.fn(), findMany: vi.fn() },
  ruleSet: { findMany: vi.fn() },
  $queryRawUnsafe: vi.fn(),
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
  getCollectionVisibility: vi.fn(),
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

import { logger } from "@/lib/logger";
import { isSelfWrite, _resetSelfWritesForTesting } from "@/lib/media-server/realtime/self-writes";
import {
  syncCollection,
  syncCollectionById,
  syncAllCollections,
  removeItemFromCollections,
  removeItemsFromCollections,
  removePlexCollection,
  renameCollectionInPlex,
  planCollectionMoves,
  type CollectionContribution,
} from "@/lib/lifecycle/collections";
import { CollectionSyncCache } from "@/lib/lifecycle/collection-sync-cache";

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
  mockPlexClient.getCollectionVisibility.mockResolvedValue({
    identifier: null, home: false, shared: false, recommended: false,
  });
}

/**
 * The rule sets `buildContributionsFromMatches` reads and the match rows its
 * SQL returns — the snapshot fields taken out of `itemData`, as Postgres'
 * `->>`/`->` hands them back (null for a missing key).
 */
function stubMatches(ruleSets: Array<{
  id: string;
  seriesScope: boolean;
  ruleMatches: Array<{ mediaItemId?: string; itemData: Record<string, unknown> }>;
}>) {
  mockPrisma.ruleSet.findMany.mockResolvedValue(ruleSets.map(({ id, seriesScope }) => ({ id, seriesScope })));
  mockPrisma.$queryRawUnsafe.mockResolvedValue(
    ruleSets.flatMap((rs) =>
      rs.ruleMatches.map((m) => ({
        ruleSetId: rs.id,
        mediaItemId: m.mediaItemId ?? "m",
        libraryId: (m.itemData.libraryId as string | undefined) ?? null,
        ratingKey: (m.itemData.ratingKey as string | undefined) ?? null,
        title: (m.itemData.title as string | undefined) ?? null,
        parentTitle: (m.itemData.parentTitle as string | null | undefined) ?? null,
        copies: m.itemData.copies ?? null,
      })),
    ),
  );
}

describe("syncCollection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

    expect(mockPlexClient.removeCollectionItem).toHaveBeenCalledWith("col1", "rk_old");
    expect(mockPlexClient.deleteCollection).toHaveBeenCalledWith("col1");
    // A deleted collection gets no sort or visibility writes.
    expect(mockPlexClient.editCollectionSortTitle).not.toHaveBeenCalled();
  });

  it("skips when no collection exists and no items to add", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);

    await syncCollection(makeCollection(), []);

    expect(mockPlexClient.createCollection).not.toHaveBeenCalled();
  });

  it("does NOT touch the collection when all matches live in another library (quiet skip)", async () => {
    // Every matched item's libraryId points at a different library (a
    // cross-server / non-Plex match) — the normal steady state in multi-library
    // setups. The guard must leave the collection untouched rather than
    // stripping every member and deleting it, and must NOT warn every cycle.
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);

    await syncCollection(makeCollection(), [
      contribution([{ libraryId: "libOTHER", ratingKey: "rk1", title: "Movie 1", parentTitle: null }]),
    ]);

    expect(mockPlexClient.getCollections).not.toHaveBeenCalled();
    expect(mockPlexClient.removeCollectionItem).not.toHaveBeenCalled();
    expect(mockPlexClient.deleteCollection).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "Lifecycle",
      expect.stringContaining("live in other libraries or servers"),
    );
  });

  it("warns when items belong to this library but none resolved to a Plex rating key", async () => {
    // Series-scope items claim this library, but their series title is missing
    // from the live Plex library — a genuine resolution failure worth a warning.
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "TV Shows", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getLibraryItems.mockResolvedValue([
      { title: "Some Other Show", ratingKey: "series-rk-9" },
    ]);

    await syncCollection(makeCollection({ type: "SERIES" }), [
      contribution(
        [{ libraryId: "lib1", ratingKey: "ep-rk-1", title: "Ep 1", parentTitle: "Gone Show" }],
        { seriesScope: true },
      ),
    ]);

    expect(mockPlexClient.getCollections).not.toHaveBeenCalled();
    expect(mockPlexClient.deleteCollection).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Lifecycle",
      expect.stringContaining("none resolved to a Plex rating key"),
    );
  });

  it("still deletes a genuinely orphaned collection (no contributors matched anything)", async () => {
    // contributions present but each empty → genuine "nothing matches" → clean up.
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Test Collection" }]);
    mockPlexClient.getCollectionItems.mockResolvedValue([{ ratingKey: "rk_old" }]);
    mockPlexClient.removeCollectionItem.mockResolvedValue(undefined);
    mockPlexClient.deleteCollection.mockResolvedValue(undefined);

    await syncCollection(makeCollection(), [contribution([], { ruleSetId: "rsEmpty" })]);

    expect(mockPlexClient.deleteCollection).toHaveBeenCalledWith("col1");
  });

  it("skips (and warns about) a library whose server has no machineId", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "Movies", mediaServer: { ...defaultServer, machineId: null }, mediaServerId: "s1" },
    ]);

    await syncCollection(makeCollection(), [
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }]),
    ]);

    expect(mockPlexClient.getCollections).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Lifecycle",
      expect.stringContaining("has no machineId"),
    );
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

  it("uses the sync cache for series-scope lookups", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "1", title: "TV Shows", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    const cache = new CollectionSyncCache();
    await cache.libraryShows("lib1", async () => [{ title: "Cached Show", ratingKey: "cached-rk" }]);

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
      { scheduledFor: new Date("2025-01-10"), ruleSetId: "rsA", mediaItemId: "m2", mediaItem: { ratingKey: "rk2", parentTitle: null, title: "Movie 2" } },
      { scheduledFor: new Date("2025-01-05"), ruleSetId: "rsB", mediaItemId: "m1", mediaItem: { ratingKey: "rk1", parentTitle: null, title: "Movie 1" } },
    ]);

    await syncCollection(makeCollection({ sort: "ACTION_DATE" }), [
      contribution([{ libraryId: "lib1", ratingKey: "rk2", title: "Movie 2", parentTitle: null }], { ruleSetId: "rsA" }),
      contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }], { ruleSetId: "rsB" }),
    ]);

    // One query pools the pending actions of every contributing rule set.
    expect(mockPrisma.lifecycleAction.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.lifecycleAction.findMany.mock.calls[0][0].where).toEqual({
      ruleSetId: { in: ["rsA", "rsB"] },
      status: "PENDING",
    });
    expect(mockPlexClient.editCollectionSort).toHaveBeenCalledWith("col1", 2);
    expect(mockPlexClient.moveCollectionItem.mock.calls).toEqual([
      ["col1", "rk1", undefined],
      ["col1", "rk2", "rk1"],
    ]);
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

    // lib1 failed and was logged; lib2 still got its collection.
    expect(logger.error).toHaveBeenCalledWith(
      "Lifecycle",
      'Failed to sync collection "Test Collection" for library lib1',
      expect.any(Object),
    );
    expect(mockPlexClient.createCollection).toHaveBeenCalledTimes(1);
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith("2", "Test Collection", "machine1", ["rk2"], 1);
  });
});

describe("syncCollectionById", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("builds contributions from persisted matches and syncs", async () => {
    mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
    stubMatches([
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

  it("puts another server's collapsed copy of a match into THAT server's collection", async () => {
    // Detection stores a multi-server title on one copy; the others ride along
    // in itemData.copies. Without expanding them, a rule set that both acts
    // and feeds a collection dropped the title from server 2's collection.
    const server2 = { ...defaultServer, id: "s2", machineId: "machine2" };
    mockPrisma.collection.findUnique.mockResolvedValue(makeCollection({ sort: "ACTION_DATE" }));
    stubMatches([
      {
        id: "rs1",
        seriesScope: false,
        ruleMatches: [
          {
            mediaItemId: "a",
            itemData: {
              libraryId: "lib1", ratingKey: "rk-a", title: "Movie", parentTitle: null,
              copies: [{ id: "b", libraryId: "lib2", ratingKey: "rk-b", title: "Movie", parentTitle: null }],
            },
          },
          { mediaItemId: "c", itemData: { libraryId: "lib2", ratingKey: "rk-c", title: "Other", parentTitle: null } },
        ],
      },
    ]);
    mockPrisma.library.findMany.mockResolvedValue([
      ...oneMovieLibrary,
      { id: "lib2", key: "2", title: "Movies 2", mediaServer: server2, mediaServerId: "s2" },
    ]);
    // The action sits on the kept copy "a"; server 2's copy sorts by its date.
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      { scheduledFor: new Date("2025-01-01"), ruleSetId: "rs1", mediaItemId: "a", mediaItem: { ratingKey: "rk-a", parentTitle: null, title: "Movie" } },
      { scheduledFor: new Date("2025-02-01"), ruleSetId: "rs1", mediaItemId: "c", mediaItem: { ratingKey: "rk-c", parentTitle: null, title: "Other" } },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    mockPlexClient.moveCollectionItem.mockResolvedValue(undefined);
    stubSortAndVisibility();

    await syncCollectionById("col-def-1");

    expect(mockPlexClient.createCollection).toHaveBeenCalledWith("1", "Test Collection", "machine1", ["rk-a"], 1);
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith("2", "Test Collection", "machine2", ["rk-b", "rk-c"], 1);
    // Server 2: the copy inherits the kept copy's (earlier) action date.
    expect(mockPlexClient.moveCollectionItem).toHaveBeenCalledWith("col1", "rk-b", undefined);
    expect(mockPlexClient.moveCollectionItem).toHaveBeenCalledWith("col1", "rk-c", "rk-b");
  });

  it("no-ops when the collection does not exist", async () => {
    mockPrisma.collection.findUnique.mockResolvedValue(null);
    await syncCollectionById("missing");
    expect(mockPrisma.library.findMany).not.toHaveBeenCalled();
  });

  it("drops match rows without a ratingKey/libraryId", async () => {
    mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
    stubMatches([
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
    vi.resetAllMocks();
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
    vi.resetAllMocks();
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
    vi.resetAllMocks();
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

describe("self-write marks (realtime echo suppression)", () => {
  // Plex reports a collection write back over its notification socket as a
  // metadata change on the collection and on every member it tags. The marks
  // are what let the realtime manager recognise that echo as librariarr's own
  // instead of re-fetching the members — or, past 100 of them, escalating to a
  // whole-server sync straight after a detection run.
  beforeEach(() => {
    vi.resetAllMocks();
    _resetSelfWritesForTesting();
  });

  it("marks every member before the create goes out, and the collection once it exists", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    let markedAtWrite = false;
    mockPlexClient.createCollection.mockImplementation(async () => {
      // The members must already be marked when the write goes out — the echo
      // can land before the call returns.
      markedAtWrite = isSelfWrite("s1", "rk1") && isSelfWrite("s1", "rk2");
      return { ratingKey: "col1", title: "Test Collection" };
    });
    stubSortAndVisibility();

    await syncCollection(makeCollection(), [
      contribution([
        { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk2", title: "Movie 2", parentTitle: null },
      ]),
    ]);

    expect(markedAtWrite).toBe(true);
    expect(isSelfWrite("s1", "col1")).toBe(true);
    expect(isSelfWrite("s1", "unrelated")).toBe(false);
    // Rating keys are per-server: nothing is marked for another server.
    expect(isSelfWrite("s2", "rk1")).toBe(false);
  });

  it("marks the collection, every current member and the removed ones on an existing collection", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Test Collection" }]);
    mockPlexClient.getCollectionItems.mockResolvedValue([{ ratingKey: "rk1" }, { ratingKey: "rk_extra" }]);
    mockPlexClient.addCollectionItems.mockResolvedValue(undefined);
    mockPlexClient.removeCollectionItem.mockResolvedValue(undefined);
    stubSortAndVisibility();

    await syncCollection(makeCollection(), [
      contribution([
        { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk_new", title: "Movie 2", parentTitle: null },
      ]),
    ]);

    // rk1 was not added or removed, but the ordering pass rewrites every member.
    for (const key of ["col1", "rk1", "rk_new", "rk_extra"]) {
      expect(isSelfWrite("s1", key)).toBe(true);
    }
  });

  it("marks the collection and the item when an excluded item is removed", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Test Collection" }]);
    mockPlexClient.getCollectionItems
      .mockResolvedValueOnce([{ ratingKey: "rk1" }, { ratingKey: "rk2" }])
      .mockResolvedValueOnce([{ ratingKey: "rk2" }]);
    mockPlexClient.removeCollectionItem.mockResolvedValue(undefined);

    await removeItemFromCollections("u1", "MOVIE", "Test Collection", "rk1", null);

    expect(mockPlexClient.removeCollectionItem).toHaveBeenCalledWith("col1", "rk1");
    expect(isSelfWrite("s1", "col1")).toBe(true);
    expect(isSelfWrite("s1", "rk1")).toBe(true);
    expect(isSelfWrite("s1", "rk2")).toBe(false);
  });

  it("scopes removal to the item's own library when one is given", async () => {
    mockPrisma.library.findMany.mockResolvedValue([]);

    await removeItemFromCollections("u1", "MOVIE", "Test Collection", "rk1", null, "lib-s2");

    expect(mockPrisma.library.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mediaServer: { userId: "u1", type: "PLEX" }, type: "MOVIE", id: "lib-s2" },
      }),
    );
  });

  it("searches every Plex library of the type when no library is given", async () => {
    mockPrisma.library.findMany.mockResolvedValue([]);

    await removeItemFromCollections("u1", "MOVIE", "Test Collection", "rk1", null);

    expect(mockPrisma.library.findMany.mock.calls.at(-1)?.[0].where).toEqual({
      mediaServer: { userId: "u1", type: "PLEX" },
      type: "MOVIE",
    });
  });

  it("marks the collection on rename and on removal", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Test Collection" }]);
    mockPlexClient.renameCollection.mockResolvedValue(undefined);
    await renameCollectionInPlex("u1", "MOVIE", "Test Collection", "Renamed");
    expect(isSelfWrite("s1", "col1")).toBe(true);

    _resetSelfWritesForTesting();
    mockPlexClient.deleteCollection.mockResolvedValue(undefined);
    await removePlexCollection("u1", "MOVIE", "Test Collection");
    expect(isSelfWrite("s1", "col1")).toBe(true);
  });
});

describe("planCollectionMoves", () => {
  /** Plex's `move?after=`: take the item out, put it behind `after` (or first). */
  function applyMoves(list: string[], moves: Array<[string, string | undefined]>): string[] {
    const out = [...list];
    for (const [item, after] of moves) {
      const from = out.indexOf(item);
      if (from !== -1) out.splice(from, 1);
      out.splice(after === undefined ? 0 : out.indexOf(after) + 1, 0, item);
    }
    return out;
  }

  it("moves nothing when the order is already right", () => {
    expect(planCollectionMoves(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
  });

  it("moves only the item out of place", () => {
    const moves = planCollectionMoves(["a", "c", "b", "d"], ["a", "b", "c", "d"]);
    expect(moves).toHaveLength(1);
    expect(applyMoves(["a", "c", "b", "d"], moves)).toEqual(["a", "b", "c", "d"]);
  });

  it("moves a single item to swap two", () => {
    const moves = planCollectionMoves(["a", "b"], ["b", "a"]);
    expect(moves).toHaveLength(1);
    expect(applyMoves(["a", "b"], moves)).toEqual(["b", "a"]);
  });

  it("moves an item to the front with no `after`", () => {
    expect(planCollectionMoves(["b", "c", "a"], ["a", "b", "c"])).toEqual([["a", undefined]]);
  });

  it("places an item the collection does not hold yet", () => {
    const moves = planCollectionMoves(["a", "c"], ["a", "b", "c"]);
    expect(moves).toEqual([["b", "a"]]);
    expect(applyMoves(["a", "c"], moves)).toEqual(["a", "b", "c"]);
  });

  it("reaches the target order from any starting order, in the fewest moves", () => {
    // A deterministic shuffle, so a failure reproduces.
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 200; round++) {
      const n = 1 + Math.floor(rand() * 30);
      const target = Array.from({ length: n }, (_, i) => `k${i}`);
      const current = [...target];
      for (let i = current.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [current[i], current[j]] = [current[j], current[i]];
      }
      const moves = planCollectionMoves(current, target);
      expect(applyMoves(current, moves)).toEqual(target);

      // Fewest moves = n minus the longest run already in order.
      const idx = current.map((k) => target.indexOf(k));
      const best: number[] = [];
      for (let i = 0; i < idx.length; i++) {
        best[i] = 1;
        for (let j = 0; j < i; j++) if (idx[j] < idx[i]) best[i] = Math.max(best[i], best[j] + 1);
      }
      expect(moves.length).toBe(n - Math.max(0, ...best));
    }
  });
});

describe("collection writes Plex already holds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sends no write for a custom-sorted collection that is already in order", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Test Collection", collectionSort: "2" },
    ]);
    mockPlexClient.getCollectionItems.mockResolvedValue([{ ratingKey: "rk1" }, { ratingKey: "rk2" }]);
    stubSortAndVisibility();
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      { scheduledFor: new Date("2025-01-05"), ruleSetId: "rs1", mediaItemId: "m1", mediaItem: { ratingKey: "rk1", parentTitle: null, title: "Movie 1" } },
      { scheduledFor: new Date("2025-01-10"), ruleSetId: "rs1", mediaItemId: "m2", mediaItem: { ratingKey: "rk2", parentTitle: null, title: "Movie 2" } },
    ]);

    await syncCollection(makeCollection({ sort: "ACTION_DATE" }), [
      contribution([
        { libraryId: "lib1", ratingKey: "rk2", title: "Movie 2", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
      ]),
    ]);

    // The order read for the membership check is reused for the ordering.
    expect(mockPlexClient.getCollectionItems).toHaveBeenCalledTimes(1);
    expect(mockPlexClient.moveCollectionItem).not.toHaveBeenCalled();
    expect(mockPlexClient.editCollectionSort).not.toHaveBeenCalled();
    expect(mockPlexClient.editCollectionSortTitle).not.toHaveBeenCalled();
    expect(mockPlexClient.updateCollectionVisibility).not.toHaveBeenCalled();
    expect(mockPlexClient.addCollectionItems).not.toHaveBeenCalled();
    expect(mockPlexClient.removeCollectionItem).not.toHaveBeenCalled();
  });

  it("reads the order back after a membership change, and moves only what is out of place", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Test Collection", collectionSort: "2" },
    ]);
    mockPlexClient.getCollectionItems
      .mockResolvedValueOnce([{ ratingKey: "rk1" }, { ratingKey: "rk2" }])
      // Plex appends the added item.
      .mockResolvedValueOnce([{ ratingKey: "rk1" }, { ratingKey: "rk2" }, { ratingKey: "rk0" }]);
    stubSortAndVisibility();
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      { scheduledFor: new Date("2025-01-01"), ruleSetId: "rs1", mediaItemId: "m0", mediaItem: { ratingKey: "rk0", parentTitle: null, title: "Movie 0" } },
      { scheduledFor: new Date("2025-01-05"), ruleSetId: "rs1", mediaItemId: "m1", mediaItem: { ratingKey: "rk1", parentTitle: null, title: "Movie 1" } },
      { scheduledFor: new Date("2025-01-10"), ruleSetId: "rs1", mediaItemId: "m2", mediaItem: { ratingKey: "rk2", parentTitle: null, title: "Movie 2" } },
    ]);

    await syncCollection(makeCollection({ sort: "ACTION_DATE" }), [
      contribution([
        { libraryId: "lib1", ratingKey: "rk0", title: "Movie 0", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk2", title: "Movie 2", parentTitle: null },
      ]),
    ]);

    expect(mockPlexClient.addCollectionItems).toHaveBeenCalledWith("col1", "machine1", ["rk0"]);
    expect(mockPlexClient.getCollectionItems).toHaveBeenCalledTimes(2);
    expect(mockPlexClient.moveCollectionItem.mock.calls).toEqual([["col1", "rk0", undefined]]);
  });

  it("keeps Plex's order for items that tie", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Test Collection", collectionSort: "2" },
    ]);
    // No pending action at all: every item ties, so nothing moves.
    mockPlexClient.getCollectionItems.mockResolvedValue([{ ratingKey: "rk2" }, { ratingKey: "rk1" }]);
    stubSortAndVisibility();
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);

    await syncCollection(makeCollection({ sort: "ACTION_DATE" }), [
      contribution([
        { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk2", title: "Movie 2", parentTitle: null },
      ]),
    ]);

    expect(mockPlexClient.moveCollectionItem).not.toHaveBeenCalled();
  });

  it("writes the sort title, sort mode and visibility only where Plex differs", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Test Collection", titleSort: "zz", collectionSort: "0" },
    ]);
    mockPlexClient.getCollectionItems.mockResolvedValue([{ ratingKey: "rk1" }]);
    stubSortAndVisibility();
    mockPlexClient.getCollectionVisibility.mockResolvedValue({
      identifier: "custom.collection.1.col1", home: true, shared: true, recommended: false,
    });

    await syncCollection(
      makeCollection({ sortName: null, sort: "ALPHABETICAL", homeScreen: true, recommended: true }),
      [contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }])],
    );

    // A stored sort title is cleared, the sort mode changed, recommended turned on.
    expect(mockPlexClient.editCollectionSortTitle).toHaveBeenCalledWith("1", "col1", "");
    expect(mockPlexClient.editCollectionSort).toHaveBeenCalledWith("col1", 1);
    expect(mockPlexClient.updateCollectionVisibility).toHaveBeenCalledWith("1", "col1", true, true, true);
  });

  it("leaves visibility alone when Plex already holds it, and turns off a hub no longer wanted", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Test Collection", titleSort: "Sort Me", collectionSort: "1" },
    ]);
    mockPlexClient.getCollectionItems.mockResolvedValue([{ ratingKey: "rk1" }]);
    stubSortAndVisibility();
    mockPlexClient.getCollectionVisibility.mockResolvedValue({
      identifier: "custom.collection.1.col1", home: true, shared: true, recommended: true,
    });
    const items = [contribution([{ libraryId: "lib1", ratingKey: "rk1", title: "Movie 1", parentTitle: null }])];

    await syncCollection(makeCollection({ sortName: "Sort Me", homeScreen: true, recommended: true }), items);
    expect(mockPlexClient.editCollectionSortTitle).not.toHaveBeenCalled();
    expect(mockPlexClient.editCollectionSort).not.toHaveBeenCalled();
    expect(mockPlexClient.updateCollectionVisibility).not.toHaveBeenCalled();

    // The hub exists but nothing is wanted any more: it is removed.
    await syncCollection(makeCollection({ sortName: "Sort Me" }), items);
    expect(mockPlexClient.updateCollectionVisibility).toHaveBeenCalledWith("1", "col1", false, false, false);
  });
});

describe("CollectionSyncCache", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads each library's collection listing once across collections, and sees a collection created earlier in the pass", async () => {
    mockPrisma.collection.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    mockPrisma.collection.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      makeCollection({ id: where.id, name: "Shared Name" }),
    );
    stubMatches([
      { id: "rs1", seriesScope: false, ruleMatches: [{ itemData: { libraryId: "lib1", ratingKey: "rk1", title: "Movie 1" } }] },
    ]);
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Shared Name" });
    mockPlexClient.getCollectionItems.mockResolvedValue([{ ratingKey: "rk1" }]);
    stubSortAndVisibility();

    await syncAllCollections("u1");

    expect(mockPlexClient.getCollections).toHaveBeenCalledTimes(1);
    // The second definition finds the collection the first created, rather
    // than creating a second one under the same name.
    expect(mockPlexClient.createCollection).toHaveBeenCalledTimes(1);
  });

  it("keys shows by library, so two servers' libraries with the same section key are read apart", async () => {
    const server2 = { ...defaultServer, id: "s2", machineId: "machine2" };
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "2", title: "TV", mediaServer: defaultServer, mediaServerId: "s1" },
      { id: "lib2", key: "2", title: "TV", mediaServer: server2, mediaServerId: "s2" },
    ]);
    mockPlexClient.getLibraryItems
      .mockResolvedValueOnce([{ title: "Lost", ratingKey: "s1-show" }])
      .mockResolvedValueOnce([{ title: "Lost", ratingKey: "s2-show" }]);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollection(makeCollection({ type: "SERIES" }), [
      contribution(
        [
          { libraryId: "lib1", ratingKey: "ep1", title: "Pilot", parentTitle: "Lost" },
          { libraryId: "lib2", ratingKey: "ep9", title: "Pilot", parentTitle: "Lost" },
        ],
        { seriesScope: true },
      ),
    ]);

    expect(mockPlexClient.getLibraryItems).toHaveBeenCalledTimes(2);
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith("2", "Test Collection", "machine1", ["s1-show"], 2);
    expect(mockPlexClient.createCollection).toHaveBeenCalledWith("2", "Test Collection", "machine2", ["s2-show"], 2);
  });
});

describe("buildContributionsFromMatches (via syncCollectionById)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads only the snapshot fields the sync needs, for every contributing rule set in one query", async () => {
    mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
    stubMatches([
      { id: "rsA", seriesScope: false, ruleMatches: [{ itemData: { libraryId: "lib1", ratingKey: "rk1", title: "A" } }] },
      { id: "rsB", seriesScope: false, ruleMatches: [] },
    ]);
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);
    mockPlexClient.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Test Collection" });
    stubSortAndVisibility();

    await syncCollectionById("col-def-1");

    expect(mockPrisma.ruleSet.findMany).toHaveBeenCalledWith({
      where: { collectionId: "col-def-1", enabled: true },
      select: { id: true, seriesScope: true },
    });
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ids] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain(`"ruleSetId" = ANY($1)`);
    // Paths out of the snapshot, never the whole column.
    expect(sql).not.toMatch(/"itemData"\s*(,|FROM)/);
    expect(ids).toEqual(["rsA", "rsB"]);
  });

  it("skips the match query when no rule set feeds the collection", async () => {
    mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
    mockPrisma.ruleSet.findMany.mockResolvedValue([]);
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([]);

    await syncCollectionById("col-def-1");

    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mockPlexClient.createCollection).not.toHaveBeenCalled();
  });
});

describe("removeItemsFromCollections", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetSelfWritesForTesting();
  });

  it("reads a library and a collection once however many entries name it", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "Leaving Soon" },
      { ratingKey: "col2", title: "Other" },
    ]);
    mockPlexClient.getCollectionItems.mockImplementation(async (key: string) =>
      key === "col1" ? [{ ratingKey: "rk1" }, { ratingKey: "rk2" }, { ratingKey: "rk3" }] : [{ ratingKey: "rk1" }],
    );

    await removeItemsFromCollections("u1", [
      { type: "MOVIE", collectionName: "Leaving Soon", itemRatingKey: "rk1", seriesTitle: null, libraryId: "lib1" },
      { type: "MOVIE", collectionName: "Leaving Soon", itemRatingKey: "rk2", seriesTitle: null, libraryId: "lib1" },
      { type: "MOVIE", collectionName: "Other", itemRatingKey: "rk1", seriesTitle: null, libraryId: "lib1" },
      { type: "MOVIE", collectionName: "Missing", itemRatingKey: "rk1", seriesTitle: null, libraryId: "lib1" },
    ]);

    expect(mockPrisma.library.findMany).toHaveBeenCalledTimes(1);
    expect(mockPlexClient.getCollections).toHaveBeenCalledTimes(1);
    // Each collection: read before removing and again to check for emptiness.
    expect(mockPlexClient.getCollectionItems.mock.calls.map((c) => c[0])).toEqual(["col1", "col1", "col2", "col2"]);
    expect(mockPlexClient.removeCollectionItem.mock.calls).toEqual(
      expect.arrayContaining([["col1", "rk1"], ["col1", "rk2"], ["col2", "rk1"]]),
    );
    expect(mockPlexClient.removeCollectionItem).toHaveBeenCalledTimes(3);
    expect(isSelfWrite("s1", "rk2")).toBe(true);
    expect(isSelfWrite("s1", "rk3")).toBe(false);
  });

  it("reads a TV library's shows once for every show entry", async () => {
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", key: "2", title: "TV", mediaServer: defaultServer, mediaServerId: "s1" },
    ]);
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Leaving Soon" }]);
    mockPlexClient.getLibraryItems.mockResolvedValue([
      { title: "Lost", ratingKey: "show-1" },
      { title: "Severance", ratingKey: "show-2" },
    ]);
    mockPlexClient.getCollectionItems
      .mockResolvedValueOnce([{ ratingKey: "show-1" }, { ratingKey: "show-2" }])
      .mockResolvedValueOnce([]);

    await removeItemsFromCollections("u1", [
      { type: "SERIES", collectionName: "Leaving Soon", itemRatingKey: "ep1", seriesTitle: "Lost", libraryId: "lib1" },
      { type: "SERIES", collectionName: "Leaving Soon", itemRatingKey: "ep2", seriesTitle: "severance", libraryId: "lib1" },
    ]);

    expect(mockPlexClient.getLibraryItems).toHaveBeenCalledTimes(1);
    expect(mockPlexClient.removeCollectionItem).toHaveBeenCalledTimes(2);
    expect(mockPlexClient.deleteCollection).toHaveBeenCalledWith("col1");
  });

  it("applies an entry with no library to every library of its type, and one with a library to that library alone", async () => {
    const server2 = { ...defaultServer, id: "s2" };
    mockPrisma.library.findMany.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id
        ? [{ id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" }]
        : [
            { id: "lib1", key: "1", title: "Movies", mediaServer: defaultServer, mediaServerId: "s1" },
            { id: "lib2", key: "1", title: "Movies", mediaServer: server2, mediaServerId: "s2" },
          ],
    );
    mockPlexClient.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Leaving Soon" }]);
    mockPlexClient.getCollectionItems.mockResolvedValue([{ ratingKey: "rk1" }, { ratingKey: "rk2" }, { ratingKey: "rk9" }]);

    await removeItemsFromCollections("u1", [
      { type: "MOVIE", collectionName: "Leaving Soon", itemRatingKey: "rk1", seriesTitle: null, libraryId: "lib1" },
      { type: "MOVIE", collectionName: "Leaving Soon", itemRatingKey: "rk2", seriesTitle: null },
    ]);

    // lib1 gets both entries in one pass; lib2 only the unscoped one.
    expect(mockPlexClient.getCollections).toHaveBeenCalledTimes(2);
    expect(mockPlexClient.removeCollectionItem).toHaveBeenCalledTimes(3);
    expect(isSelfWrite("s2", "rk1")).toBe(false);
    expect(isSelfWrite("s2", "rk2")).toBe(true);
  });

  it("logs a failed collection and carries on with the next", async () => {
    mockPrisma.library.findMany.mockResolvedValue(oneMovieLibrary);
    mockPlexClient.getCollections.mockResolvedValue([
      { ratingKey: "col1", title: "A" },
      { ratingKey: "col2", title: "B" },
    ]);
    mockPlexClient.getCollectionItems.mockImplementation(async (key: string) => {
      if (key === "col1") throw new Error("plex hiccup");
      return [{ ratingKey: "rk1" }, { ratingKey: "rk2" }];
    });

    await removeItemsFromCollections("u1", [
      { type: "MOVIE", collectionName: "A", itemRatingKey: "rk1", seriesTitle: null },
      { type: "MOVIE", collectionName: "B", itemRatingKey: "rk1", seriesTitle: null },
    ]);

    expect(logger.error).toHaveBeenCalledWith(
      "Lifecycle",
      'Failed to remove item from collection "A" in library lib1',
      expect.any(Object),
    );
    expect(mockPlexClient.removeCollectionItem).toHaveBeenCalledExactlyOnceWith("col2", "rk1");
  });
});
