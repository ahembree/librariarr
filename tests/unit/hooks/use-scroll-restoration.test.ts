// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";

const KEY = "/library/series";
let main: HTMLElement;
let scrollTo: ReturnType<typeof vi.fn>;

function setScrollTop(v: number) {
  Object.defineProperty(main, "scrollTop", { value: v, configurable: true, writable: true });
}

function scroll(top: number) {
  setScrollTop(top);
  main.dispatchEvent(new Event("scroll"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 16) as unknown as number,
  );
  sessionStorage.clear();
  document.body.innerHTML = "";
  main = document.createElement("main");
  scrollTo = vi.fn();
  main.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  document.body.append(main);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stored = () => {
  const raw = sessionStorage.getItem(`scroll-${KEY}`);
  return raw ? JSON.parse(raw) : null;
};

describe("useScrollRestoration — saving", () => {
  it("saves the position 150ms after the last scroll event", () => {
    renderHook(() => useScrollRestoration(KEY, false, 120, undefined, { getFirstVisibleIndex: () => 42 }));
    scroll(300);
    act(() => vi.advanceTimersByTime(100));
    scroll(500);
    act(() => vi.advanceTimersByTime(149));
    expect(stored()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(stored()).toEqual({ scrollTop: 500, firstVisibleIndex: 42, visibleCount: 120 });
  });

  it("records -1 without an index callback and clears the entry at the top", () => {
    renderHook(() => useScrollRestoration(KEY, false));
    scroll(200);
    act(() => vi.advanceTimersByTime(150));
    expect(stored()).toEqual({ scrollTop: 200, firstVisibleIndex: -1 });
    scroll(0);
    act(() => vi.advanceTimersByTime(150));
    expect(stored()).toBeNull();
  });

  it("stops listening on unmount and drops a pending save", () => {
    const { unmount } = renderHook(() => useScrollRestoration(KEY, false));
    scroll(200);
    unmount();
    act(() => vi.advanceTimersByTime(500));
    scroll(300);
    act(() => vi.advanceTimersByTime(500));
    expect(stored()).toBeNull();
  });

  it("does nothing without a <main>", () => {
    main.remove();
    expect(() => renderHook(() => useScrollRestoration(KEY, true))).not.toThrow();
  });
});

describe("useScrollRestoration — restoring", () => {
  it("clears saved state when the user did not come back from a child page", () => {
    sessionStorage.setItem(`scroll-${KEY}`, JSON.stringify({ scrollTop: 400, firstVisibleIndex: -1 }));
    renderHook(() => useScrollRestoration(KEY, true));
    expect(stored()).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("waits for ready, then restores count, pixel position and index once", () => {
    sessionStorage.setItem(`scroll-${KEY}`, JSON.stringify({ scrollTop: 400, firstVisibleIndex: 30, visibleCount: 90 }));
    const { result: marker } = renderHook(() => useScrollRestoration(KEY, false));
    act(() => marker.current.markChildNavigation());
    expect(sessionStorage.getItem(`scroll-${KEY}-preserve`)).toBe("true");

    const setVisibleCount = vi.fn();
    const scrollToIndex = vi.fn(() => true);
    const { rerender } = renderHook(
      ({ ready }) => useScrollRestoration(KEY, ready, undefined, setVisibleCount, { scrollToIndex }),
      { initialProps: { ready: false } },
    );
    act(() => vi.advanceTimersByTime(100));
    expect(scrollTo).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(setVisibleCount).toHaveBeenCalledWith(90);
    expect(sessionStorage.getItem(`scroll-${KEY}-preserve`)).toBeNull();
    expect(stored()).toBeNull();

    act(() => vi.advanceTimersByTime(16));
    expect(scrollTo).toHaveBeenCalledWith({ top: 400, behavior: "instant" });
    expect(scrollToIndex).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(32));
    expect(scrollToIndex).toHaveBeenCalledWith(30);

    // A second ready transition does not restore again.
    rerender({ ready: false });
    rerender({ ready: true });
    act(() => vi.advanceTimersByTime(100));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("skips the index pass without a saved index and the scroll without a position", () => {
    sessionStorage.setItem(`scroll-${KEY}-preserve`, "true");
    sessionStorage.setItem(`scroll-${KEY}`, JSON.stringify({ scrollTop: 250, firstVisibleIndex: -1 }));
    const scrollToIndex = vi.fn();
    renderHook(() => useScrollRestoration(KEY, true, undefined, undefined, { scrollToIndex }));
    act(() => vi.advanceTimersByTime(100));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).not.toHaveBeenCalled();

    sessionStorage.setItem(`scroll-other-preserve`, "true");
    sessionStorage.setItem(`scroll-other`, JSON.stringify({ scrollTop: 0, firstVisibleIndex: 3, visibleCount: 0 }));
    const setVisibleCount = vi.fn();
    renderHook(() => useScrollRestoration("other", true, undefined, setVisibleCount));
    act(() => vi.advanceTimersByTime(100));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(setVisibleCount).not.toHaveBeenCalled();
  });

  it("ignores corrupt saved state and a missing entry", () => {
    sessionStorage.setItem(`scroll-${KEY}-preserve`, "true");
    sessionStorage.setItem(`scroll-${KEY}`, "{bad");
    expect(() => renderHook(() => useScrollRestoration(KEY, true))).not.toThrow();
    sessionStorage.setItem(`scroll-x-preserve`, "true");
    expect(() => renderHook(() => useScrollRestoration("x", true))).not.toThrow();
    act(() => vi.advanceTimersByTime(100));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("survives sessionStorage throwing", () => {
    const throwing = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("sessionStorage", { getItem: throwing, setItem: throwing, removeItem: throwing });
    const { result } = renderHook(() => useScrollRestoration(KEY, true));
    expect(() => result.current.markChildNavigation()).not.toThrow();
    scroll(100);
    expect(() => act(() => vi.advanceTimersByTime(150))).not.toThrow();
  });
});
