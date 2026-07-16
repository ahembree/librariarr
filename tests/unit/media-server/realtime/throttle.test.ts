import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Throttle } from "@/lib/media-server/realtime/throttle";

describe("Throttle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs immediately on the first trigger (leading edge)", () => {
    const fn = vi.fn();
    const t = new Throttle(fn, 2000);
    t.trigger();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("coalesces triggers within the interval into a single trailing run", () => {
    const fn = vi.fn();
    const t = new Throttle(fn, 2000);
    t.trigger(); // leading
    expect(fn).toHaveBeenCalledTimes(1);
    t.trigger();
    t.trigger();
    expect(fn).toHaveBeenCalledTimes(1); // throttled
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2); // one trailing run
  });

  it("runs immediately again once the interval has fully elapsed", () => {
    const fn = vi.fn();
    const t = new Throttle(fn, 2000);
    t.trigger();
    vi.advanceTimersByTime(2000);
    t.trigger(); // interval elapsed → leading again
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("bounds a sustained stream to ~one run per interval", () => {
    const fn = vi.fn();
    const t = new Throttle(fn, 2000);
    // Trigger every 500ms for 10s → 20 triggers.
    for (let i = 0; i < 20; i++) {
      t.trigger();
      vi.advanceTimersByTime(500);
    }
    // 10s / 2s interval ≈ 5-6 runs, not 20.
    expect(fn.mock.calls.length).toBeLessThanOrEqual(6);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("cancel() clears a pending trailing run", () => {
    const fn = vi.fn();
    const t = new Throttle(fn, 2000);
    t.trigger(); // leading run
    t.trigger(); // schedules trailing
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("swallows synchronous throws from the callback", () => {
    const fn = vi.fn(() => {
      throw new Error("boom");
    });
    const t = new Throttle(fn, 1000);
    expect(() => t.trigger()).not.toThrow();
    expect(fn).toHaveBeenCalledOnce();
  });
});
