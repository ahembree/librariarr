import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Debouncer } from "@/lib/media-server/realtime/debounce";

describe("Debouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once after the quiet window elapses", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, { quietMs: 1000 });
    d.trigger();
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("coalesces a burst of triggers into a single fire", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, { quietMs: 1000 });
    d.trigger();
    vi.advanceTimersByTime(500);
    d.trigger();
    vi.advanceTimersByTime(500);
    d.trigger();
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("honors maxWaitMs so a continuous stream cannot postpone forever", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, { quietMs: 1000, maxWaitMs: 3000 });
    // Trigger every 500ms: the quiet window never elapses on its own.
    for (let i = 0; i < 6; i++) {
      d.trigger();
      vi.advanceTimersByTime(500);
    }
    expect(fn).toHaveBeenCalledOnce();
  });

  it("cancel() prevents a pending fire", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, { quietMs: 1000 });
    d.trigger();
    d.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("can fire again after a previous fire", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, { quietMs: 1000 });
    d.trigger();
    vi.advanceTimersByTime(1000);
    d.trigger();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("flush() runs a pending fire immediately without a later double-fire", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, { quietMs: 1000 });
    d.trigger();
    d.flush();
    expect(fn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("flush() is a no-op when nothing is pending", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, { quietMs: 1000 });
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("swallows synchronous throws from the callback", () => {
    const fn = vi.fn(() => {
      throw new Error("boom");
    });
    const d = new Debouncer(fn, { quietMs: 100 });
    d.trigger();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(fn).toHaveBeenCalledOnce();
  });
});
