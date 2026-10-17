// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type React from "react";
import { renderHook, act } from "@testing-library/react";
import { useColumnResize } from "@/hooks/use-column-resize";

const KEY = "cols";
const COLUMNS = [
  { id: "title", defaultWidth: 200 },
  { id: "year", defaultWidth: 80, minWidth: 70 },
];

function mouseDownEvent(clientX: number) {
  const calls = { prevented: false, stopped: false };
  const e = {
    clientX,
    preventDefault: () => (calls.prevented = true),
    stopPropagation: () => (calls.stopped = true),
  } as unknown as React.MouseEvent;
  return { e, calls };
}

function touchStartEvent(clientX: number | null) {
  const calls = { stopped: false };
  const e = {
    touches: clientX === null ? [] : [{ clientX }],
    stopPropagation: () => (calls.stopped = true),
  } as unknown as React.TouchEvent;
  return { e, calls };
}

function mouseMove(clientX: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX }));
}

function touchEvent(type: string, clientX?: number) {
  const ev = new Event(type);
  Object.defineProperty(ev, "touches", {
    value: clientX === undefined ? [] : [{ clientX }],
  });
  document.dispatchEvent(ev);
}

function stored(): Record<string, number> | null {
  const raw = realStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}

/** The document's own storage, captured before any test stubs the global. */
const realStorage = localStorage;

/**
 * Swap the global `localStorage` for one that delegates to the real storage
 * except where overridden. A `vi.spyOn(localStorage, …)` on happy-dom's
 * Storage is not undone by `restoreAllMocks`, so a throwing spy leaked into
 * whichever test ran next; a stubbed global is undone by `unstubAllGlobals`.
 */
function stubStorage(overrides: Partial<Pick<Storage, "getItem" | "setItem">>) {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => realStorage.getItem(key),
    setItem: (key: string, value: string) => realStorage.setItem(key, value),
    removeItem: (key: string) => realStorage.removeItem(key),
    clear: () => realStorage.clear(),
    ...overrides,
  });
}

