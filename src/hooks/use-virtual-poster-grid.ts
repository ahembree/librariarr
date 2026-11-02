"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer, type Virtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { estimateContentWidth } from "@/hooks/use-card-size";
import { useDeferredOverscan } from "@/hooks/use-deferred-overscan";

/** The grids' gap between cards and between rows (1rem). */
export const GRID_GAP = 16;

/** Artwork height / width: a poster, square cover art, a 16:9 still. */
export const POSTER_ASPECT = 1.5;
export const SQUARE_ASPECT = 1;
export const WIDE_ASPECT = 9 / 16;

export interface VirtualPosterGridOptions {
  /** How many cards the grid holds. */
  count: number;
  /** Cards per row (`useCardSize().columns`). */
  columns: number;
  /** Artwork height / width — `POSTER_ASPECT`, `SQUARE_ASPECT`, `WIDE_ASPECT`. */
  aspect: number;
  /**
   * Everything under the artwork in one card: its content block, a quality bar,
   * the card's border (`CARD_CONTENT_HEIGHT` + `QUALITY_BAR_HEIGHT` + 2).
   */
  contentHeight: number;
  /**
   * `"main"`: the page scrolls, inside the shell's `<main>` — the library
   * pages. `"own"`: the grid is its own scroll box (a card inside a page, a
   * dialog) — `containerRef` goes on that box.
   */
  scrollElement: "main" | "own";
  /** Rows rendered past the viewport. Default: one, widening to three after the first paint. */
  overscan?: number;
  gap?: number;
  /**
   * Re-measure where the grid starts inside `<main>` when this changes —
   * whatever above it can move it (a filter bar opening, a banner).
   */
  layoutKey?: unknown;
  /** The scroll box's size before it can be measured (tests; a first render). */
  initialRect?: { width: number; height: number };
}

export interface VirtualPosterGrid {
  /** On the grid's own wrapper (`"main"`) or on its scroll box (`"own"`). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLElement, Element>;
  /** The rows to render now. */
  rows: VirtualItem[];
  rowCount: number;
  columns: number;
  gap: number;
  /** A row's `[start, end)` item indices. */
  rowRange: (rowIndex: number) => [number, number];
  /** A row's offset inside the grid (its virtual start, less the scroll margin). */
  rowOffset: (row: VirtualItem) => number;
  /** The scroll element once known — for `useVirtualGridAlphabet`/`useTableAlphabet`. */
  scrollElement: HTMLElement | null;
  /** The item at the viewport's centre, for `useScrollRestoration`; -1 before the grid is laid out. */
  getFirstVisibleIndex: () => number;
  /** Centre `index` in the viewport, for `useScrollRestoration`; false before the grid is laid out. */
  scrollToIndex: (index: number) => boolean;
}

function findMain(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector<HTMLElement>("main");
}

/**
 * The row virtualizer behind every poster grid — the library pages, the Query
 * results, the rule preview, Matches and Pending each set one up by hand: the
 * row height from the column width and the artwork's aspect, the scroll
 * margin of a grid inside `<main>`, re-measuring when the column count
 * changes, the deferred overscan, and the index-based scroll restoration that
 * pixel offsets cannot do for virtualized rows. Render it with
 * `VirtualCardGrid`.
 */
export function useVirtualPosterGrid({
  count,
  columns,
  aspect,
  contentHeight,
  scrollElement: mode,
  overscan,
  gap = GRID_GAP,
  layoutKey,
  initialRect,
}: VirtualPosterGridOptions): VirtualPosterGrid {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const cols = Math.max(1, columns);
  const rowCount = count > 0 ? Math.ceil(count / cols) : 0;

  useLayoutEffect(() => {
    const element = mode === "main" ? findMain() : containerRef.current;
    scrollRef.current = element;
    setScrollElement(element);
  }, [mode]);

  // Where the grid starts in `<main>`'s content. The grid mounts behind a
  // skeleton, so this is measured again once it has items.
  useLayoutEffect(() => {
    if (mode !== "main") return;
    const main = scrollRef.current;
    const grid = containerRef.current;
    if (!main || !grid) return;
    setScrollMargin(
      Math.round(grid.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop),
    );
  }, [mode, rowCount, layoutKey]);

  const rowHeight = useCallback(() => {
    const width = containerRef.current?.offsetWidth || estimateContentWidth(window.innerWidth);
    const columnWidth = (width - gap * (cols - 1)) / cols;
    return Math.round(columnWidth * aspect + contentHeight + gap);
  }, [gap, cols, aspect, contentHeight]);

  const deferredOverscan = useDeferredOverscan(rowCount > 0);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: rowHeight,
    overscan: overscan ?? deferredOverscan,
    scrollMargin: mode === "main" ? scrollMargin : 0,
    initialRect,
  });

  // A new column count or card shape changes every row's height.
  useEffect(() => {
    virtualizer.measure();
  }, [cols, aspect, contentHeight, virtualizer]);

  /** The grid's top inside the scroll element's content, or null before both exist. */
  const gridTop = useCallback((): number | null => {
    const scroller = scrollRef.current;
    const grid = containerRef.current;
    if (!scroller || !grid) return null;
    if (mode === "own") return 0;
    return grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }, [mode]);

  const getFirstVisibleIndex = useCallback(() => {
    const top = gridTop();
    const scroller = scrollRef.current;
    const height = rowHeight();
    if (top === null || !scroller || height <= 0) return -1;
    const centreInGrid = scroller.scrollTop + scroller.clientHeight / 2 - top;
    return Math.max(0, Math.floor(centreInGrid / height)) * cols;
  }, [gridTop, rowHeight, cols]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const top = gridTop();
      const scroller = scrollRef.current;
      if (top === null || !scroller) return false;
      const height = rowHeight();
      const row = Math.floor(index / cols);
      scroller.scrollTo({
        top: Math.max(0, top + row * height + height / 2 - scroller.clientHeight / 2),
        behavior: "instant",
      });
      return true;
    },
    [gridTop, rowHeight, cols],
  );

  const rowRange = useCallback(
    (rowIndex: number): [number, number] => [rowIndex * cols, Math.min(count, (rowIndex + 1) * cols)],
    [cols, count],
  );

  const margin = virtualizer.options.scrollMargin;
  const rowOffset = useCallback((row: VirtualItem) => row.start - margin, [margin]);

  return {
    containerRef,
    virtualizer,
    rows: virtualizer.getVirtualItems(),
    rowCount,
    columns: cols,
    gap,
    rowRange,
    rowOffset,
    scrollElement,
    getFirstVisibleIndex,
    scrollToIndex,
  };
}
