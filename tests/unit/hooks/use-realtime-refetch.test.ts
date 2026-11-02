// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const realtime = vi.hoisted(() => ({
  live: true,
  callbacks: new Map<string, (data: Record<string, unknown>) => void>(),
}));
vi.mock("@/hooks/use-realtime", () => ({
  isRealtimeLive: () => realtime.live,
  useRealtimeEvents: (types: readonly string[], callback: (data: Record<string, unknown>) => void) => {
    realtime.callbacks.set(types.join(","), callback);
  },
}));

import { useRealtimeRefetch, OWN_EVENT_GRACE_MS } from "@/hooks/use-realtime-refetch";

const TYPES = ["lifecycle:action-executed"] as const;

/** Deliver an event to the hook's subscription, as the shared stream would. */
function emit(data: Record<string, unknown>) {
  realtime.callbacks.get(TYPES.join(","))?.(data);
}

const own = (data: Record<string, unknown>) => data.manual === true;

beforeEach(() => {
  realtime.live = true;
  realtime.callbacks.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useRealtimeRefetch", () => {
  it("re-reads on every event of its types", () => {
    const refetch = vi.fn();
    renderHook(() => useRealtimeRefetch(TYPES, refetch));
    act(() => emit({}));
    act(() => emit({ manual: true }));
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("skips the direct re-read when the request's own event arrived during it", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() => useRealtimeRefetch(TYPES, refetch));
    const ticket = result.current.begin();
    act(() => emit({ manual: true }));
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(() => ticket.settle({ isOwn: own }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("waits for an own event that lands just after the answer", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() => useRealtimeRefetch(TYPES, refetch));
    const ticket = result.current.begin();
    let settled = false;
    const settling = ticket.settle({ isOwn: own }).then(() => {
      settled = true;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWN_EVENT_GRACE_MS / 2);
    });
    expect(settled).toBe(false);
    act(() => emit({ manual: true }));
    await act(() => settling);
    expect(settled).toBe(true);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("re-reads by itself when the own event never comes", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() => useRealtimeRefetch(TYPES, refetch));
    const ticket = result.current.begin();
    const settling = ticket.settle({ isOwn: own });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWN_EVENT_GRACE_MS);
    });
    await act(() => settling);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not count another run's event, or a reconnect's resync, as its own", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() => useRealtimeRefetch(TYPES, refetch));
    const ticket = result.current.begin();
    // The scheduled executor's event (no meta) and a resync (`{}`).
    act(() => emit({ executed: 3, failed: 0 }));
    act(() => emit({}));
    expect(refetch).toHaveBeenCalledTimes(2);
    const settling = ticket.settle({ isOwn: own });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWN_EVENT_GRACE_MS);
    });
    await act(() => settling);
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("re-reads at once while the stream is not delivering, and when no event is expected", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() => useRealtimeRefetch(TYPES, refetch));
    realtime.live = false;
    await act(() => result.current.begin().settle({ isOwn: own }));
    expect(refetch).toHaveBeenCalledTimes(1);
    realtime.live = true;
    await act(() => result.current.begin().settle({ expectEvent: false, isOwn: own }));
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("resolves once the event's own re-read has finished", async () => {
    let finish!: () => void;
    const refetch = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useRealtimeRefetch(TYPES, refetch));
    const ticket = result.current.begin();
    act(() => emit({ manual: true }));
    let settled = false;
    const settling = ticket.settle({ isOwn: own }).then(() => {
      settled = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toBe(false);
    finish();
    await act(() => settling);
    expect(settled).toBe(true);
  });

  it("re-reads nothing for a cancelled ticket, and stops recording for it", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() => useRealtimeRefetch(TYPES, refetch));
    const ticket = result.current.begin();
    ticket.cancel();
    await act(() => ticket.settle({ isOwn: own }));
    expect(refetch).not.toHaveBeenCalled();
  });

  it("uses the latest refetch the page passed", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ refetch }) => useRealtimeRefetch(TYPES, refetch), {
      initialProps: { refetch: first },
    });
    rerender({ refetch: second });
    act(() => emit({}));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
