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

  it("flush() runs a pending fire at once, and only once", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, { quietMs: 1000, maxWaitMs: 3000 });
    d.trigger();
    d.flush();
    expect(fn).toHaveBeenCalledOnce();
    // Neither the quiet window nor the max-wait timer fires it again.
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("flush() does nothing when no fire is pending", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, { quietMs: 1000 });
    d.flush();
    d.trigger();
    vi.advanceTimersByTime(1000);
    d.flush();
    expect(fn).toHaveBeenCalledOnce();
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
