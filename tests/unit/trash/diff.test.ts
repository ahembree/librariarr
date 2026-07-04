import { describe, it, expect } from "vitest";
import { diffValues } from "@/lib/trash/diff";

describe("diffValues", () => {
  it("returns no entries for equal values", () => {
    expect(diffValues({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it("reports a changed scalar with a path", () => {
    const d = diffValues({ score: 10 }, { score: 25 });
    expect(d).toEqual([{ path: "score", before: 10, after: 25, kind: "changed" }]);
  });

  it("classifies added and removed keys", () => {
    const d = diffValues({ a: 1 }, { a: 1, b: 2 });
    expect(d).toEqual([{ path: "b", before: undefined, after: 2, kind: "added" }]);
    const d2 = diffValues({ a: 1, b: 2 }, { a: 1 });
    expect(d2).toEqual([{ path: "b", before: 2, after: undefined, kind: "removed" }]);
  });

  it("treats a null 'before' (create) as everything added", () => {
    const d = diffValues(null, { name: "AMZN", score: 5 });
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe("changed");
    expect(d[0].path).toBe("(root)");
  });

  it("keys array-of-object paths by the element's name, not its index", () => {
    const d = diffValues(
      { items: [{ name: "a", allowed: true }] },
      { items: [{ name: "a", allowed: false }] },
    );
    expect(d).toEqual([
      { path: "items[a].allowed", before: true, after: false, kind: "changed" },
    ]);
  });

  it("labels nested quality members by name (readable profile diffs)", () => {
    const before = {
      qualities: [
        { name: "Remux + WEB 2160p", allowed: true, members: [
          { name: "Remux-2160p", allowed: true },
          { name: "WEB-2160p", allowed: true },
        ] },
      ],
    };
    const after = {
      qualities: [
        { name: "Remux + WEB 2160p", allowed: false, members: [
          { name: "Remux-2160p", allowed: false },
          { name: "WEB-2160p", allowed: true },
        ] },
      ],
    };
    const d = diffValues(before, after);
    expect(d).toEqual([
      { path: "qualities[Remux + WEB 2160p].allowed", before: true, after: false, kind: "changed" },
      {
        path: "qualities[Remux + WEB 2160p].members[Remux-2160p].allowed",
        before: true,
        after: false,
        kind: "changed",
      },
    ]);
  });

  it("uses the after-element name when an item is added or removed", () => {
    const added = diffValues({ q: [] }, { q: [{ name: "HDTV-720p", allowed: true }] });
    expect(added).toEqual([
      { path: "q[HDTV-720p]", before: undefined, after: { name: "HDTV-720p", allowed: true }, kind: "added" },
    ]);
    const removed = diffValues({ q: [{ name: "HDTV-720p", allowed: true }] }, { q: [] });
    expect(removed).toEqual([
      { path: "q[HDTV-720p]", before: { name: "HDTV-720p", allowed: true }, after: undefined, kind: "removed" },
    ]);
  });

  it("falls back to the index for primitive array elements", () => {
    const d = diffValues([1], [1, 2]);
    expect(d).toEqual([{ path: "[1]", before: undefined, after: 2, kind: "added" }]);
  });
});
