import { describe, it, expect, afterEach, vi } from "vitest";
import { findScrollContainer } from "@/lib/scroll-utils";

/**
 * The vitest environment is "node", so there is no DOM. `findScrollContainer`
 * uses `document.querySelector`, `getComputedStyle`, `getBoundingClientRect`,
 * iterates `el.children`, and relies on `instanceof HTMLElement`. We stub all
 * of these with a minimal fake DOM so the function's logic runs in node.
 */

// <main>'s box in these tests: top 56 (under the shell header), 600 tall.
const MAIN_TOP = 56;
const MAIN_HEIGHT = 600;

interface Box {
  overflowY?: string;
  /** Rendered top and height. */
  top?: number;
  height?: number;
  /** Content height (defaults to the rendered height: nothing to scroll). */
  scrollHeight?: number;
  paddingTop?: number;
  paddingBottom?: number;
}

// A minimal HTMLElement stand-in. Stubbed as the global `HTMLElement` so that
// the `child instanceof HTMLElement` checks inside the function pass.
class FakeEl {
  overflowY: string;
  top: number;
  height: number;
  scrollHeight: number;
  paddingTop: number;
  paddingBottom: number;
  children: FakeEl[];

  constructor(box: Box = {}, children: FakeEl[] = []) {
    this.overflowY = box.overflowY ?? "visible";
    this.top = box.top ?? MAIN_TOP;
    this.height = box.height ?? 40;
    this.scrollHeight = box.scrollHeight ?? this.height;
    this.paddingTop = box.paddingTop ?? 0;
    this.paddingBottom = box.paddingBottom ?? 0;
    this.children = children;
  }

  get clientHeight() {
    return this.height;
  }

  getBoundingClientRect() {
    return { top: this.top, height: this.height };
  }
}

/** A page-level scroll box: fills <main> and scrolls vertically. */
const pageScroller = (box: Box = {}, children: FakeEl[] = []) =>
  new FakeEl({ overflowY: "auto", top: MAIN_TOP, height: MAIN_HEIGHT, scrollHeight: 2000, ...box }, children);

const makeMain = (children: FakeEl[], box: Box = {}) =>
  new FakeEl({ overflowY: "auto", top: MAIN_TOP, height: MAIN_HEIGHT, scrollHeight: 5000, ...box }, children);

function makeDom(main: FakeEl | null) {
  vi.stubGlobal("HTMLElement", FakeEl);
  vi.stubGlobal("document", {
    querySelector: (selector: string) => (selector === "main" ? main : null),
  });
  vi.stubGlobal("getComputedStyle", (el: FakeEl) => ({
    overflowY: el.overflowY,
    paddingTop: `${el.paddingTop}px`,
    paddingBottom: `${el.paddingBottom}px`,
  }));
}

describe("findScrollContainer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null on the server (no document)", () => {
    vi.stubGlobal("document", undefined);
    expect(findScrollContainer()).toBeNull();
  });

  it("returns null when there is no <main> element", () => {
    makeDom(null);
    expect(findScrollContainer()).toBeNull();
  });

  it("returns <main> itself when no scrollable descendant exists", () => {
    const main = makeMain([new FakeEl({ overflowY: "hidden" }), new FakeEl()]);
    makeDom(main);
    expect(findScrollContainer()).toBe(main);
  });

  it("returns <main> when it has no children", () => {
    const main = makeMain([]);
    makeDom(main);
    expect(findScrollContainer()).toBe(main);
  });

  it("returns a direct child that fills <main> with overflowY 'auto'", () => {
    const scroller = pageScroller();
    const main = makeMain([scroller]);
    makeDom(main);
    expect(findScrollContainer()).toBe(scroller);
  });

  it("returns a direct child that fills <main> with overflowY 'scroll'", () => {
    const scroller = pageScroller({ overflowY: "scroll" });
    const main = makeMain([scroller]);
    makeDom(main);
    expect(findScrollContainer()).toBe(scroller);
  });

  it("finds a page scroller nested up to 3 levels deep", () => {
    // <main> → <div> (depth 1) → <div> (depth 2) → <div overflow-y-auto h-full> (depth 3)
    const deepScroller = pageScroller();
    const level2 = new FakeEl({ height: MAIN_HEIGHT }, [deepScroller]);
    const level1 = new FakeEl({ height: MAIN_HEIGHT }, [level2]);
    const main = makeMain([level1]);
    makeDom(main);
    expect(findScrollContainer()).toBe(deepScroller);
  });

  it("does not descend beyond depth 3, falling back to <main>", () => {
    const tooDeep = pageScroller();
    const level3 = new FakeEl({ height: MAIN_HEIGHT }, [tooDeep]);
    const level2 = new FakeEl({ height: MAIN_HEIGHT }, [level3]);
    const level1 = new FakeEl({ height: MAIN_HEIGHT }, [level2]);
    const main = makeMain([level1]);
    makeDom(main);
    expect(findScrollContainer()).toBe(main);
  });

  describe("boxes that only scroll sideways are not the page", () => {
    // `overflow-x: auto` turns a `visible` overflow-y into a computed `auto`.
    it("a table's overflow-x wrapper, taller than <main>, is skipped", () => {
      const tableWrapper = new FakeEl({ overflowY: "auto", top: MAIN_TOP + 120, height: 12_000 });
      const main = makeMain([new FakeEl({ height: 12_200 }, [tableWrapper])]);
      makeDom(main);
      expect(findScrollContainer()).toBe(main);
    });

    it("a tab strip (overflow-x-auto, one line tall) is skipped", () => {
      const tabStrip = new FakeEl({ overflowY: "auto", top: MAIN_TOP + 24, height: 34, scrollHeight: 35 });
      const main = makeMain([new FakeEl({ height: 900 }, [tabStrip])]);
      makeDom(main);
      expect(findScrollContainer()).toBe(main);
    });

    it("a box as tall as <main> but not at its top is skipped", () => {
      const offset = new FakeEl({ overflowY: "auto", top: MAIN_TOP + 200, height: MAIN_HEIGHT });
      const main = makeMain([offset]);
      makeDom(main);
      expect(findScrollContainer()).toBe(main);
    });
  });

  it("measures against <main>'s content box (the iPhone's bottom safe-area padding)", () => {
    // pb-safe: main's padding-bottom is the home-indicator inset; an h-full
    // child is main's height less that padding.
    const scroller = pageScroller({ height: MAIN_HEIGHT - 34 });
    const main = makeMain([scroller], { paddingBottom: 34 });
    makeDom(main);
    expect(findScrollContainer()).toBe(scroller);
  });

  it("of two boxes that fill <main> (the pinned rail beside the editor), takes the one with more to scroll", () => {
    const rail = pageScroller({ scrollHeight: 700 });
    const editor = pageScroller({ scrollHeight: 3000 });
    const row = new FakeEl({ height: MAIN_HEIGHT }, [rail, editor]);
    const main = makeMain([row]);
    makeDom(main);
    expect(findScrollContainer()).toBe(editor);
  });

  it("does not look inside the page's scroll box for another", () => {
    const inner = pageScroller({ scrollHeight: 9000 });
    const outer = pageScroller({ scrollHeight: 1000 }, [inner]);
    const main = makeMain([outer]);
    makeDom(main);
    expect(findScrollContainer()).toBe(outer);
  });
});
