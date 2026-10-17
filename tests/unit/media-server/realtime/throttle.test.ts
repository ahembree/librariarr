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
    // One run at every 2s boundary — the leading run at 0s plus a trailing
    // run at 2, 4, 6, 8 and 10s — not one per trigger (20).
    expect(fn).toHaveBeenCalledTimes(6);
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
