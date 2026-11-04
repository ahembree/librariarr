import { describe, it, expect } from "vitest";
import {
  adjacentCardId,
  distanceToRect,
  keyboardDropSide,
  moveCard,
  pickDropTarget,
} from "@/lib/dashboard/card-drop";

// A 1200 px grid, 24 px gaps: row 1 holds a 6-wide and a 6-wide card, row 2
// one 12-wide card, row 3 a 4-wide card.
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
const GRID = [
  { id: "a", rect: rect(0, 0, 588, 300) },
  { id: "b", rect: rect(612, 0, 588, 200) },
  { id: "c", rect: rect(0, 324, 1200, 250) },
  { id: "d", rect: rect(0, 598, 384, 200) },
];

describe("distanceToRect", () => {
  const r = rect(100, 100, 200, 100);

  it("is 0 inside the rectangle and on its edge", () => {
    expect(distanceToRect({ x: 150, y: 150 }, r)).toBe(0);
    expect(distanceToRect({ x: 100, y: 200 }, r)).toBe(0);
  });

  it("measures to the nearest edge or corner outside it", () => {
    expect(distanceToRect({ x: 90, y: 150 }, r)).toBe(10);
    expect(distanceToRect({ x: 150, y: 230 }, r)).toBe(30);
    expect(distanceToRect({ x: 303, y: 204 }, r)).toBe(5);
  });
});

describe("pickDropTarget", () => {
  it("targets the card under the point, on the side of its centre the point is on", () => {
    expect(pickDropTarget({ x: 100, y: 100 }, GRID)).toEqual({ id: "a", side: "before", axis: "x", distance: 0 });
    expect(pickDropTarget({ x: 500, y: 250 }, GRID)).toEqual({ id: "a", side: "after", axis: "x", distance: 0 });
    expect(pickDropTarget({ x: 1100, y: 50 }, GRID)).toMatchObject({ id: "b", side: "after", axis: "x" });
  });

  it("drops above or below a card that fills its row", () => {
    expect(pickDropTarget({ x: 900, y: 340 }, GRID)).toMatchObject({ id: "c", side: "before", axis: "y" });
    expect(pickDropTarget({ x: 100, y: 560 }, GRID)).toMatchObject({ id: "c", side: "after", axis: "y" });
  });

  it("targets the nearest card of the row the point is in", () => {
    // In the gap between a and b, nearer b.
    expect(pickDropTarget({ x: 605, y: 100 }, GRID)).toMatchObject({ id: "b", side: "before", distance: 7 });
    // Below b (shorter than a) but within row 1: after b, not after a.
    expect(pickDropTarget({ x: 1000, y: 250 }, GRID)).toMatchObject({ id: "b", side: "after", distance: 50 });
    // The empty end of the last row: after its lone card, though c above is nearer.
    expect(pickDropTarget({ x: 700, y: 700 }, GRID)).toMatchObject({ id: "d", side: "after", axis: "x", distance: 316 });
  });

  it("targets the nearest card overall from a gap between rows", () => {
    expect(pickDropTarget({ x: 100, y: 310 }, GRID)).toMatchObject({ id: "a", side: "before", axis: "x", distance: 10 });
    expect(pickDropTarget({ x: 100, y: 318 }, GRID)).toMatchObject({ id: "c", side: "before", axis: "y", distance: 6 });
  });

  it("reads a lone card as filling its row", () => {
    expect(pickDropTarget({ x: 10, y: 10 }, [{ id: "a", rect: rect(0, 0, 300, 100) }])).toMatchObject({ axis: "y" });
  });

  it("has no target without cards", () => {
    expect(pickDropTarget({ x: 0, y: 0 }, [])).toBeNull();
  });
});

describe("moveCard", () => {
  const cards = ["a", "b", "c", "d"].map((id) => ({ id, size: 6 }));
  const order = (list: { id: string }[]) => list.map((c) => c.id).join("");

  it("puts the card before or after the target, moving forward or back", () => {
    expect(order(moveCard(cards, "a", "c", "before"))).toBe("bacd");
    expect(order(moveCard(cards, "a", "c", "after"))).toBe("bcad");
    expect(order(moveCard(cards, "d", "b", "before"))).toBe("adbc");
    expect(order(moveCard(cards, "d", "b", "after"))).toBe("abdc");
    expect(order(moveCard(cards, "a", "d", "after"))).toBe("bcda");
    expect(order(moveCard(cards, "d", "a", "before"))).toBe("dabc");
  });

  it("keeps the card entries as they are", () => {
    const moved = moveCard(cards, "a", "d", "after");
    expect(moved[3]).toBe(cards[0]);
  });

  it("returns the same array when nothing would change", () => {
    expect(moveCard(cards, "a", "a", "after")).toBe(cards);
    expect(moveCard(cards, "a", "b", "before")).toBe(cards);
    expect(moveCard(cards, "b", "a", "after")).toBe(cards);
    expect(moveCard(cards, "x", "a", "before")).toBe(cards);
    expect(moveCard(cards, "a", "x", "before")).toBe(cards);
  });
});

describe("keyboard moves", () => {
  const ids = ["a", "b", "c"];

  it("steps to the neighbouring card and stops at either end", () => {
    expect(adjacentCardId(ids, "b", 1)).toBe("c");
    expect(adjacentCardId(ids, "b", -1)).toBe("a");
    expect(adjacentCardId(ids, "c", 1)).toBeNull();
    expect(adjacentCardId(ids, "a", -1)).toBeNull();
    expect(adjacentCardId(ids, "x", 1)).toBeNull();
  });

  it("lands past the target in the direction moved, so one step swaps neighbours", () => {
    expect(keyboardDropSide(ids, "a", "b")).toBe("after");
    expect(keyboardDropSide(ids, "c", "b")).toBe("before");
    expect(moveCard(ids.map((id) => ({ id })), "a", "b", keyboardDropSide(ids, "a", "b")).map((c) => c.id)).toEqual(["b", "a", "c"]);
  });
});
