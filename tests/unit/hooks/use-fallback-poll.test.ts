// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const realtime = vi.hoisted(() => ({ live: false, listeners: new Set<() => void>() }));
vi.mock("@/hooks/use-realtime", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useRealtimeLive: () =>
      useSyncExternalStore(
        (l: () => void) => {
          realtime.listeners.add(l);
          return () => realtime.listeners.delete(l);
        },
        () => realtime.live,
      ),
  };
});

import { useFallbackPoll } from "@/hooks/use-fallback-poll";

function setLive(value: boolean) {
  realtime.live = value;
  for (const l of realtime.listeners) l();
}

beforeEach(() => {
  realtime.live = false;
  realtime.listeners.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useFallbackPoll", () => {
  it("polls while pushes are not arriving, and stops while they are", () => {
    const poll = vi.fn();
    renderHook(() => useFallbackPoll(poll, 1000));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(poll).toHaveBeenCalledTimes(3);

    act(() => setLive(true));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(poll).toHaveBeenCalledTimes(3);

    // The stream drops: the fallback resumes on its own cadence.
    act(() => setLive(false));
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(poll).toHaveBeenCalledTimes(3);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("does nothing while disabled, and follows a changed interval and callback", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb, ms, enabled }) => useFallbackPoll(cb, ms, enabled),
      { initialProps: { cb: first, ms: 1000, enabled: false } },
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(first).not.toHaveBeenCalled();
    rerender({ cb: first, ms: 1000, enabled: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ cb: second, ms: 5000, enabled: true });
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(second).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("stops on unmount", () => {
    const poll = vi.fn();
    const { unmount } = renderHook(() => useFallbackPoll(poll, 1000));
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(poll).not.toHaveBeenCalled();
  });
});
