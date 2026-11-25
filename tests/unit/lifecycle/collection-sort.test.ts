import { describe, it, expect } from "vitest";
import {
  COLLECTION_SORT_FIELDS,
  COLLECTION_SORT_OPTIONS,
  collectionSortDirectionOf,
  collectionSortFieldOf,
  compareCollectionSortValues,
  isCollectionSortField,
  needsCustomOrder,
  plexCollectionSortMode,
} from "@/lib/lifecycle/collection-sort";

describe("collection sort", () => {
  it("offers every field exactly once", () => {
    expect(COLLECTION_SORT_OPTIONS.map((o) => o.value)).toEqual([...COLLECTION_SORT_FIELDS]);
  });

  it("keeps the stored values existing collections hold", () => {
    for (const legacy of ["ALPHABETICAL", "RELEASE_DATE", "ACTION_DATE"]) {
      expect(isCollectionSortField(legacy)).toBe(true);
    }
  });

  it("reads unknown values leniently", () => {
    expect(collectionSortFieldOf("SOMETHING")).toBe("ALPHABETICAL");
    expect(collectionSortFieldOf(undefined)).toBe("ALPHABETICAL");
    expect(collectionSortFieldOf("FILE_SIZE")).toBe("FILE_SIZE");
    expect(collectionSortDirectionOf(undefined)).toBe("asc");
    expect(collectionSortDirectionOf("sideways")).toBe("asc");
    expect(collectionSortDirectionOf("desc")).toBe("desc");
  });

  it("uses Plex's own mode only for title and release date ascending", () => {
    expect(plexCollectionSortMode("RELEASE_DATE", "asc")).toBe(0);
    expect(plexCollectionSortMode("ALPHABETICAL", "asc")).toBe(1);
    expect(plexCollectionSortMode("RELEASE_DATE", "desc")).toBe(2);
    expect(plexCollectionSortMode("ALPHABETICAL", "desc")).toBe(2);
    for (const field of COLLECTION_SORT_FIELDS) {
      if (field === "RELEASE_DATE" || field === "ALPHABETICAL") continue;
      expect(needsCustomOrder(field, "asc")).toBe(true);
      expect(needsCustomOrder(field, "desc")).toBe(true);
    }
    expect(needsCustomOrder("ALPHABETICAL", "asc")).toBe(false);
  });

  it("compares numbers and text in either direction", () => {
    expect(compareCollectionSortValues(1, 2, "asc")).toBeLessThan(0);
    expect(compareCollectionSortValues(1, 2, "desc")).toBeGreaterThan(0);
    expect(compareCollectionSortValues(3, 3, "desc")).toBe(0);
    expect(compareCollectionSortValues("apple", "Banana", "asc")).toBeLessThan(0);
    expect(compareCollectionSortValues("Movie 2", "Movie 10", "asc")).toBeLessThan(0);
    expect(compareCollectionSortValues("apple", "APPLE", "asc")).toBe(0);
  });

  it("sorts a missing value last in both directions", () => {
    for (const direction of ["asc", "desc"] as const) {
      expect(compareCollectionSortValues(null, 1, direction)).toBeGreaterThan(0);
      expect(compareCollectionSortValues(1, undefined, direction)).toBeLessThan(0);
      expect(compareCollectionSortValues(Number.NaN, 1, direction)).toBeGreaterThan(0);
      expect(compareCollectionSortValues(null, undefined, direction)).toBe(0);
    }
  });
});
