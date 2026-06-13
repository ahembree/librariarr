import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { findScrollContainer } from "@/lib/scroll-utils";

/**
 * The vitest environment is "node", so there is no DOM. `findScrollContainer`
 * uses `document.querySelector`, `getComputedStyle`, iterates `el.children`,
 * and relies on `instanceof HTMLElement`. We stub all of these with a minimal
 * fake DOM so the function's BFS logic can be exercised purely in node.
 */

// A minimal HTMLElement stand-in. Stubbed as the global `HTMLElement` so that
// the `child instanceof HTMLElement` checks inside the function pass.
class FakeEl {
  overflowY: string;
  children: FakeEl[];

  constructor(overflowY = "visible", children: FakeEl[] = []) {
    this.overflowY = overflowY;
    this.children = children;
  }
}

function makeDom(main: FakeEl | null) {
  vi.stubGlobal("HTMLElement", FakeEl);
  vi.stubGlobal("document", {
    querySelector: (selector: string) => (selector === "main" ? main : null),
  });
  vi.stubGlobal("getComputedStyle", (el: FakeEl) => ({ overflowY: el.overflowY }));
}

describe("findScrollContainer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when there is no <main> element", () => {
    makeDom(null);
    expect(findScrollContainer()).toBeNull();
  });

  it("returns <main> itself when no scrollable descendant exists", () => {
    const main = new FakeEl("visible", [new FakeEl("hidden"), new FakeEl("visible")]);
    makeDom(main);
    expect(findScrollContainer()).toBe(main);
  });

  it("returns a direct child with overflowY 'auto'", () => {
    const scroller = new FakeEl("auto");
    const main = new FakeEl("visible", [new FakeEl("visible"), scroller]);
    makeDom(main);
    expect(findScrollContainer()).toBe(scroller);
  });

  it("returns a direct child with overflowY 'scroll'", () => {
    const scroller = new FakeEl("scroll");
    const main = new FakeEl("visible", [scroller]);
    makeDom(main);
    expect(findScrollContainer()).toBe(scroller);
  });

  it("finds a scrollable element nested up to 3 levels deep", () => {
    // <main> → <div> (depth 1) → <div> (depth 2) → <div overflow-y-auto> (depth 3)
    const deepScroller = new FakeEl("auto");
    const level2 = new FakeEl("visible", [deepScroller]);
    const level1 = new FakeEl("visible", [level2]);
    const main = new FakeEl("visible", [level1]);
    makeDom(main);
    expect(findScrollContainer()).toBe(deepScroller);
  });

  it("does not descend beyond depth 3, falling back to <main>", () => {
    // The scrollable element sits at depth 4, which the BFS never enqueues.
    const tooDeep = new FakeEl("auto");
    const level3 = new FakeEl("visible", [tooDeep]); // depth 3 (children not queued)
    const level2 = new FakeEl("visible", [level3]);
    const level1 = new FakeEl("visible", [level2]);
    const main = new FakeEl("visible", [level1]);
    makeDom(main);
    expect(findScrollContainer()).toBe(main);
  });

  it("returns the first scrollable element found in BFS order", () => {
    // Two scrollable elements: a shallower one (depth 1) should be found first.
    const shallow = new FakeEl("auto");
    const deepNested = new FakeEl("scroll");
    const branch = new FakeEl("visible", [deepNested]);
    const main = new FakeEl("visible", [branch, shallow]);
    makeDom(main);
    // BFS visits depth-1 children (branch, then shallow) before depth-2 (deepNested).
    expect(findScrollContainer()).toBe(shallow);
  });

  it("returns <main> when it has no children", () => {
    const main = new FakeEl("visible", []);
    makeDom(main);
    expect(findScrollContainer()).toBe(main);
  });
});
