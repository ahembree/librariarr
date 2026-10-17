/**
 * Extra coverage for src/lib/lifecycle/collections.ts: action-date ordering
 * across series scope and collapsed copies, the exclusion removal paths
 * (series-title resolution, item not in the collection, emptying deletes the
 * collection), and the per-library error/skip branches.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  library: { findMany: vi.fn() },
  lifecycleAction: { findMany: vi.fn() },
  collection: { findUnique: vi.fn(), findMany: vi.fn() },
  ruleSet: { findMany: vi.fn() },
}));

const mockPlex = vi.hoisted(() => ({
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

const mockLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));
vi.mock("@/lib/plex/client", () => ({ PlexClient: function () { return mockPlex; } }));

import {
  syncCollection,
  syncCollectionById,
  syncAllCollections,
  removeItemFromCollections,
  removePlexCollection,
  renameCollectionInPlex,
} from "@/lib/lifecycle/collections";

const server = { id: "s1", url: "http://plex", accessToken: "t", machineId: "m1", type: "PLEX", tlsSkipVerify: false };
const movieLib = { id: "lib1", key: "1", title: "Movies", mediaServer: server, mediaServerId: "s1" };
const tvLib = { id: "lib1", key: "2", title: "TV", mediaServer: server, mediaServerId: "s1" };
const noMachineLib = { id: "lib2", key: "9", title: "Old", mediaServer: { ...server, id: "s2", machineId: null }, mediaServerId: "s2" };

const collectionDef = (o: Record<string, unknown> = {}) => ({
  id: "c1", userId: "u1", name: "Leaving Soon", type: "MOVIE", sortName: "zz", homeScreen: true, recommended: true, sort: "ACTION_DATE", ...o,
});

beforeEach(() => {
  vi.resetAllMocks();
  mockPlex.createCollection.mockResolvedValue({ ratingKey: "col1", title: "Leaving Soon" });
});

describe("action-date ordering", () => {
  it("orders by the earliest pending action, carries a collapsed copy's date, and puts undated items last", async () => {
    mockPrisma.library.findMany.mockResolvedValue([movieLib]);
    mockPlex.getCollections.mockResolvedValue([]);
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      // Two actions for rk-a: the earlier date wins.
      { scheduledFor: new Date("2025-03-01"), ruleSetId: "rs1", mediaItemId: "a", mediaItem: { ratingKey: "rk-a", parentTitle: null, title: "A" } },
      { scheduledFor: new Date("2025-01-01"), ruleSetId: "rs1", mediaItemId: "a", mediaItem: { ratingKey: "rk-a", parentTitle: null, title: "A" } },
      // A later action for rk-a must not overwrite the earlier one.
      { scheduledFor: new Date("2025-06-01"), ruleSetId: "rs1", mediaItemId: "a", mediaItem: { ratingKey: "rk-a", parentTitle: null, title: "A" } },
      // The kept copy lives on another server; its copy in this library shares the date.
      { scheduledFor: new Date("2025-02-01"), ruleSetId: "rs1", mediaItemId: "kept-b", mediaItem: { ratingKey: "rk-elsewhere", parentTitle: null, title: "B" } },
      // Ignored: no item, no rule set.
      { scheduledFor: new Date("2024-01-01"), ruleSetId: null, mediaItemId: null, mediaItem: null },
    ]);

    await syncCollection(collectionDef(), [{
      ruleSetId: "rs1",
      seriesScope: false,
      items: [
        { libraryId: "lib1", ratingKey: "rk-undated", title: "C", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk-undated-2", title: "D", parentTitle: null },
        { libraryId: "lib1", ratingKey: "rk-b-copy", title: "B", parentTitle: null, copyOf: "kept-b" },
        { libraryId: "lib1", ratingKey: "rk-a", title: "A", parentTitle: null },
      ],
    }]);

    const order = mockPlex.moveCollectionItem.mock.calls.map((c) => c[1]);
    expect(order.slice(0, 2)).toEqual(["rk-a", "rk-b-copy"]);
    expect(new Set(order.slice(2))).toEqual(new Set(["rk-undated", "rk-undated-2"]));
    expect(mockPlex.moveCollectionItem.mock.calls[0][2]).toBeUndefined();
    expect(mockPlex.editCollectionSortTitle).toHaveBeenCalledWith("1", "col1", "zz");
    expect(mockPlex.updateCollectionVisibility).toHaveBeenCalledWith("1", "col1", true, true, true);
  });

  it("maps a series-scope action to its show's rating key, and skips a show Plex does not list", async () => {
    mockPrisma.library.findMany.mockResolvedValue([tvLib]);
    mockPlex.getCollections.mockResolvedValue([]);
    mockPlex.getLibraryItems.mockResolvedValue([
      { title: "Severance", ratingKey: "show-1" },
      { title: "Lost", ratingKey: "show-2" },
    ]);
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      { scheduledFor: new Date("2025-01-02"), ruleSetId: "rs1", mediaItemId: "e1", mediaItem: { ratingKey: "ep1", parentTitle: "Lost", title: "Pilot" } },
      { scheduledFor: new Date("2025-01-01"), ruleSetId: "rs1", mediaItemId: "e9", mediaItem: { ratingKey: "ep9", parentTitle: "Unknown Show", title: "X" } },
    ]);

    await syncCollection(collectionDef({ type: "SERIES" }), [{
      ruleSetId: "rs1",
      seriesScope: true,
      items: [
        { libraryId: "lib1", ratingKey: "ep0", title: "Good News", parentTitle: "Severance" },
        { libraryId: "lib1", ratingKey: "ep1", title: "Pilot", parentTitle: "Lost" },
      ],
    }]);

    expect(mockPlex.createCollection).toHaveBeenCalledWith("2", "Leaving Soon", "m1", ["show-1", "show-2"], 2);
    expect(mockPlex.moveCollectionItem.mock.calls.map((c) => c[1])).toEqual(["show-2", "show-1"]);
  });

  it("does not reorder a single-member collection", async () => {
    mockPrisma.library.findMany.mockResolvedValue([movieLib]);
    mockPlex.getCollections.mockResolvedValue([]);
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);

    await syncCollection(collectionDef(), [{
      ruleSetId: "rs1", seriesScope: false,
      items: [{ libraryId: "lib1", ratingKey: "only", title: "Only", parentTitle: null }],
    }]);

    expect(mockPlex.editCollectionSort).toHaveBeenCalledWith("col1", 2);
    expect(mockPlex.moveCollectionItem).not.toHaveBeenCalled();
  });

  it("clears the sort title and falls back to alphabetical for an unknown sort", async () => {
    mockPrisma.library.findMany.mockResolvedValue([movieLib]);
    mockPlex.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Leaving Soon" }]);
    mockPlex.getCollectionItems.mockResolvedValue([{ ratingKey: "x" }]);

    await syncCollection(collectionDef({ sort: "SOMETHING", sortName: null }), [{
      ruleSetId: "rs1", seriesScope: false,
      items: [{ libraryId: "lib1", ratingKey: "x", title: "X", parentTitle: null }],
    }]);

    expect(mockPrisma.lifecycleAction.findMany).not.toHaveBeenCalled();
    expect(mockPlex.addCollectionItems).not.toHaveBeenCalled();
    expect(mockPlex.removeCollectionItem).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalledWith("Lifecycle", expect.stringContaining("Synced Plex collection"));
    expect(mockPlex.editCollectionSortTitle).toHaveBeenCalledWith("1", "col1", "");
    expect(mockPlex.editCollectionSort).toHaveBeenCalledWith("col1", 1);
  });
});

describe("syncCollectionById / syncAllCollections", () => {
  it("syncs a match whose stored snapshot carries no title", async () => {
    mockPrisma.collection.findUnique.mockResolvedValue(collectionDef({ sort: "ALPHABETICAL" }));
    mockPrisma.ruleSet.findMany.mockResolvedValue([
      { id: "rs1", seriesScope: false, ruleMatches: [{ mediaItemId: "m", itemData: { libraryId: "lib1", ratingKey: "rk" } }] },
    ]);
    mockPrisma.library.findMany.mockResolvedValue([movieLib]);
    mockPlex.getCollections.mockResolvedValue([]);

    await syncCollectionById("c1");

    // Every enabled rule set assigned to the collection feeds it.
    expect(mockPrisma.ruleSet.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { collectionId: "c1", enabled: true },
    }));
    expect(mockPlex.createCollection).toHaveBeenCalledWith("1", "Leaving Soon", "m1", ["rk"], 1);
  });

  it("logs a collection whose sync throws and carries on with the rest", async () => {
    mockPrisma.collection.findMany.mockResolvedValue([{ id: "bad" }, { id: "good" }]);
    mockPrisma.collection.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "bad") throw new Error("db hiccup");
      return null;
    });

    await syncAllCollections(undefined);

    expect(mockPrisma.collection.findMany).toHaveBeenCalledWith({ where: {}, select: { id: true } });
    expect(mockLogger.error).toHaveBeenCalledWith("Lifecycle", "Collection sync failed for collection bad", expect.any(Object));
    expect(mockPrisma.collection.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("removeItemFromCollections", () => {
  it("resolves a series-scope exclusion to the show's rating key and deletes the emptied collection", async () => {
    mockPrisma.library.findMany.mockResolvedValue([noMachineLib, tvLib]);
    mockPlex.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Leaving Soon" }]);
    mockPlex.getLibraryItems.mockResolvedValue([{ title: "Lost", ratingKey: "show-2" }]);
    mockPlex.getCollectionItems
      .mockResolvedValueOnce([{ ratingKey: "show-2" }])
      .mockResolvedValueOnce([]);

    await removeItemFromCollections("u1", "SERIES", "Leaving Soon", "ep-rk", "Lost");

    expect(mockPlex.getCollections).toHaveBeenCalledTimes(1); // the machineId-less library is skipped
    expect(mockPlex.removeCollectionItem).toHaveBeenCalledWith("col1", "show-2");
    expect(mockPlex.deleteCollection).toHaveBeenCalledWith("col1");
  });

  // The sync adds a show to the collection by trimmed, lower-cased title; the
  // exclusion must find the same show, or it is added and never removed.
  it("finds the show the way the sync that added it did, ignoring case and spaces", async () => {
    mockPrisma.library.findMany.mockResolvedValue([tvLib]);
    mockPlex.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Leaving Soon" }]);
    mockPlex.getLibraryItems.mockResolvedValue([{ title: "The Office", ratingKey: "show-7" }]);
    mockPlex.getCollectionItems
      .mockResolvedValueOnce([{ ratingKey: "show-7" }, { ratingKey: "show-8" }])
      .mockResolvedValueOnce([{ ratingKey: "show-8" }]);

    await removeItemFromCollections("u1", "SERIES", "Leaving Soon", "ep-rk", " the office ");

    expect(mockPlex.removeCollectionItem).toHaveBeenCalledExactlyOnceWith("col1", "show-7");
    expect(mockPlex.deleteCollection).not.toHaveBeenCalled();
  });

  it("leaves the collection alone when the show is not in Plex", async () => {
    mockPrisma.library.findMany.mockResolvedValue([tvLib]);
    mockPlex.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Leaving Soon" }]);
    mockPlex.getLibraryItems.mockResolvedValue([{ title: "Other", ratingKey: "x" }]);

    await removeItemFromCollections("u1", "SERIES", "Leaving Soon", "ep-rk", "Lost");

    expect(mockPlex.getCollectionItems).not.toHaveBeenCalled();
    expect(mockPlex.removeCollectionItem).not.toHaveBeenCalled();
  });

  it("does nothing when the collection is missing or the item is not a member", async () => {
    mockPrisma.library.findMany.mockResolvedValue([movieLib]);
    mockPlex.getCollections.mockResolvedValueOnce([]);
    await removeItemFromCollections("u1", "MOVIE", "Leaving Soon", "rk1", null);
    expect(mockPlex.getCollectionItems).not.toHaveBeenCalled();

    mockPlex.getCollections.mockResolvedValueOnce([{ ratingKey: "col1", title: "Leaving Soon" }]);
    mockPlex.getCollectionItems.mockResolvedValueOnce([{ ratingKey: "other" }]);
    await removeItemFromCollections("u1", "MOVIE", "Leaving Soon", "rk1", null);
    expect(mockPlex.removeCollectionItem).not.toHaveBeenCalled();
    expect(mockPlex.deleteCollection).not.toHaveBeenCalled();
  });

  it("logs a Plex failure per library without throwing", async () => {
    mockPrisma.library.findMany.mockResolvedValue([movieLib]);
    mockPlex.getCollections.mockRejectedValue(new Error("plex down"));
    await expect(removeItemFromCollections("u1", "MOVIE", "Leaving Soon", "rk1", null)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("Failed to remove item"), expect.any(Object));
  });
});

describe("removePlexCollection / renameCollectionInPlex", () => {
  it("skip a library whose server has no machineId", async () => {
    mockPrisma.library.findMany.mockResolvedValue([noMachineLib]);
    await removePlexCollection("u1", "MOVIE", "Leaving Soon");
    await renameCollectionInPlex("u1", "MOVIE", "Leaving Soon", "Gone Soon");
    expect(mockPlex.getCollections).not.toHaveBeenCalled();
  });

  it("rename logs a Plex failure per library without throwing", async () => {
    mockPrisma.library.findMany.mockResolvedValue([movieLib]);
    mockPlex.getCollections.mockResolvedValue([{ ratingKey: "col1", title: "Leaving Soon" }]);
    mockPlex.renameCollection.mockRejectedValue(new Error("nope"));
    await expect(renameCollectionInPlex("u1", "MOVIE", "Leaving Soon", "Gone Soon")).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("Failed to rename collection"), expect.any(Object));
  });
});
