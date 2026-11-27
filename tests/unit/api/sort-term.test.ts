import { describe, it, expect } from "vitest";
import { listSortTerm } from "@/lib/api/sort-term";

describe("listSortTerm", () => {
  it("sorts Plex's per-provider ratings with empty values last in both directions", () => {
    for (const field of ["imdbRating", "tmdbRating", "rtCriticRating", "rtAudienceRating"]) {
      expect(listSortTerm(field, "desc")).toEqual({ [field]: { sort: "desc", nulls: "last" } });
      expect(listSortTerm(field, "asc")).toEqual({ [field]: { sort: "asc", nulls: "last" } });
    }
  });

  it("leaves every other column's sort as it was", () => {
    expect(listSortTerm("rating", "desc")).toEqual({ rating: "desc" });
    expect(listSortTerm("year", "asc")).toEqual({ year: "asc" });
  });
});
