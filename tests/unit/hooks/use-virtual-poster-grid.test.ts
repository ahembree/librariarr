// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, useCallback, useEffect, type ReactNode } from "react";
import { render, act } from "@testing-library/react";
import {
  useVirtualPosterGrid,
  GRID_GAP,
  POSTER_ASPECT,
  SQUARE_ASPECT,
  type VirtualPosterGrid,
  type VirtualPosterGridOptions,
} from "@/hooks/use-virtual-poster-grid";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";

// happy-dom lays nothing out, so the layout is stubbed: every box is 1000px
// wide, the scroll viewport 800px tall, and a rendered row measures what the
// grid estimated for it.
const WIDTH = 1000;
const HEIGHT = 800;
let rowHeightForRects = 0;

let main: HTMLElement;

function stubViewport(el: HTMLElement) {
  Object.defineProperty(el, "offsetHeight", { value: HEIGHT, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: HEIGHT, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(WIDTH);
  // The virtualizer measures a rendered row by its offsetHeight.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-index") ? rowHeightForRects : 0;
  });
  main = document.createElement("main");
  stubViewport(main);
  document.body.appendChild(main);
});

afterEach(() => {
  vi.restoreAllMocks();
  main.remove();
});

interface Item {
  id: string;
}
const itemsOf = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: `i${i}` }));

/** Row height the grid uses: column width × aspect + the content under the art + the gap. */
function rowHeightOf(columns: number, aspect: number, contentHeight: number) {
  const columnWidth = (WIDTH - GRID_GAP * (columns - 1)) / columns;
  return Math.round(columnWidth * aspect + contentHeight + GRID_GAP);
}

let lastGrid: VirtualPosterGrid | null = null;

function Grid({
  items,
  options,
  renderItem,
  className,
}: {
  items: Item[];
  options: Omit<VirtualPosterGridOptions, "count">;
  renderItem?: (item: Item, ctx: GridCardContext) => ReactNode;
  className?: string;
}) {
  const grid = useVirtualPosterGrid({ ...options, count: items.length });
  useEffect(() => {
    lastGrid = grid;
  });
  const renderCard = useCallback(
    (item: Item, ctx: GridCardContext) =>
      renderItem
        ? renderItem(item, ctx)
        : createElement("div", { "data-card": item.id, "data-priority": String(ctx.priority) }),
    [renderItem],
  );
  return createElement(VirtualCardGrid<Item>, { grid, items, getKey: (i: Item) => i.id, renderItem: renderCard, className });
}

const POSTER = { columns: 4, aspect: POSTER_ASPECT, contentHeight: 150, scrollElement: "main" as const, overscan: 0 };

function renderGrid(items: Item[], options: Omit<VirtualPosterGridOptions, "count"> = POSTER, renderItem?: Parameters<typeof Grid>[0]["renderItem"]) {
  rowHeightForRects = rowHeightOf(options.columns, options.aspect, options.contentHeight);
  return render(createElement(Grid, { items, options, renderItem }), { container: main });
}

