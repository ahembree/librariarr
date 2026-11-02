import { describe, it, expect, vi } from "vitest";
import { CollectionSyncCache } from "@/lib/lifecycle/collection-sync-cache";

describe("CollectionSyncCache", () => {
  it("reads a library's shows and its collections once, sharing an in-flight read", async () => {
    const cache = new CollectionSyncCache();
    const loadShows = vi.fn(async () => [{ title: "Lost", ratingKey: "s1" }]);
    const loadCollections = vi.fn(async () => [{ ratingKey: "c", title: "T" }]);

    const [a, b] = await Promise.all([cache.libraryShows("lib1", loadShows), cache.libraryShows("lib1", loadShows)]);
    await cache.collections("lib1", loadCollections);
    await cache.collections("lib1", loadCollections);

    expect(a).toBe(b);
    expect(loadShows).toHaveBeenCalledTimes(1);
    expect(loadCollections).toHaveBeenCalledTimes(1);
  });

  it("keeps libraries apart", async () => {
    const cache = new CollectionSyncCache();
    await cache.libraryShows("lib1", async () => [{ title: "Lost", ratingKey: "s1" }]);
    await expect(cache.libraryShows("lib2", async () => [{ title: "Lost", ratingKey: "s2" }])).resolves.toEqual([
      { title: "Lost", ratingKey: "s2" },
    ]);
  });

  it("does not keep a failed read", async () => {
    const cache = new CollectionSyncCache();
    await expect(cache.collections("lib1", async () => { throw new Error("down"); })).rejects.toThrow("down");
    await expect(cache.libraryShows("lib1", async () => { throw new Error("down"); })).rejects.toThrow("down");
    await expect(cache.collections("lib1", async () => [{ ratingKey: "c", title: "T" }])).resolves.toEqual([
      { ratingKey: "c", title: "T" },
    ]);
    await expect(cache.libraryShows("lib1", async () => [])).resolves.toEqual([]);
  });

  it("adds a collection the pass created and forgets one it deleted", async () => {
    const cache = new CollectionSyncCache();
    await cache.collections("lib1", async () => [{ ratingKey: "c", title: "T" }]);

    await cache.created("lib1", { ratingKey: "n", title: "New" });
    await expect(cache.collections("lib1", async () => [])).resolves.toEqual([
      { ratingKey: "c", title: "T" },
      { ratingKey: "n", title: "New" },
    ]);

    await cache.deleted("lib1", "c");
    await cache.deleted("lib1", "absent");
    await expect(cache.collections("lib1", async () => [])).resolves.toEqual([{ ratingKey: "n", title: "New" }]);
  });

  it("ignores a create or delete in a library it has not read", async () => {
    const cache = new CollectionSyncCache();
    await cache.created("lib-unread", { ratingKey: "x", title: "X" });
    await cache.deleted("lib-unread", "x");
    await expect(cache.collections("lib-unread", async () => [])).resolves.toEqual([]);
  });

  it("never edits the loader's own array", async () => {
    const cache = new CollectionSyncCache();
    const fromPlex = [{ ratingKey: "c", title: "T" }];
    await cache.collections("lib1", async () => fromPlex);
    await cache.created("lib1", { ratingKey: "n", title: "New" });
    await cache.deleted("lib1", "c");
    expect(fromPlex).toEqual([{ ratingKey: "c", title: "T" }]);
  });
});
