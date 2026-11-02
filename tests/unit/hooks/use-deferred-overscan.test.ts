// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeferredOverscan } from "@/hooks/use-deferred-overscan";

beforeEach(() => {
  vi.useFakeTimers();
  // A frame is a 16ms timer so fake timers drive it.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDeferredOverscan", () => {
  it("stays at the initial overscan until ready", () => {
    const { result } = renderHook(() => useDeferredOverscan(false));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);
  });

  it("widens to the full overscan a frame and a task after ready", () => {
    const { result, rerender } = renderHook(({ ready }) => useDeferredOverscan(ready, 5, 2), {
      initialProps: { ready: false },
    });
    expect(result.current).toBe(2);
    rerender({ ready: true });
    expect(result.current).toBe(2);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    // The frame fired, the task has not.
    expect(result.current).toBe(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(5);
  });

  it("stays widened once widened, even if ready turns false", () => {
    const { result, rerender } = renderHook(({ ready }) => useDeferredOverscan(ready), {
      initialProps: { ready: true },
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe(3);
    rerender({ ready: false });
    expect(result.current).toBe(3);
  });

  it("cancels the pending frame and task on unmount", () => {
    const { unmount } = renderHook(() => useDeferredOverscan(true));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled task when unmounted between frame and task", () => {
    const { unmount } = renderHook(() => useDeferredOverscan(true));
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
