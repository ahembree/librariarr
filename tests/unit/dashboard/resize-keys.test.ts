import { describe, it, expect } from "vitest";
import { HEIGHT_STEP_PX, heightForKey, snapCardHeight, widthForKey } from "@/lib/dashboard/resize-keys";
import { MAX_CARD_HEIGHT, MIN_CARD_HEIGHT } from "@/lib/dashboard/card-registry";

describe("widthForKey", () => {
  it("moves a column at a time within the card's limits", () => {
    expect(widthForKey("ArrowRight", 6, 2, 12)).toBe(7);
    expect(widthForKey("ArrowLeft", 6, 2, 12)).toBe(5);
    expect(widthForKey("ArrowLeft", 2, 2, 12)).toBe(2);
    expect(widthForKey("ArrowRight", 12, 2, 12)).toBe(12);
  });

  it("jumps to the limits with Home and End, and ignores other keys", () => {
    expect(widthForKey("Home", 6, 3, 10)).toBe(3);
    expect(widthForKey("End", 6, 3, 10)).toBe(10);
    expect(widthForKey("ArrowUp", 6, 2, 12)).toBeNull();
    expect(widthForKey("a", 6, 2, 12)).toBeNull();
  });
});

describe("heightForKey", () => {
  it("steps from the current height, snapped, within the limits", () => {
    expect(heightForKey("ArrowDown", 300)).toBe(300 + HEIGHT_STEP_PX);
    expect(heightForKey("ArrowUp", 300)).toBe(300 - HEIGHT_STEP_PX);
    // A measured height off the grid of steps snaps first.
    expect(heightForKey("ArrowDown", 337)).toBe(400);
    expect(heightForKey("ArrowUp", MIN_CARD_HEIGHT)).toBe(MIN_CARD_HEIGHT);
    expect(heightForKey("ArrowDown", MAX_CARD_HEIGHT)).toBe(MAX_CARD_HEIGHT);
    expect(heightForKey("ArrowDown", 2000)).toBe(MAX_CARD_HEIGHT);
  });

  it("jumps to the limits with Home and End, and ignores other keys", () => {
    expect(heightForKey("Home", 500)).toBe(MIN_CARD_HEIGHT);
    expect(heightForKey("End", 500)).toBe(MAX_CARD_HEIGHT);
    expect(heightForKey("ArrowLeft", 500)).toBeNull();
  });
});

describe("snapCardHeight", () => {
  it("rounds to the step and clamps", () => {
    expect(snapCardHeight(324)).toBe(300);
    expect(snapCardHeight(325)).toBe(350);
    expect(snapCardHeight(10)).toBe(MIN_CARD_HEIGHT);
    expect(snapCardHeight(5000)).toBe(MAX_CARD_HEIGHT);
  });
});
