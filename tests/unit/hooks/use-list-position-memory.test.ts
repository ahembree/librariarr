// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useListPositionMemory, type ListPositionMemory, type ListPositionOptions } from "@/hooks/use-list-position-memory";

const KEYS = Array.from({ length: 100 }, (_, i) => `item-${i}`);
/** Every item is 10px tall. */
const ROW = 10;

let main: HTMLElement;
let box: HTMLDivElement;
let frames: FrameRequestCallback[];

/** happy-dom does no layout: give an element the geometry a browser would. */
function layout(el: HTMLElement, geometry: { top: number; height: number; scrollHeight: number }) {
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => geometry.height });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => geometry.scrollHeight });
  el.getBoundingClientRect = () => ({ top: geometry.top, bottom: geometry.top + geometry.height, height: geometry.height }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = "";
  main = document.createElement("main");
  box = document.createElement("div");
  main.append(box);
  document.body.append(main);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames[id - 1] = () => {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const runFrames = () => {
  const pending = frames;
  frames = [];
  for (const cb of pending) cb(0);
};

function options(memory: ListPositionMemory, overrides: Partial<ListPositionOptions> = {}): ListPositionOptions {
  return {
    memory,
    listId: "PENDING:rs-1",
    getScrollElement: () => box,
    indexAtOffset: (offset) => Math.min(KEYS.length - 1, Math.floor(offset / ROW)),
    keyAt: (index) => KEYS[index],
    indexOfKey: (key) => KEYS.indexOf(key),
    // The view's virtualizer, centring the item in the 100px box.
    scrollBoxToIndex: (index) => {
      box.scrollTop = Math.max(0, index * ROW + ROW / 2 - 50);
    },
    ...overrides,
  };
}

describe("useListPositionMemory — a list box that scrolls itself", () => {
  // A 100px box over 1000px of items: its centre is scrollTop + 50.
  beforeEach(() => {
    layout(main, { top: 0, height: 600, scrollHeight: 600 });
    layout(box, { top: 100, height: 100, scrollHeight: KEYS.length * ROW });
    // Capped: `md:max-h-[60dvh]` from a tablet up.
    box.style.maxHeight = "100px";
  });

  const scrollBox = (top: number) => {
    box.scrollTop = top;
    box.dispatchEvent(new Event("scroll"));
  };

  it("records the key at the centre of the box as it scrolls", () => {
    const memory: ListPositionMemory = new Map();
    renderHook(() => useListPositionMemory(options(memory)));
    scrollBox(370); // centre 420 → item 42
    expect(memory.get("PENDING:rs-1")).toBe("item-42");
    scrollBox(80); // centre 130 → item 13
    expect(memory.get("PENDING:rs-1")).toBe("item-13");
  });

  it("forgets the list once it is back at its top", () => {
    const memory: ListPositionMemory = new Map([["PENDING:rs-1", "item-42"]]);
    renderHook(() => useListPositionMemory(options(memory)));
    runFrames();
    scrollBox(0);
    expect(memory.has("PENDING:rs-1")).toBe(false);
  });

  it("a view mounting with a kept key centres that item, by key not index", () => {
    // The other view held the item at index 42; this one holds it at 40
    // (the card grid leaves out rows the table shows).
    const memory: ListPositionMemory = new Map([["PENDING:rs-1", "item-42"]]);
    renderHook(() => useListPositionMemory(options(memory, { indexOfKey: (key) => KEYS.indexOf(key) - 2 })));
    // A frame later, once the view's virtualizer has settled.
    expect(box.scrollTop).toBe(0);
    runFrames();
    // Item 40 spans 400–410: its centre 405 at the box's centre (50).
    expect(box.scrollTop).toBe(355);
  });

  it("restores once per mount", () => {
    const memory: ListPositionMemory = new Map([["PENDING:rs-1", "item-42"]]);
    const { rerender } = renderHook(() => useListPositionMemory(options(memory)));
    runFrames();
    box.scrollTop = 0;
    rerender();
    runFrames();
    expect(box.scrollTop).toBe(0);
  });

  it("waits until the view is ready", () => {
    const memory: ListPositionMemory = new Map([["PENDING:rs-1", "item-42"]]);
    let ready = false;
    const { rerender } = renderHook(() => useListPositionMemory(options(memory, { ready })));
    runFrames();
    expect(box.scrollTop).toBe(0);
    ready = true;
    rerender();
    runFrames();
    expect(box.scrollTop).toBe(375);
  });

  it("a restore cancelled before its frame (Strict Mode's second pass) is scheduled again", () => {
    const memory: ListPositionMemory = new Map([
      ["PENDING:rs-1", "item-42"],
      ["PENDING:rs-2", "item-7"],
    ]);
    let listId = "PENDING:rs-1";
    const { rerender } = renderHook(() => useListPositionMemory(options(memory, { listId })));
    // The effect re-runs (its cleanup cancels the first frame) before any frame.
    listId = "PENDING:rs-2";
    rerender();
    runFrames();
    // Item 7 (70–80) centred: only the second restore ran.
    expect(box.scrollTop).toBe(25);
  });

  it("leaves a list with nothing kept, kept at its first item, or kept on an item it lacks, where it is", () => {
    for (const memory of [new Map(), new Map([["PENDING:rs-1", "item-0"]]), new Map([["PENDING:rs-1", "gone"]])]) {
      renderHook(() => useListPositionMemory(options(memory)));
    }
    runFrames();
    expect(box.scrollTop).toBe(0);
  });

  it("does not record the scroll its own mounting causes before restoring", () => {
    // Mounting the new view moved the box (it starts at 0, or the page clamped):
    // that scroll must not replace or forget the item about to be restored.
    const memory: ListPositionMemory = new Map([["PENDING:rs-1", "item-42"]]);
    renderHook(() => useListPositionMemory(options(memory)));
    scrollBox(0);
    expect(memory.get("PENDING:rs-1")).toBe("item-42");
    scrollBox(700);
    expect(memory.get("PENDING:rs-1")).toBe("item-42");
    runFrames();
    expect(box.scrollTop).toBe(375);
  });

  it("keeps the exact item while the view's coarser centre has not moved (a grid's row)", () => {
    // A grid of 10 a row, 100px a row, answering with the row's first item.
    const memory: ListPositionMemory = new Map([["PENDING:rs-1", "item-47"]]);
    renderHook(() =>
      useListPositionMemory(
        options(memory, {
          indexAtOffset: (offset) => Math.floor(offset / 100) * 10,
          // Centres the item's row: row 4 (400–500) at the box's centre (50).
          scrollBoxToIndex: (index) => {
            box.scrollTop = Math.floor(index / 10) * 100 + 50 - 50;
          },
        }),
      ),
    );
    runFrames();
    // Row 4 (400–500) centred.
    expect(box.scrollTop).toBe(400);
    // The restore's own scroll event, and settling within the same row.
    box.dispatchEvent(new Event("scroll"));
    scrollBox(405);
    expect(memory.get("PENDING:rs-1")).toBe("item-47");
    // Moved to another row: that row's item is kept now.
    scrollBox(600);
    expect(memory.get("PENDING:rs-1")).toBe("item-60");
  });
});

describe("useListPositionMemory — a phone, where the box grows with its list and the page scrolls it", () => {
  // No cap: the box is as tall as its items. The view toggle sits above the
  // list, so reaching it brings the list's start back on screen; the page
  // keeps its own offset and nothing inside the list is kept or restored.
  beforeEach(() => {
    layout(main, { top: 0, height: 600, scrollHeight: 2000 });
    layout(box, { top: 200, height: KEYS.length * ROW, scrollHeight: KEYS.length * ROW });
  });

  it("restores nothing", () => {
    const memory: ListPositionMemory = new Map([["PENDING:rs-1", "item-60"]]);
    const scrollBoxToIndex = vi.fn();
    renderHook(() => useListPositionMemory(options(memory, { scrollBoxToIndex })));
    runFrames();
    expect(scrollBoxToIndex).not.toHaveBeenCalled();
    expect(main.scrollTop).toBe(0);
  });

  it("a box that overhangs its flow height a little is still not a scroller of its own", () => {
    // Matches' table on a phone: absolutely placed rows make it scroll ~200px.
    layout(box, { top: 200, height: 8837, scrollHeight: 9036 });
    const scrollBoxToIndex = vi.fn();
    renderHook(() => useListPositionMemory(options(new Map([["PENDING:rs-1", "item-60"]]), { scrollBoxToIndex })));
    runFrames();
    expect(scrollBoxToIndex).not.toHaveBeenCalled();
  });
});
