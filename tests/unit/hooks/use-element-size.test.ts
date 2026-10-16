// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useElementSize } from "@/hooks/use-element-size";

type Entry = { contentRect: { width: number; height: number } };

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public cb: (entries: Entry[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  fire(width: number, height: number) {
    this.cb([{ contentRect: { width, height } }]);
  }
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useElementSize", () => {
  it("is null until the element has been measured", () => {
    const { result } = renderHook(() => useElementSize());
    expect(result.current[1]).toBeNull();
    const el = document.createElement("div");
    act(() => result.current[0](el));
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0].observed).toEqual([el]);
    expect(result.current[1]).toBeNull();

    act(() => FakeResizeObserver.instances[0].fire(300, 200));
    expect(result.current[1]).toEqual({ width: 300, height: 200 });
  });

  it("ignores zero-sized measurements and keeps the same object for an unchanged size", () => {
    const { result } = renderHook(() => useElementSize());
    act(() => result.current[0](document.createElement("div")));
    const obs = FakeResizeObserver.instances[0];
    act(() => obs.fire(100, 50));
    const first = result.current[1];
    act(() => obs.fire(0, 50));
    expect(result.current[1]).toBe(first);
    act(() => obs.fire(100, 0));
    expect(result.current[1]).toBe(first);
    act(() => obs.fire(100, 50));
    expect(result.current[1]).toBe(first);
    act(() => obs.fire(120, 50));
    expect(result.current[1]).toEqual({ width: 120, height: 50 });
  });

  it("disconnects the previous observer on a new element and resets on detach", () => {
    const { result } = renderHook(() => useElementSize());
    act(() => result.current[0](document.createElement("div")));
    act(() => FakeResizeObserver.instances[0].fire(10, 10));
    act(() => result.current[0](document.createElement("div")));
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
    expect(FakeResizeObserver.instances).toHaveLength(2);

    act(() => result.current[0](null));
    expect(FakeResizeObserver.instances[1].disconnected).toBe(true);
    expect(result.current[1]).toBeNull();
  });

  it("returns a stable ref callback", () => {
    const { result, rerender } = renderHook(() => useElementSize());
    const ref = result.current[0];
    rerender();
    expect(result.current[0]).toBe(ref);
  });
});
