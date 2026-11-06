/**
 * Where a dashboard card dragged in edit mode lands.
 *
 * The cards differ in width and height, so the grid is not reshuffled while a
 * card is dragged: a sorting strategy that slides neighbours aside assumes
 * cards of one size and stretched or overlapped them, and reflowing on every
 * move made the card under the pointer change with each reflow. Instead the
 * card nearest the pointer is the target, and which half of it the pointer is
 * in says whether the dragged card goes before or after it.
 */

export type DropSide = "before" | "after";

/** `x`: the marker sits beside the target. `y`: above or below a card that fills its row. */
export type DropAxis = "x" | "y";

export interface DropPoint {
  x: number;
  y: number;
}

export interface DropRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface DropTarget<Id> {
  id: Id;
  side: DropSide;
  axis: DropAxis;
  /** From the point to the target's edge; 0 inside it. */
  distance: number;
}

/** A card at least this share of the grid's width fills its row: it is dropped on above or below. */
const ROW_FILL_RATIO = 0.9;

/** Distance from a point to the nearest edge of a rectangle (0 inside it). */
export function distanceToRect(point: DropPoint, rect: DropRect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - (rect.left + rect.width));
  const dy = Math.max(rect.top - point.y, 0, point.y - (rect.top + rect.height));
  return Math.hypot(dx, dy);
}

/** Cards whose tops are this close stand in one grid row. */
const ROW_TOLERANCE_PX = 2;

/**
 * The cards of the grid row whose height spans `y` (a row is as tall as its
 * tallest card), or none when `y` is in a gap between rows.
 */
function rowAt<T extends { rect: DropRect }>(y: number, cards: readonly T[]): T[] {
  return cards.filter((card) => {
    const rowTop = card.rect.top;
    const peers = cards.filter((c) => Math.abs(c.rect.top - rowTop) <= ROW_TOLERANCE_PX);
    const rowBottom = Math.max(...peers.map((c) => c.rect.top + c.rect.height));
    return y >= rowTop && y <= rowBottom;
  });
}

/**
 * The card a drop at `point` is placed beside, and on which side.
 *
 * Within a grid row (cards share their top) the nearest card of that row is
 * the target, so the empty end of a row drops after its last card rather
 * than beside the card above. In a gap between rows it is the nearest card
 * overall. A card spanning the grid's width (read from the cards themselves)
 * is dropped on above or below; any other card before or after.
 */
export function pickDropTarget<Id>(
  point: DropPoint,
  cards: readonly { id: Id; rect: DropRect }[],
): DropTarget<Id> | null {
  if (cards.length === 0) return null;
  const row = rowAt(point.y, cards);
  const candidates = row.length > 0 ? row : cards;

  let nearest: { id: Id; rect: DropRect; distance: number } | null = null;
  for (const card of candidates) {
    const distance = distanceToRect(point, card.rect);
    if (nearest === null || distance < nearest.distance) nearest = { id: card.id, rect: card.rect, distance };
  }
  if (nearest === null) return null;

  const gridLeft = Math.min(...cards.map((c) => c.rect.left));
  const gridRight = Math.max(...cards.map((c) => c.rect.left + c.rect.width));
  const { rect } = nearest;
  const axis: DropAxis = rect.width >= (gridRight - gridLeft) * ROW_FILL_RATIO ? "y" : "x";
  const before = axis === "x"
    ? point.x < rect.left + rect.width / 2
    : point.y < rect.top + rect.height / 2;
  return { id: nearest.id, side: before ? "before" : "after", axis, distance: nearest.distance };
}

/**
 * The side a keyboard move lands on: past the target in the direction moved,
 * so one step right (or down) swaps a card with the next one.
 */
export function keyboardDropSide<Id>(order: readonly Id[], activeId: Id, targetId: Id): DropSide {
  return order.indexOf(targetId) > order.indexOf(activeId) ? "after" : "before";
}

/**
 * The card one step from `fromId` in the grid's order, for the keyboard:
 * `step` -1 for an earlier card, +1 for a later one. Stays put at either end.
 */
export function adjacentCardId<Id>(order: readonly Id[], fromId: Id, step: -1 | 1): Id | null {
  const index = order.indexOf(fromId);
  if (index === -1) return null;
  const next = index + step;
  return next >= 0 && next < order.length ? order[next] : null;
}

/**
 * The cards with `activeId` moved before or after `targetId`. The same array
 * comes back when nothing would change (dropped on itself, on a missing card,
 * or into the place it already holds), so the caller saves only real moves.
 */
export function moveCard<T extends { id: string }>(
  cards: T[],
  activeId: string,
  targetId: string,
  side: DropSide,
): T[] {
  if (activeId === targetId) return cards;
  const from = cards.findIndex((c) => c.id === activeId);
  if (from === -1 || !cards.some((c) => c.id === targetId)) return cards;
  const rest = cards.filter((_, i) => i !== from);
  const at = rest.findIndex((c) => c.id === targetId) + (side === "after" ? 1 : 0);
  if (at === from) return cards;
  return [...rest.slice(0, at), cards[from], ...rest.slice(at)];
}
