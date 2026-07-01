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

  it("walks nested objects and arrays with index paths", () => {
    const d = diffValues(
      { items: [{ name: "a", allowed: true }] },
      { items: [{ name: "a", allowed: false }] },
    );
    expect(d).toEqual([
      { path: "items[0].allowed", before: true, after: false, kind: "changed" },
    ]);
  });

  it("reports extra array elements", () => {
    const d = diffValues([1], [1, 2]);
    expect(d).toEqual([{ path: "[1]", before: undefined, after: 2, kind: "added" }]);
  });
});
