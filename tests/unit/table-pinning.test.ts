import { describe, it, expect } from "vitest";
import { arrangePinnedColumns, parseStoredPins, togglePinnedId } from "@/lib/table-pinning";

const cols = [
  { id: "select", alwaysPinned: true },
  { id: "type" },
  { id: "title" },
  { id: "year" },
  { id: "size" },
  { id: "plays" },
];
const widths = { select: 44, type: 80, title: 300, year: 74, size: 90, plays: 82 };

describe("arrangePinnedColumns", () => {
  it("puts pinned columns first, in their original order, with cumulative left offsets", () => {
    const layout = arrangePinnedColumns(cols, new Set(["year", "type"]), widths);
    expect(layout.ordered.map((c) => c.id)).toEqual(["select", "type", "year", "title", "size", "plays"]);
    expect(layout.pinnedCount).toBe(3);
    expect(layout.offsets).toEqual({ select: 0, type: 44, year: 124 });
  });

  it("pins a column further right by moving it into the pinned block", () => {
    const layout = arrangePinnedColumns(cols, new Set(["plays"]), widths);
    expect(layout.ordered.map((c) => c.id)).toEqual(["select", "plays", "type", "title", "year", "size"]);
    expect(layout.offsets).toEqual({ select: 0, plays: 44 });
  });

  it("ignores pins for columns that are not shown", () => {
    const layout = arrangePinnedColumns(cols, new Set(["hidden-column"]), widths);
    expect(layout.pinnedCount).toBe(1);
    expect(layout.ordered.map((c) => c.id)).toEqual(cols.map((c) => c.id));
  });
});

describe("togglePinnedId", () => {
  it("adds and removes", () => {
    expect(togglePinnedId(["type"], "title")).toEqual(["type", "title"]);
    expect(togglePinnedId(["type", "title"], "type")).toEqual(["title"]);
  });
});

describe("parseStoredPins", () => {
  it("uses the default until something valid is stored", () => {
    expect(parseStoredPins(null, ["type", "title"])).toEqual(["type", "title"]);
    expect(parseStoredPins("not json", ["type"])).toEqual(["type"]);
    expect(parseStoredPins('{"a":1}', ["type"])).toEqual(["type"]);
    // Unpinning everything is a real choice, not a reset to the default.
    expect(parseStoredPins("[]", ["type"])).toEqual([]);
    expect(parseStoredPins('["year"]', ["type"])).toEqual(["year"]);
  });
});
