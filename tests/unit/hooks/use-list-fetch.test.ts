// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useListFetch } from "@/hooks/use-list-fetch";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const flushMicrotasks = () => act(async () => {
  await Promise.resolve();
});

describe("useListFetch", () => {
  it("runs the first fetch in a microtask, not after the debounce", async () => {
    const fetchList = vi.fn();
    renderHook(() => useListFetch(fetchList));
    // Nothing synchronously inside the effect.
    expect(fetchList).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(fetchList).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetchList).toHaveBeenCalledTimes(1);
  });

  it("debounces later changes, collapsing a burst into one fetch of the latest", async () => {
    const first = vi.fn();
    const { rerender } = renderHook(({ fn }) => useListFetch(fn), { initialProps: { fn: first } });
    await flushMicrotasks();
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    const third = vi.fn();
    rerender({ fn: second });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ fn: third });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it("honours a custom debounce of 0", async () => {
    const first = vi.fn();
    const { rerender } = renderHook(({ fn }) => useListFetch(fn, 0), { initialProps: { fn: first } });
    await flushMicrotasks();
    const next = vi.fn();
    rerender({ fn: next });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not fetch if unmounted before the microtask runs", async () => {
    const fetchList = vi.fn();
    const { unmount } = renderHook(() => useListFetch(fetchList));
    unmount();
    await flushMicrotasks();
    expect(fetchList).not.toHaveBeenCalled();
  });

  it("cancels a pending debounced fetch on unmount", async () => {
    const first = vi.fn();
    const { rerender, unmount } = renderHook(({ fn }) => useListFetch(fn), { initialProps: { fn: first } });
    await flushMicrotasks();
    const next = vi.fn();
    rerender({ fn: next });
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("fetches exactly once on a Strict Mode mount", async () => {
    const fetchList = vi.fn();
    // `reactStrictMode` makes StrictMode the root, so the effect really runs,
    // cleans up and runs again; a <StrictMode> passed as `wrapper` sits under
    // the root and does not double-invoke effects.
    renderHook(() => useListFetch(fetchList), { reactStrictMode: true });
    await flushMicrotasks();
    // In the microtask, not after a debounce the second effect run started.
    expect(fetchList).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetchList).toHaveBeenCalledTimes(1);
  });
});
