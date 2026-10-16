// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import type React from "react";
import { renderHook, act } from "@testing-library/react";
import { usePanelResize } from "@/hooks/use-panel-resize";

const OPTS = { storageKey: "panel-w", defaultWidth: 400, minWidth: 300, maxWidth: 600 };

function mouseDown(clientX: number) {
  let prevented = false;
  let stopped = false;
  const e = {
    clientX,
    preventDefault: () => (prevented = true),
    stopPropagation: () => (stopped = true),
  } as unknown as React.MouseEvent;
  return { e, flags: () => ({ prevented, stopped }) };
}

function move(clientX: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX }));
}

beforeEach(() => {
  localStorage.clear();
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
});

describe("usePanelResize", () => {
  it("starts at the default width, or the stored one", () => {
    const { result } = renderHook(() => usePanelResize(OPTS));
    expect(result.current.width).toBe(400);
    expect(result.current.isDragging).toBe(false);
    localStorage.setItem("panel-w", "512");
    const { result: r2 } = renderHook(() => usePanelResize(OPTS));
    expect(r2.current.width).toBe(512);
  });

  it("widens when dragged left, clamps to the bounds, and persists on mouseup", () => {
    const { result } = renderHook(() => usePanelResize(OPTS));
    const down = mouseDown(1000);
    act(() => result.current.resizeHandleProps.onMouseDown(down.e));
    expect(down.flags()).toEqual({ prevented: true, stopped: true });
    expect(result.current.isDragging).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    act(() => move(900));
    expect(result.current.width).toBe(500);
    act(() => move(500));
    expect(result.current.width).toBe(600);
    act(() => move(1500));
    expect(result.current.width).toBe(300);
    act(() => move(950));
    expect(result.current.width).toBe(450);
    expect(localStorage.getItem("panel-w")).toBeNull();

    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
    expect(result.current.isDragging).toBe(false);
    expect(localStorage.getItem("panel-w")).toBe("450");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");

    // Listeners are gone after the drag ends.
    act(() => move(0));
    expect(result.current.width).toBe(450);
  });

  it("supports touch drags ending in touchend", () => {
    const { result } = renderHook(() => usePanelResize(OPTS));
    const touchStart = {
      touches: [{ clientX: 800 }],
      stopPropagation: () => {},
    } as unknown as React.TouchEvent;
    act(() => result.current.resizeHandleProps.onTouchStart(touchStart));
    expect(result.current.isDragging).toBe(true);

    const touchMove = new Event("touchmove") as Event & { touches: { clientX: number }[] };
    Object.defineProperty(touchMove, "touches", { value: [{ clientX: 760 }] });
    act(() => document.dispatchEvent(touchMove));
    expect(result.current.width).toBe(440);

    const empty = new Event("touchmove");
    Object.defineProperty(empty, "touches", { value: [] });
    act(() => document.dispatchEvent(empty));
    expect(result.current.width).toBe(440);

    act(() => document.dispatchEvent(new Event("touchend")));
    expect(result.current.isDragging).toBe(false);
    expect(localStorage.getItem("panel-w")).toBe("440");
  });

  it("ignores a touch start with no touches", () => {
    const { result } = renderHook(() => usePanelResize(OPTS));
    act(() =>
      result.current.resizeHandleProps.onTouchStart({ touches: [], stopPropagation: () => {} } as unknown as React.TouchEvent),
    );
    expect(result.current.isDragging).toBe(false);
  });

  it("double-click resets to and persists the default width", () => {
    localStorage.setItem("panel-w", "550");
    const { result } = renderHook(() => usePanelResize(OPTS));
    act(() => result.current.resizeHandleProps.onDoubleClick());
    expect(result.current.width).toBe(400);
    expect(localStorage.getItem("panel-w")).toBe("400");
  });

  it("a second mouseup after the drag ended is a no-op", () => {
    const { result } = renderHook(() => usePanelResize(OPTS));
    act(() => result.current.resizeHandleProps.onMouseDown(mouseDown(100).e));
    act(() => document.dispatchEvent(new Event("touchcancel")));
    expect(result.current.isDragging).toBe(false);
    localStorage.removeItem("panel-w");
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
    expect(localStorage.getItem("panel-w")).toBeNull();
  });
});

describe("usePanelResize stored width and unmount", () => {
  it("ignores a stored width that is not a number", () => {
    localStorage.setItem("panel-w", "abc");
    const { result } = renderHook(() => usePanelResize(OPTS));
    expect(result.current.width).toBe(400);
  });

  it("clamps a stored width to today's bounds", () => {
    localStorage.setItem("panel-w", "900");
    expect(renderHook(() => usePanelResize(OPTS)).result.current.width).toBe(600);
    localStorage.setItem("panel-w", "10");
    expect(renderHook(() => usePanelResize(OPTS)).result.current.width).toBe(300);
  });

  it("restores the page and stops listening when unmounted mid-drag", () => {
    const { result, unmount } = renderHook(() => usePanelResize(OPTS));
    act(() => result.current.resizeHandleProps.onMouseDown(mouseDown(1000).e));
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");

    unmount();
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");

    // The listeners are gone: a later mouseup stores nothing.
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 900 }));
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(localStorage.getItem("panel-w")).toBeNull();
  });

  it("does nothing on unmount when no drag is in progress", () => {
    document.body.style.cursor = "wait";
    const { result, unmount } = renderHook(() => usePanelResize(OPTS));
    act(() => result.current.resizeHandleProps.onMouseDown(mouseDown(1000).e));
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    document.body.style.cursor = "wait";
    unmount();
    expect(document.body.style.cursor).toBe("wait");
  });
});
