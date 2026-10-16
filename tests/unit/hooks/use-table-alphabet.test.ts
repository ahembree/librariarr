// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTableAlphabet } from "@/hooks/use-table-alphabet";

const ITEMS = [{ title: "Alien" }, { title: "Arrival" }, { title: "Blade Runner" }, { title: "12 Monkeys" }, { title: "" }, { title: "Dune" }];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 16) as unknown as number,
  );
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Rows with data-index at `top` px (relative to the viewport, container at 0). */
function virtualRows(tops: Array<[index: number, top: number]>) {
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  for (const [index, top] of tops) {
    const tr = document.createElement("tr");
    tr.dataset.index = String(index);
    tr.getBoundingClientRect = () => ({ top }) as DOMRect;
    tbody.append(tr);
  }
  table.append(tbody);
  document.body.append(table);
}

function scrollEl(scrollTop = 0, clientHeight = 1000) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  return el;
}

describe("useTableAlphabet", () => {
  it("lists the letters present, '#' for non-alpha, ignoring empty titles", () => {
    const { result } = renderHook(() => useTableAlphabet({ items: ITEMS }));
    expect([...result.current.availableLetters].sort()).toEqual(["#", "A", "B", "D"]);
    expect(result.current.activeLetter).toBeNull();
  });

  it("scrolls a virtualized table to the first item of a letter", () => {
    const scrollToIndex = vi.fn();
    const ref = { current: scrollToIndex };
    const { result } = renderHook(() => useTableAlphabet({ items: ITEMS, scrollToIndexRef: ref }));
    act(() => result.current.scrollToLetter("B"));
    expect(scrollToIndex).toHaveBeenCalledWith(2);
    expect(result.current.activeLetter).toBe("B");
    act(() => result.current.scrollToLetter("#"));
    expect(scrollToIndex).toHaveBeenLastCalledWith(3);
    act(() => result.current.scrollToLetter("Z"));
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
  });

  it("falls back to scrolling the first matching DOM row", () => {
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    const rows = ["", "Alien", "Blade Runner", "Brazil"].map((t) => {
      const tr = document.createElement("tr");
      if (t) {
        const td = document.createElement("td");
        td.textContent = `  ${t} `;
        tr.append(td);
      }
      tr.scrollIntoView = vi.fn();
      tbody.append(tr);
      return tr;
    });
    table.append(tbody);
    document.body.append(table);
    const { result } = renderHook(() => useTableAlphabet({ items: ITEMS }));
    act(() => result.current.scrollToLetter("B"));
    expect(rows[2].scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(rows[3].scrollIntoView).not.toHaveBeenCalled();
  });

  it("is inert when disabled", () => {
    const scrollToIndex = vi.fn();
    const el = scrollEl();
    const add = vi.spyOn(el, "addEventListener");
    const { result } = renderHook(() =>
      useTableAlphabet({ items: ITEMS, enabled: false, scrollToIndexRef: { current: scrollToIndex }, scrollElement: el }),
    );
    act(() => result.current.scrollToLetter("A"));
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(result.current.activeLetter).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });

  it("tracks the letter of the last row above 40% of the viewport, throttled to a frame", () => {
    // Items: 0 A, 1 A, 2 B, 3 #, 5 D. Target = 0 + 1000 * 0.4 = 400.
    virtualRows([[0, 0], [2, 300], [3, 380], [5, 450]]);
    const el = scrollEl();
    const { result } = renderHook(() => useTableAlphabet({ items: ITEMS, scrollElement: el }));
    act(() => {
      el.dispatchEvent(new Event("scroll"));
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.activeLetter).toBeNull();
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(result.current.activeLetter).toBe("#");
  });

  it("clears the letter when no virtual rows are rendered, and ignores bad indexes", () => {
    const el = scrollEl();
    const { result } = renderHook(() => useTableAlphabet({ items: ITEMS, scrollElement: el }));
    act(() => result.current.scrollToLetter("A"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      el.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(16);
    });
    expect(result.current.activeLetter).toBeNull();

    virtualRows([[99, 0]]);
    act(() => result.current.scrollToLetter("D"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      el.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(16);
    });
    // An out-of-range index yields no letter, so the previous one stays.
    expect(result.current.activeLetter).toBe("D");
  });

  it("ignores scroll events for 100ms after a jump", () => {
    virtualRows([[0, 0]]);
    const el = scrollEl();
    const { result } = renderHook(() =>
      useTableAlphabet({ items: ITEMS, scrollElement: el, scrollToIndexRef: { current: vi.fn() } }),
    );
    act(() => result.current.scrollToLetter("D"));
    act(() => {
      el.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(16);
    });
    expect(result.current.activeLetter).toBe("D");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      el.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(16);
    });
    expect(result.current.activeLetter).toBe("A");
  });

  it("removes the scroll listener on unmount", () => {
    const el = scrollEl();
    const remove = vi.spyOn(el, "removeEventListener");
    const { unmount } = renderHook(() => useTableAlphabet({ items: ITEMS, scrollElement: el }));
    unmount();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
