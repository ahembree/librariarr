import { describe, it, expect } from "vitest";
import { letterAt, letterOffsets, sumOf, wantsListIndex, LIST_INDEX_PARAM } from "@/lib/media/list-index";

describe("list index", () => {
  it("is asked for with index=1 or index=true", () => {
    expect(LIST_INDEX_PARAM).toBe("index");
    expect(wantsListIndex(new URLSearchParams("index=1"))).toBe(true);
    expect(wantsListIndex(new URLSearchParams("index=true"))).toBe(true);
    expect(wantsListIndex(new URLSearchParams("index=0"))).toBe(false);
    expect(wantsListIndex(new URLSearchParams(""))).toBe(false);
  });

  it("records the first row of each starting letter, in list order", () => {
    const offsets = letterOffsets(["Alien", "arrival", "12 Monkeys", null, "Brazil", "Blade", "", "Zodiac", "Akira"]);
    expect(offsets).toEqual({ A: 0, "#": 2, B: 4, Z: 7 });
  });

  it("reads a row's letter off the offsets — the run it falls in", () => {
    const offsets = { "#": 0, A: 3, C: 10 };
    expect(letterAt(offsets, 0)).toBe("#");
    expect(letterAt(offsets, 3)).toBe("A");
    expect(letterAt(offsets, 9)).toBe("A");
    expect(letterAt(offsets, 5000)).toBe("C");
    expect(letterAt({ B: 4 }, 2)).toBeNull();
    expect(letterAt(undefined, 2)).toBeNull();
  });

  it("sums a figure over the rows, a missing one as 0", () => {
    expect(sumOf([{ n: 2 }, { n: 3 }, { n: Number.NaN }], (r) => r.n)).toBe(5);
    expect(sumOf([], () => 1)).toBe(0);
  });
});
