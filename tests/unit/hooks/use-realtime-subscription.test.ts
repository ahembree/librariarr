// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * The React side of `useRealtime`: one shared EventSource per tab, delivery to
 * the right subscribers, the ref count and its 10s idle close, the resync after
 * a re-open, and the auth-expired state. The reconnect machinery itself is
 * covered by use-realtime-reconnect.test.ts.
 */

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent);
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  fail(fatal: boolean) {
    if (fatal) this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const fetchMock = vi.fn();
let useRealtime: typeof import("@/hooks/use-realtime").useRealtime;

const latest = () => FakeEventSource.instances.at(-1)!;

beforeEach(async () => {
  vi.resetModules();
  FakeEventSource.instances = [];
  fetchMock.mockReset().mockResolvedValue({ status: 200 });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  ({ useRealtime } = await import("@/hooks/use-realtime"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRealtime subscriptions", () => {
  it("shares one EventSource across subscribers and delivers parsed data by type", () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() => useRealtime("sync:completed", a));
    renderHook(() => useRealtime("server:changed", b));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toBe("/api/events/stream");

    act(() => latest().emit("sync:completed", JSON.stringify({ meta: { serverId: "s1" } })));
    expect(a).toHaveBeenCalledWith({ meta: { serverId: "s1" } });
    expect(b).not.toHaveBeenCalled();

    act(() => latest().emit("sync:completed", "{not json"));
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("calls the latest callback without resubscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useRealtime("x", cb), { initialProps: { cb: first } });
    rerender({ cb: second });
    expect(latest().listeners.get("x")!.size).toBe(1);
    act(() => latest().emit("x", "{}"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({});
  });

  it("moves the subscription when the event type changes", () => {
    const cb = vi.fn();
    const { rerender } = renderHook(({ type }) => useRealtime(type, cb), { initialProps: { type: "a" } });
    rerender({ type: "b" });
    expect(latest().listeners.get("a")?.size ?? 0).toBe(0);
    act(() => latest().emit("a", "{}"));
    act(() => latest().emit("b", '{"n":1}'));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ n: 1 });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("removes only the unmounted subscriber's handler", () => {
    const a = vi.fn();
    const b = vi.fn();
    const hookA = renderHook(() => useRealtime("evt", a));
    renderHook(() => useRealtime("evt", b));
    hookA.unmount();
    act(() => latest().emit("evt", "{}"));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("reports connected on the 'connected' event and on open, and false on an error", () => {
    const one = renderHook(() => useRealtime("e", () => {}));
    const two = renderHook(() => useRealtime("e", () => {}));
    expect(one.result.current.connected).toBe(false);
    act(() => latest().emit("connected", "{}"));
    expect(one.result.current.connected).toBe(true);
    expect(two.result.current.connected).toBe(true);
    // A non-fatal error: the browser retries by itself, no rebuild.
    act(() => latest().fail(false));
    expect(one.result.current.connected).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => latest().open());
    expect(two.result.current.connected).toBe(true);
  });

  it("starts a late subscriber with the current connected state", () => {
    renderHook(() => useRealtime("e", () => {}));
    act(() => latest().open());
    const late = renderHook(() => useRealtime("e", () => {}));
    expect(late.result.current.connected).toBe(true);
  });
});

describe("useRealtime ref count and idle close", () => {
  it("keeps the connection for 10s after the last subscriber leaves, then closes it", () => {
    const { unmount, result } = renderHook(() => useRealtime("e", () => {}));
    act(() => latest().open());
    expect(result.current.connected).toBe(true);
    const source = latest();
    unmount();
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(source.closed).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(source.closed).toBe(true);
  });

  it("reuses the live connection when a subscriber arrives within the grace period (navigation)", () => {
    const outgoing = renderHook(() => useRealtime("page-a", () => {}));
    const source = latest();
    outgoing.unmount();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    const cb = vi.fn();
    renderHook(() => useRealtime("page-b", cb));
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.closed).toBe(false);
    act(() => source.emit("page-b", "{}"));
    expect(cb).toHaveBeenCalled();
  });

  it("opens a fresh connection after the idle close, with no resync on its first open", () => {
    const first = renderHook(() => useRealtime("e", () => {}));
    act(() => latest().open());
    first.unmount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const cb = vi.fn();
    renderHook(() => useRealtime("e", cb));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => latest().open());
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("useRealtime resync and auth", () => {
  it("refetches every subscriber once after a re-open, but not on the first open", async () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() => useRealtime("a", a));
    renderHook(() => useRealtime("b", b));
    act(() => latest().open());
    expect(a).not.toHaveBeenCalled();

    // Server hard-closes; the probe says the session is fine; rebuild after 2s.
    await act(async () => latest().fail(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/events/stream", expect.objectContaining({ method: "HEAD" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    // Handlers were re-attached to the new source.
    act(() => latest().emit("a", '{"live":true}'));
    expect(a).toHaveBeenLastCalledWith({ live: true });
    a.mockClear();

    act(() => latest().open());
    expect(a).toHaveBeenCalledWith({});
    expect(b).toHaveBeenCalledWith({});
  });

  it("does not resync twice within 5s", async () => {
    const cb = vi.fn();
    renderHook(() => useRealtime("e", cb));
    act(() => latest().open());
    await act(async () => latest().fail(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    act(() => latest().open());
    expect(cb).toHaveBeenCalledTimes(1);
    await act(async () => latest().fail(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    act(() => latest().open());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("flags an expired session, retries after a minute, and clears the flag on open", async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    const { result } = renderHook(() => useRealtime("e", () => {}));
    act(() => latest().open());
    await act(async () => latest().fail(true));
    expect(result.current.authExpired).toBe(true);
    expect(result.current.connected).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => latest().open());
    expect(result.current.authExpired).toBe(false);
    expect(result.current.connected).toBe(true);
  });

  it("keeps working when EventSource cannot be constructed", () => {
    vi.stubGlobal("EventSource", function () {
      throw new Error("unavailable");
    });
    const cb = vi.fn();
    const { result, unmount } = renderHook(() => useRealtime("e", cb));
    expect(result.current).toEqual({ connected: false, authExpired: false });
    expect(() => unmount()).not.toThrow();
  });
});
