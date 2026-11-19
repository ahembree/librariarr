"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { findScrollContainer } from "@/lib/scroll-utils";

/**
 * Where each of a page's lists was: the key of the item at the centre of the
 * list's view, by list id. The page owns one (`useState(() => new Map())`)
 * and hands it to both views of every list.
 */
export type ListPositionMemory = Map<string, string>;

/** An item's place in the list's content: px from the top of the list box's content. */
export interface ListItemBox {
  top: number;
  height: number;
}

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
  /** Where the item at `index` sits in the list box's content, or null. */
  boxOfIndex: (index: number) => ListItemBox | null;
  /** The key of the item at `index`. */
  keyAt: (index: number) => string | undefined;
  /** The index of the item with `key`, or -1 when this view does not hold it. */
  indexOfKey: (key: string) => number;
  /**
   * Centre the item at `index` in the list's own box, through its virtualizer:
   * it re-aims as the rows on the way are measured (an offset worked out from
   * estimated rows lands rows away), and it writes back an offset it was not
   * told about while it settles.
   */
  scrollBoxToIndex: (index: number) => void;
}

/** The list's view: its own box when that scrolls, else the page's scroll box around it. */
interface ListView {
  /** Whether the list's own box is the view (else the page's scroll box is). */
  ownBox: boolean;
  /** The offset into the list's content now at the centre of what shows of it, or null when none shows. */
  centre: number | null;
  /** Whether the list is at its start. */
  atStart: boolean;
  /** Scroll so the content offset `offset` sits at the view's centre. */
  centreOn: (offset: number) => void;
}

function listView(list: HTMLElement): ListView | null {
  const page = findScrollContainer();
  // A box capped in height scrolls itself (`md:max-h-[60dvh]` from a tablet
  // up). On a phone the cap is off: the box grows with its list and the page
  // scrolls it, so the view is the part of the box the page shows. Capped
  // means shorter than the page's scroll box: an uncapped box can still
  // scroll a little (absolutely placed rows overhanging its flow height).
  const capped = !page || list.clientHeight < page.clientHeight;
  if (capped && list.scrollHeight - list.clientHeight > 1) {
    return {
      ownBox: true,
      centre: list.scrollTop + list.clientHeight / 2,
      atStart: list.scrollTop <= 0,
      centreOn: (offset) => {
        list.scrollTop = Math.max(0, offset - list.clientHeight / 2);
      },
    };
  }
  if (!page) return null;
  const pageRect = page.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  const top = Math.max(listRect.top, pageRect.top);
  const bottom = Math.min(listRect.bottom, pageRect.top + page.clientHeight);
  return {
    ownBox: false,
    centre: bottom > top ? (top + bottom) / 2 - listRect.top : null,
    atStart: listRect.top >= pageRect.top,
    centreOn: (offset) => {
      const target = listRect.top + offset;
      page.scrollTop = Math.max(0, page.scrollTop + target - (pageRect.top + page.clientHeight / 2));
    },
  };
}

/**
 * Keeps a list's place when it is shown another way. Pending and Matches draw
 * each rule set's items as a table or as a card grid, so switching the view
 * replaced the list and it started again from its first item. The view
 * records the item at the centre of what shows of the list as the user
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
      const { getScrollElement, indexOfKey, boxOfIndex, indexAtOffset, scrollBoxToIndex } = optionsRef.current;
      const list = getScrollElement();
      const index = indexOfKey(key);
      const view = list ? listView(list) : null;
      if (!list || !view || index <= 0) return;
      if (view.ownBox) {
        scrollBoxToIndex(index);
      } else {
        // A box that grows with its list: every row is drawn and measured.
        const box = boxOfIndex(index);
        if (!box) return;
        view.centreOn(box.top + box.height / 2);
      }
      const centre = listView(list)?.centre;
      lastCentre.current = centre != null ? indexAtOffset(centre) : -1;
    });
    return () => cancelAnimationFrame(frame);
  }, [memory, listId, ready]);

  // Record the centre item as the user moves the list off it: the list's own
  // box scrolling, or the page scrolling a box that grows with its list.
  useEffect(() => {
    if (!memory || !ready) return;
    const list = optionsRef.current.getScrollElement();
    if (!list) return;
    const record = () => {
      // Not before this view's restore has run: mounting it moves the list
      // (the page clamped to the new view's height, the box starting at 0),
      // and recording that would overwrite the item it is about to restore.
      if (!restored.current) return;
      const view = listView(list);
      if (!view) return;
      if (view.atStart) {
        memory.delete(listId);
        lastCentre.current = -1;
        return;
      }
      if (view.centre == null) return;
      const index = optionsRef.current.indexAtOffset(view.centre);
      if (index === lastCentre.current) return;
      lastCentre.current = index;
      const key = index >= 0 ? optionsRef.current.keyAt(index) : undefined;
      if (key !== undefined) memory.set(listId, key);
    };
    const page = findScrollContainer();
    list.addEventListener("scroll", record, { passive: true });
    if (page && page !== list) page.addEventListener("scroll", record, { passive: true });
    return () => {
      list.removeEventListener("scroll", record);
      if (page && page !== list) page.removeEventListener("scroll", record);
    };
  }, [memory, listId, ready]);
}
