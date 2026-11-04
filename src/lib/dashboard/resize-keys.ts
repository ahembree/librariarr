import { MAX_CARD_HEIGHT, MIN_CARD_HEIGHT } from "./card-registry";

/** A card's height moves in steps of this many pixels, by drag or by key. */
export const HEIGHT_STEP_PX = 50;

/** A height snapped to the step and kept within the card height limits. */
export function snapCardHeight(px: number): number {
  const snapped = Math.round(px / HEIGHT_STEP_PX) * HEIGHT_STEP_PX;
  return Math.max(MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, snapped));
}

/**
 * The width (in twelfths of the row) a key gives the width handle, or null
 * for a key it ignores: ArrowLeft/ArrowRight a column narrower or wider,
 * Home/End the narrowest and widest the card allows.
 */
export function widthForKey(key: string, current: number, min: number, max: number): number | null {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  switch (key) {
    case "ArrowLeft":
      return clamp(current - 1);
    case "ArrowRight":
      return clamp(current + 1);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

/**
 * The height a key gives the height handle, from the card's current height
 * (set or measured), or null for a key it ignores: ArrowUp/ArrowDown a step
 * shorter or taller, Home/End the shortest and tallest a card may be.
 */
export function heightForKey(key: string, currentPx: number): number | null {
  switch (key) {
    case "ArrowUp":
      return snapCardHeight(snapCardHeight(currentPx) - HEIGHT_STEP_PX);
    case "ArrowDown":
      return snapCardHeight(snapCardHeight(currentPx) + HEIGHT_STEP_PX);
    case "Home":
      return MIN_CARD_HEIGHT;
    case "End":
      return MAX_CARD_HEIGHT;
    default:
      return null;
  }
}
