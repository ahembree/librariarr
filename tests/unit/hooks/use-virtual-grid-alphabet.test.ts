// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useVirtualGridAlphabet } from "@/hooks/use-virtual-grid-alphabet";

// 3 columns: row 0 = A A B, row 1 = B C 1, row 2 = D
const ITEMS = ["Alien", "Arrival", "Brazil", "Blade", "Cars", "1917", "Dune"].map((title) => ({ title }));

interface FakeVirtualizer {
  scrollToIndex: ReturnType<typeof vi.fn>;
  getVirtualItems: () => { index: number; start: number }[];
  options: { scrollMargin: number };
  scrollOffset: number | null;
}

function makeVirtualizer(rows: { index: number; start: number }[] = [], scrollOffset: number | null = 0, scrollMargin = 0) {
  const v: FakeVirtualizer = {
    scrollToIndex: vi.fn(),
    getVirtualItems: () => rows,
    options: { scrollMargin },
    scrollOffset,
  };
  return v;
}

const asV = (v: FakeVirtualizer) => v as unknown as Virtualizer<HTMLElement, Element>;

function scrollEl(clientHeight = 1000) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  return el;
}

const fire = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(16);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 16) as unknown as number,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useVirtualGridAlphabet", () => {
  it("lists available letters", () => {
    const v = makeVirtualizer();
    const { result } = renderHook(() =>
      useVirtualGridAlphabet({ items: ITEMS, columns: 3, virtualizer: asV(v), scrollElement: null }),
    );
    expect([...result.current.availableLetters].sort()).toEqual(["#", "A", "B", "C", "D"]);
  });

  it("scrolls to the row holding a letter's first item", () => {
    const v = makeVirtualizer();
    const { result, rerender } = renderHook(
      ({ columns }) => useVirtualGridAlphabet({ items: ITEMS, columns, virtualizer: asV(v), scrollElement: null }),
      { initialProps: { columns: 3 } },
    );
    act(() => result.current.scrollToLetter("C"));
    expect(v.scrollToIndex).toHaveBeenCalledWith(1, { align: "start" });
    expect(result.current.activeLetter).toBe("C");
    act(() => result.current.scrollToLetter("D"));
    expect(v.scrollToIndex).toHaveBeenLastCalledWith(2, { align: "start" });

    rerender({ columns: 2 });
    act(() => result.current.scrollToLetter("D"));
    expect(v.scrollToIndex).toHaveBeenLastCalledWith(3, { align: "start" });

    act(() => result.current.scrollToLetter("Z"));
    expect(v.scrollToIndex).toHaveBeenCalledTimes(3);
  });

  it("tracks the letter of the last row starting above 40% of the viewport", () => {
    // target = scrollOffset 500 + 1000 * 0.4 - margin 100 = 800
    const v = makeVirtualizer([{ index: 0, start: 300 }, { index: 1, start: 700 }, { index: 2, start: 900 }], 500, 100);
    const el = scrollEl();
    const { result } = renderHook(() =>
      useVirtualGridAlphabet({ items: ITEMS, columns: 3, virtualizer: asV(v), scrollElement: el }),
    );
    fire(el);
    expect(result.current.activeLetter).toBe("B");
  });

  it("treats a null scrollOffset as 0 and clears with no virtual items", () => {
    const rows = [{ index: 0, start: 0 }, { index: 2, start: 500 }];
    const v = makeVirtualizer(rows, null);
    const el = scrollEl();
    const { result } = renderHook(() =>
      useVirtualGridAlphabet({ items: ITEMS, columns: 3, virtualizer: asV(v), scrollElement: el }),
    );
    fire(el);
    expect(result.current.activeLetter).toBe("A");
    rows.length = 0;
    fire(el);
    expect(result.current.activeLetter).toBeNull();
  });

  it("ignores scrolls during a jump, then resumes after 100ms", () => {
    const v = makeVirtualizer([{ index: 0, start: 0 }]);
    const el = scrollEl();
    const { result } = renderHook(() =>
      useVirtualGridAlphabet({ items: ITEMS, columns: 3, virtualizer: asV(v), scrollElement: el }),
    );
    act(() => result.current.scrollToLetter("D"));
    fire(el);
    expect(result.current.activeLetter).toBe("D");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fire(el);
    expect(result.current.activeLetter).toBe("A");
  });

  it("does not listen when disabled and unsubscribes on unmount", () => {
    const v = makeVirtualizer([{ index: 0, start: 0 }]);
    const el = scrollEl();
    const add = vi.spyOn(el, "addEventListener");
    const remove = vi.spyOn(el, "removeEventListener");
    const disabled = renderHook(() =>
      useVirtualGridAlphabet({ items: ITEMS, columns: 3, virtualizer: asV(v), scrollElement: el, enabled: false }),
    );
    expect(add).not.toHaveBeenCalled();
    disabled.unmount();
    const enabled = renderHook(() =>
      useVirtualGridAlphabet({ items: ITEMS, columns: 3, virtualizer: asV(v), scrollElement: el }),
    );
    expect(add).toHaveBeenCalledWith("scroll", expect.any(Function), { passive: true });
    enabled.unmount();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