describe("useVirtualPosterGrid + VirtualCardGrid", () => {
  it("renders only the rows in view, each a grid of `columns` cards", () => {
    const { container } = renderGrid(itemsOf(100));
    const visibleRows = Math.ceil(HEIGHT / rowHeightForRects);
    const cards = container.querySelectorAll("[data-card]");
    expect(cards.length).toBe(visibleRows * 4);
    expect(cards[0].getAttribute("data-card")).toBe("i0");
    const inner = container.firstChild!.firstChild as HTMLElement;
    expect(inner.style.height).toBe(`${25 * rowHeightForRects}px`);
    expect((container.querySelector("[data-index='0'] > div") as HTMLElement).style.gridTemplateColumns).toBe(
      "repeat(4, minmax(0, 1fr))",
    );
  });

  it("marks the first rows as priority and fills a short last row", () => {
    const { container } = renderGrid(itemsOf(10), { ...POSTER, overscan: 2 });
    const cards = [...container.querySelectorAll("[data-card]")];
    expect(cards.map((c) => c.getAttribute("data-card"))).toEqual(itemsOf(10).map((i) => i.id));
    expect(cards.slice(0, 8).every((c) => c.getAttribute("data-priority") === "true")).toBe(true);
    expect(cards[8].getAttribute("data-priority")).toBe("false");
  });

  it("re-renders no mounted card when the page re-renders with the same items", () => {
    const renderItem = vi.fn((item: Item) => createElement("div", { "data-card": item.id }));
    const items = itemsOf(8);
    const { rerender } = renderGrid(items, POSTER, renderItem);
    const calls = renderItem.mock.calls.length;
    expect(calls).toBe(8);
    rerender(createElement(Grid, { items, options: POSTER, renderItem }));
    expect(renderItem.mock.calls.length).toBe(calls);
  });

  it("sizes rows from the artwork's aspect and the content under it", () => {
    const options = { ...POSTER, aspect: SQUARE_ASPECT, contentHeight: 100 };
    renderGrid(itemsOf(40), options);
    expect(lastGrid!.virtualizer.getTotalSize()).toBe(10 * rowHeightOf(4, SQUARE_ASPECT, 100));
    expect(lastGrid!.rowRange(9)).toEqual([36, 40]);
    expect(lastGrid!.rowCount).toBe(10);
  });

  it("restores by index: the centre item, and scrolling one back to the centre", () => {
    const { container } = renderGrid(itemsOf(100));
    const rowHeight = rowHeightForRects;
    // Scrolled, the grid's top moves up the viewport by as much.
    const gridEl = container.firstChild as HTMLElement;
    vi.spyOn(gridEl, "getBoundingClientRect").mockImplementation(
      () => ({ top: -main.scrollTop, left: 0, right: WIDTH, bottom: 0, width: WIDTH, height: 0, x: 0, y: 0, toJSON: () => ({}) }),
    );
    main.scrollTop = rowHeight * 3;
    expect(lastGrid!.getFirstVisibleIndex()).toBe(Math.floor((rowHeight * 3 + HEIGHT / 2) / rowHeight) * 4);
    const scrollTo = vi.fn();
    main.scrollTo = scrollTo as unknown as typeof main.scrollTo;
    expect(lastGrid!.scrollToIndex(40)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({
      top: Math.max(0, 10 * rowHeight + rowHeight / 2 - HEIGHT / 2),
      behavior: "instant",
    });
  });

  it("reports nothing to restore without a scroll element", () => {
    main.remove();
    rowHeightForRects = rowHeightOf(4, POSTER_ASPECT, 150);
    render(createElement(Grid, { items: itemsOf(10), options: POSTER }));
    expect(lastGrid!.getFirstVisibleIndex()).toBe(-1);
    expect(lastGrid!.scrollToIndex(5)).toBe(false);
  });

  it("scrolls its own box when told to", () => {
    const options = { ...POSTER, scrollElement: "own" as const };
    rowHeightForRects = rowHeightOf(4, POSTER_ASPECT, 150);
    // The grid's outer element is its scroll box: give it a viewport.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-index")) return rowHeightForRects;
      return this.classList.contains("scroll-box") ? HEIGHT : 0;
    });
    const { container } = render(createElement(Grid, { items: itemsOf(100), options, className: "scroll-box" }));
    const box = container.firstChild as HTMLElement;
    // The virtualizer scrolls the box itself, with no margin to subtract.
    expect(lastGrid!.scrollElement).toBe(box);
    expect(lastGrid!.virtualizer.scrollElement).toBe(box);
    expect(lastGrid!.virtualizer.options.scrollMargin).toBe(0);
    expect(box.className).toBe("scroll-box");
    expect(lastGrid!.virtualizer.getTotalSize()).toBe(25 * rowHeightForRects);
  });

  it("re-measures when the column count changes", () => {
    const { rerender } = renderGrid(itemsOf(60));
    rowHeightForRects = rowHeightOf(6, POSTER_ASPECT, 150);
    act(() => rerender(createElement(Grid, { items: itemsOf(60), options: { ...POSTER, columns: 6 } })));
    expect(lastGrid!.rowCount).toBe(10);
    expect(lastGrid!.virtualizer.getTotalSize()).toBe(10 * rowHeightOf(6, POSTER_ASPECT, 150));
  });
});
