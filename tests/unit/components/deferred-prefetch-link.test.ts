// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

let usePrefetchReady: typeof import("@/components/deferred-prefetch-link").usePrefetchReady;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  // Module state: ready once per tab.
  ({ usePrefetchReady } = await import("@/components/deferred-prefetch-link"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePrefetchReady", () => {
  it("holds prefetching back until the loaded page is idle", async () => {
    let idle: (() => void) | undefined;
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      idle = cb;
      return 1;
    });
    const { result } = renderHook(() => usePrefetchReady());
    expect(result.current).toBe(false);
    expect(idle).toBeDefined();
    act(() => idle!());
    expect(result.current).toBe(true);
  });

  it("waits a moment after load where there is no requestIdleCallback (Safari)", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const { result } = renderHook(() => usePrefetchReady());
    expect(result.current).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current).toBe(true);
  });

  it("stops waiting for load after a few seconds", async () => {
    // A slow image holds `load` back for as long as it takes.
    const readyState = vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
    vi.stubGlobal("requestIdleCallback", undefined);
    const { result } = renderHook(() => usePrefetchReady());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(result.current).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current).toBe(true);
    readyState.mockRestore();
  });

  it("stays allowed for the rest of the tab", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    renderHook(() => usePrefetchReady());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // A page reached by a client-side navigation prefetches at once.
    expect(renderHook(() => usePrefetchReady()).result.current).toBe(true);
  });
});