beforeEach(() => {
  realStorage.clear();
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useColumnResize", () => {
  it("starts from defaults and sums the total width", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    expect(result.current.columnWidths).toEqual({ title: 200, year: 80 });
    expect(result.current.totalWidth).toBe(280);
    expect(result.current.resizingColumnId).toBeNull();
  });

  it("restores stored widths but never below a column's own minimum", () => {
    localStorage.setItem(KEY, JSON.stringify({ title: 333, year: 10 }));
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    expect(result.current.columnWidths).toEqual({ title: 333, year: 70 });
    expect(result.current.totalWidth).toBe(403);
  });

  it("falls back to defaults when the stored value is not valid JSON", () => {
    localStorage.setItem(KEY, "{not json");
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    expect(result.current.columnWidths).toEqual({ title: 200, year: 80 });
  });

  it("drags a column with the mouse, persisting only on release", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    const { e, calls } = mouseDownEvent(100);

    act(() => result.current.getResizeProps("title").onMouseDown(e));
    expect(calls).toEqual({ prevented: true, stopped: true });
    expect(result.current.resizingColumnId).toBe("title");
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");

    act(() => mouseMove(150));
    expect(result.current.columnWidths.title).toBe(250);
    expect(result.current.totalWidth).toBe(330);
    // Not saved mid-drag.
    expect(stored()).toBeNull();

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(result.current.resizingColumnId).toBeNull();
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
    expect(stored()).toEqual({ title: 250 });

    // Listeners were removed: further moves change nothing.
    act(() => mouseMove(400));
    expect(result.current.columnWidths.title).toBe(250);
  });

  it("clamps a shrinking drag to the hook-wide minimum", () => {
    const { result } = renderHook(() =>
      useColumnResize({ columns: COLUMNS, storageKey: KEY, minWidth: 120 }),
    );
    act(() => result.current.getResizeProps("title").onMouseDown(mouseDownEvent(500).e));
    act(() => mouseMove(0));
    expect(result.current.columnWidths.title).toBe(120);
  });

  it("clamps a shrinking drag to the column's own minimum when larger", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    act(() => result.current.getResizeProps("year").onMouseDown(mouseDownEvent(500).e));
    act(() => mouseMove(0));
    // Column min 70 beats the default hook min 50.
    expect(result.current.columnWidths.year).toBe(70);
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(stored()).toEqual({ year: 70 });
  });

  it("starts an unknown column from 120px", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    act(() => result.current.getResizeProps("ghost").onMouseDown(mouseDownEvent(0).e));
    act(() => mouseMove(30));
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    // Not a configured column, so not rendered, but its drag is persisted from 120.
    expect(stored()).toEqual({ ghost: 150 });
    expect(result.current.columnWidths).toEqual({ title: 200, year: 80 });
  });

  it("drags with touch and ends on touchend", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    const { e, calls } = touchStartEvent(100);
    act(() => result.current.getResizeProps("title").onTouchStart(e));
    expect(calls.stopped).toBe(true);
    expect(result.current.resizingColumnId).toBe("title");

    act(() => touchEvent("touchmove", 160));
    expect(result.current.columnWidths.title).toBe(260);
    // A touchmove with no touch point is ignored.
    act(() => touchEvent("touchmove"));
    expect(result.current.columnWidths.title).toBe(260);

    act(() => touchEvent("touchend"));
    expect(result.current.resizingColumnId).toBeNull();
    expect(stored()).toEqual({ title: 260 });

    act(() => touchEvent("touchmove", 500));
    expect(result.current.columnWidths.title).toBe(260);
  });

  it("ends a touch drag on touchcancel", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    act(() => result.current.getResizeProps("title").onTouchStart(touchStartEvent(0).e));
    act(() => touchEvent("touchmove", 10));
    act(() => touchEvent("touchcancel"));
    expect(result.current.resizingColumnId).toBeNull();
    expect(stored()).toEqual({ title: 210 });
  });

  it("does not start a drag on a touchstart without a touch point", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    const { e, calls } = touchStartEvent(null);
    act(() => result.current.getResizeProps("title").onTouchStart(e));
    expect(calls.stopped).toBe(true);
    expect(result.current.resizingColumnId).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });

  it("ignores a second release after the drag ended", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    act(() => result.current.getResizeProps("title").onMouseDown(mouseDownEvent(0).e));
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    const setItem = vi.fn((key: string, value: string) => realStorage.setItem(key, value));
    stubStorage({ setItem });
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(setItem).not.toHaveBeenCalled();
  });

  it("ends overlapping drags cleanly, persisting the latest column", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    act(() => result.current.getResizeProps("title").onMouseDown(mouseDownEvent(0).e));
    // A second press before release takes over the drag.
    act(() => result.current.getResizeProps("year").onMouseDown(mouseDownEvent(0).e));
    expect(result.current.resizingColumnId).toBe("year");
    act(() => mouseMove(20));
    expect(result.current.columnWidths).toEqual({ title: 200, year: 100 });
    const setItem = vi.fn((key: string, value: string) => realStorage.setItem(key, value));
    stubStorage({ setItem });
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    // Both sets of listeners end, but only one save happens.
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(result.current.resizingColumnId).toBeNull();
    expect(stored()).toEqual({ year: 100 });
    act(() => mouseMove(500));
    expect(result.current.columnWidths).toEqual({ title: 200, year: 100 });
  });

  it("double-click resets a column to its default and persists it", () => {
    localStorage.setItem(KEY, JSON.stringify({ title: 400, year: 90 }));
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    act(() => result.current.getResizeProps("title").onDoubleClick());
    expect(result.current.columnWidths.title).toBe(200);
    expect(stored()).toEqual({ title: 200, year: 90 });
  });

  it("double-click on an unknown column does nothing", () => {
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    act(() => result.current.getResizeProps("ghost").onDoubleClick());
    expect(stored()).toBeNull();
    expect(result.current.columnWidths).toEqual({ title: 200, year: 80 });
  });

  it("keeps working when localStorage throws on read and write", () => {
    const getItem = vi.fn((): string | null => {
      throw new Error("blocked");
    });
    const setItem = vi.fn((): void => {
      throw new Error("quota");
    });
    stubStorage({ getItem, setItem });
    const { result } = renderHook(() => useColumnResize({ columns: COLUMNS, storageKey: KEY }));
    expect(getItem).toHaveBeenCalledWith(KEY);
    expect(result.current.columnWidths.title).toBe(200);
    act(() => result.current.getResizeProps("title").onMouseDown(mouseDownEvent(0).e));
    act(() => mouseMove(25));
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(result.current.columnWidths.title).toBe(225);
    expect(result.current.resizingColumnId).toBeNull();
    act(() => result.current.getResizeProps("title").onDoubleClick());
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(result.current.columnWidths.title).toBe(200);
  });
});
