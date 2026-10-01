import { describe, it, expect } from "vitest";
import { capPerType, MAX_ROWS_PER_TYPE, type CrossTabRow } from "@/lib/media/cross-tab";

describe("capPerType", () => {
  it("caps each type separately, keeping a small type's cells", () => {
    const rows: CrossTabRow[] = [
      ...Array.from({ length: MAX_ROWS_PER_TYPE + 50 }, (_, i) => ({
        dim1: `a${i}`, dim2: "x", type: "MOVIE", _count: 100,
      })),
      { dim1: "m", dim2: "x", type: "MUSIC", _count: 1 },
    ];
    const out = capPerType(rows);
    expect(out.filter((r) => r.type === "MOVIE")).toHaveLength(MAX_ROWS_PER_TYPE);
    expect(out.filter((r) => r.type === "MUSIC")).toHaveLength(1);
  });

  it("keeps the first rows of each type in order", () => {
    const rows: CrossTabRow[] = [
      { dim1: "a", dim2: "x", type: "MOVIE", _count: 3 },
      { dim1: "b", dim2: "x", type: "SERIES", _count: 2 },
      { dim1: "c", dim2: "x", type: "MOVIE", _count: 1 },
    ];
    expect(capPerType(rows)).toEqual(rows);
  });
});
