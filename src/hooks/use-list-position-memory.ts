"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Where each of a page's lists was: the key of the item at the centre of the
 * list's box, by list id. The page owns one (`useState(() => new Map())`) and
 * hands it to both views of every list.
 */
export type ListPositionMemory = Map<string, string>;

export interface ListPositionOptions {
  /** The page's memory; without one nothing is kept. */
  memory: ListPositionMemory | undefined;
  /** Which list this is (a rule set's id, with whatever else tells two apart). */
  listId: string;
  /** The list's own box (a ref read in a layout effect). */
  getScrollElement: () => HTMLElement | null;
  /** False until the view can lay out its items (a grid whose box is not known yet). */
  ready?: boolean;
  /**
   * The item at `offset` px into the list box's content, or -1. A view may
   * answer coarser than the item (a card grid: the first item of the row).
   */
  indexAtOffset: (offset: number) => number;
  /** The key of the item at `index`. */
  keyAt: (index: number) => string | undefined;
  /** The index of the item with `key`, or -1 when this view does not hold it. */
  indexOfKey: (key: string) => number;
  /**
   * Centre the item at `index` in the list's box, through its virtualizer: it
   * re-aims as the rows on the way are measured (an offset worked out from
   * estimated rows lands rows away), and it writes back an offset it was not
   * told about while it settles.
   */
  scrollBoxToIndex: (index: number) => void;
}

/**
 * Whether the list scrolls in its own box: one capped in height
 * (`md:max-h-[60dvh]`, from a tablet up) with more to show than fits. On a
 * phone the cap is off and the box grows with its list; the page scrolls it,
 * and the view toggle sits above the list, so reaching it brings the list's
 * start back on screen: there is no place inside the list to keep, and the
 * page keeps its own offset across the switch.
 */
function scrollsItself(list: HTMLElement): boolean {
  if (list.scrollHeight - list.clientHeight <= 1) return false;
  const cap = getComputedStyle(list).maxHeight;
  return cap !== "none" && cap !== "";
}

/**
 * Keeps a list's place when it is shown another way. Pending and Matches draw
 * each rule set's items as a table or as a card grid, each in its own box, so
 * switching the view replaced the box and the list started again from its
 * first item. The view records the item at the centre of its box as the user
 * scrolls; the other view, mounting, centres that same item.
 *
 * By key, not index: the card grid leaves out rows the table shows (an action
 * whose media item is gone), so the same index is not the same item.
 */
export function useListPositionMemory(options: ListPositionOptions): void {
  const { memory, listId, ready = true } = options;
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  // The centre index this view last recorded, or reached by restoring. A view
  // reports its centre coarser than the item kept (a card grid by row), so
  // the restore's own scroll re-recording it would swap the kept item for
  // the first of its row and walk the list on every switch.
  const lastCentre = useRef(-1);

  // Once per mount, as soon as the view can lay out its items: centre the
  // kept item. A frame later, not in the mount's own layout pass: a table's
  // virtualizer starts from the offset it read on mounting (0) and writes it
  // back while it settles its first measurements, which undid a scroll made
  // before that.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (!memory || !ready || restored.current) return;
    if (!optionsRef.current.getScrollElement()) return;
    const key = memory.get(listId);
    if (key === undefined) {
      restored.current = true;
      return;
    }
    // Marked done when it runs: a cleanup before then (Strict Mode's second
    // effect pass) cancels this frame, and the next pass schedules it again.
    const frame = requestAnimationFrame(() => {
      restored.current = true;
      const { getScrollElement, indexOfKey, indexAtOffset, scrollBoxToIndex } = optionsRef.current;
      const list = getScrollElement();
      const index = indexOfKey(key);
      if (!list || index <= 0 || !scrollsItself(list)) return;
      scrollBoxToIndex(index);
      lastCentre.current = indexAtOffset(list.scrollTop + list.clientHeight / 2);
    });
    return () => cancelAnimationFrame(frame);
  }, [memory, listId, ready]);

  // Record the centre item as the user moves the list off it.
  useEffect(() => {
    if (!memory || !ready) return;
    const list = optionsRef.current.getScrollElement();
    if (!list) return;
    const record = () => {
      // Not before this view's restore has run: mounting it moves the list
      // (a new box starts at 0), and recording that would overwrite the item
      // it is about to restore.
      if (!restored.current) return;
      if (list.scrollTop <= 0) {
        memory.delete(listId);
        lastCentre.current = -1;
        return;
      }
      const index = optionsRef.current.indexAtOffset(list.scrollTop + list.clientHeight / 2);
      if (index === lastCentre.current) return;
      lastCentre.current = index;
      const key = index >= 0 ? optionsRef.current.keyAt(index) : undefined;
      if (key !== undefined) memory.set(listId, key);
    };
    list.addEventListener("scroll", record, { passive: true });
    return () => list.removeEventListener("scroll", record);
  }, [memory, listId, ready]);
}
